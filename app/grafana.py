"""Grafana: теги и скрипты без SQL.

Grafana умеет брать данные у источника «Graphite» без плагинов, а значит и без
интернета. Приложение отвечает ей на те же запросы: дерево «Теги» и «Скрипты» и
значения за период панели. Так теги выбираются в Grafana из списка, а скрипты
считаются тем же кодом и за тот же период, что и на странице «Скрипты».

Здесь же сборка дашборда из раскладки страницы «Графики». Дашборд ложится файлом в
папку, за которой следит Grafana: пароль администратора приложению не нужен.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import scripts

TAGS = "Теги"
SCRIPTS = "Скрипты"
DATASOURCE = {"type": "graphite", "uid": "historian-app"}
MAX_SERIES = 40                # рядов в ответе на один запрос
CACHE_SECONDS = 30.0           # скрипт за то же окно пересчитывается не чаще
CACHE_SIZE = 64
MAX_DASHBOARDS = 200

_UNSAFE = re.compile(r"[^\w-]+")
_RELATIVE = re.compile(r"^-(\d+)\s*(s|sec|min|h|d|w|mon|y)[a-z]*$", re.I)
_SPANS = {"s": 1, "sec": 1, "min": 60, "h": 3600, "d": 86400, "w": 7 * 86400,
          "mon": 30 * 86400, "y": 365 * 86400}
_CONSTANT = re.compile(r"^constantLine\(\s*(-?\d+(?:\.\d+)?)\s*\)$")
_ALIASED = re.compile(r'^aliasSub\((.*),\s*"\(\^\.\*\$\)",\s*"\\1 (\S+)"\)$', re.S)


class GrafanaError(Exception):
    """Ошибка запроса: Grafana покажет её текст на панели."""


# ---------------------------------------------------------------------------
#  Имена: в запросе Graphite части пути разделены точками, а пробелы недопустимы
# ---------------------------------------------------------------------------
def node(text: str) -> str:
    """Часть пути из имени скрипта или части имени тега."""
    return _UNSAFE.sub("_", text.strip()).strip("_") or "_"


def script_nodes(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """{часть пути: скрипт}. Скрипты с совпавшими путями различаются номером."""
    out: dict[str, dict[str, Any]] = {}
    for item in sorted(items, key=lambda s: s["script_id"]):
        name = node(item["name"])
        out[name if name not in out else f"{name}_{item['script_id']}"] = item
    return out


def tag_path(name: str) -> str:
    """Точки в имени тега становятся папками: Line1.Mixer.Temp → Line1 / Mixer / Temp."""
    return ".".join(node(part) for part in name.split("."))


def _glob(pattern: str) -> re.Pattern:
    """Шаблон Graphite для одной части пути: * ? и {a,b}, регистр не важен."""
    out = ""
    depth = 0
    for ch in pattern:
        if ch == "*":
            out += r"[^.]*"
        elif ch == "?":
            out += r"[^.]"
        elif ch == "{":
            out += "(?:"
            depth += 1
        elif ch == "}" and depth:
            out += ")"
            depth -= 1
        elif ch == "," and depth:
            out += "|"
        else:
            out += re.escape(ch)
    return re.compile(out + ")" * depth + "$", re.I)


def _split(path: str) -> list[str]:
    """Части пути; точка внутри {a.b,c} части не разделяет."""
    parts = [""]
    depth = 0
    for ch in path:
        if ch == "." and not depth:
            parts.append("")
            continue
        depth += (ch == "{") - (ch == "}")
        parts[-1] += ch
    return parts


def _match(parts: list[str], path: str) -> bool:
    words = path.split(".")
    return len(parts) == len(words) and all(_glob(p).match(w) for p, w in zip(parts, words))


async def _catalog(db) -> dict[str, dict[str, Any]]:
    """Все листья дерева: {полный путь: что это}."""
    out: dict[str, dict[str, Any]] = {}
    for tag in await db.chart_tags():
        out.setdefault(f"{TAGS}.{tag_path(tag['name'])}", {"tag": tag})
    for name, item in script_nodes(await db.list_scripts()).items():
        out[f"{SCRIPTS}.{name}"] = {"script": item}
    return out


async def find(db, query: str) -> list[dict[str, Any]]:
    """Следующий уровень дерева для списка в редакторе запроса Grafana."""
    parts = _split(query.strip() or "*")
    level = len(parts)
    seen: dict[tuple[str, bool], dict[str, Any]] = {}
    for root in (TAGS, SCRIPTS):
        if level == 1 and _glob(parts[0]).match(root):
            seen[(root, True)] = {"text": root, "id": root, "expandable": 1, "leaf": 0,
                                  "allowChildren": 1}
    for path in await _catalog(db):
        words = path.split(".")
        if len(words) < level or not _match(parts, ".".join(words[:level])):
            continue
        leaf = len(words) == level
        key = (words[level - 1], not leaf)
        if key not in seen:
            seen[key] = {"text": words[level - 1], "id": ".".join(words[:level]),
                         "expandable": 0 if leaf else 1, "leaf": 1 if leaf else 0,
                         "allowChildren": 0 if leaf else 1}
    return sorted(seen.values(), key=lambda x: (x["leaf"], x["text"].lower()))


# ---------------------------------------------------------------------------
#  Значения
# ---------------------------------------------------------------------------
def moment(text: str | None, now: datetime) -> datetime:
    """Время из запроса Grafana: now, -1h, -5min, -2d или секунды Unix."""
    value = (text or "now").strip()
    if value == "now":
        return now
    found = _RELATIVE.match(value)
    if found:
        return now - timedelta(seconds=int(found.group(1)) * _SPANS[found.group(2).lower()])
    try:
        return datetime.fromtimestamp(float(value), timezone.utc)
    except ValueError:
        raise GrafanaError(f"не понял время {value!r}") from None


_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}


async def _run_script(db, item: dict[str, Any], t0: datetime, t1: datetime,
                      points: int, *, rolling: bool = False) -> dict[str, Any]:
    """Панели обновляются каждые несколько секунд, а на длинном периоде скрипт считается
    заметное время: одно и то же окно считаем не чаще раза в CACHE_SECONDS."""
    # Окно «последний час» сдвигается при каждом обновлении: близкие концы считаем одним окном,
    # а окно той же длины в другом месте даёт другой ключ
    window = ((t1 - t0).total_seconds(), t1.timestamp() // CACHE_SECONDS) if rolling else (
        t0.timestamp(), t1.timestamp())
    key = (db, item["code"], points, rolling, *window)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        result = await scripts.run(db, item["code"], t0, t1, points=points)
    except scripts.ScriptError as exc:
        raise GrafanaError(f"скрипт «{item['name']}», {exc}") from None
    for old in [k for k, v in _cache.items() if now - v[0] >= CACHE_SECONDS]:
        del _cache[old]
    if len(_cache) < CACHE_SIZE:
        _cache[key] = (now, result)
    return result


async def render(db, targets: list[str], start: str | None, until: str | None,
                 points: int) -> list[dict[str, Any]]:
    """Ответ в формате Graphite: [{target, datapoints: [[значение, секунды], …]}, …]."""
    now = datetime.now(timezone.utc)
    t0, t1 = moment(start, now), moment(until, now)
    rolling = (until is None or until.strip().lower() == "now") and bool(
        start and _RELATIVE.fullmatch(start.strip()))
    if t0 >= t1:
        raise GrafanaError("начало периода должно быть раньше конца")
    if t1 - t0 > timedelta(days=400):
        raise GrafanaError("период больше 400 дней")
    points = min(max(points, 10), 5000)
    catalog = await _catalog(db)
    out: list[dict[str, Any]] = []
    tags: dict[int, dict[str, Any]] = {}
    picked: list[tuple[dict[str, Any], str]] = []
    for target in targets:
        # Grafana оборачивает каждый запрос: по этой приписке к имени ряда она узнаёт запрос
        wrapped = _ALIASED.match(target.strip())
        text, suffix = (wrapped.group(1).strip(), f" {wrapped.group(2)}") if wrapped \
            else (target.strip(), "")
        constant = _CONSTANT.match(text)
        if constant:
            # Этим запросом Grafana проверяет источник данных кнопкой «Save & test»
            value = float(constant.group(1))
            out.append({"target": text + suffix, "datapoints": [[value, t0.timestamp()],
                                                                [value, t1.timestamp()]]})
            continue
        if "(" in text:
            raise GrafanaError("функции Graphite здесь не работают: выберите тег или скрипт из "
                               "списка, а расчёт напишите на странице «Скрипты» приложения")
        parts = _split(text)
        for path, entry in catalog.items():
            if _match(parts, path):
                picked.append((entry, suffix))
                if "tag" in entry:
                    tags[entry["tag"]["tag_id"]] = entry["tag"]
    if len(picked) > MAX_SERIES:
        raise GrafanaError(f"запрос выбрал {len(picked)} рядов, в одном запросе не больше "
                           f"{MAX_SERIES}. Уточните его")
    values = await db.series(list(tags.values()), t0, t1, points) if tags else {}
    for entry, suffix in picked:
        if "tag" in entry:
            tag = entry["tag"]
            # Дискретные теги: последнее значение на шаге, а не среднее
            column = 4 if tag["datatype"] == "bool" else 1
            out.append({"target": tag["name"] + suffix, "unit": tag["unit"] or None, "datapoints": [
                [p[column], p[0]] for p in values[tag["tag_id"]]["points"]]})
            continue
        item = entry["script"]
        result = await _run_script(db, item, t0, t1, points, rolling=rolling)
        for series in result["outputs"]:
            out.append({"target": f"{item['name']}: {series['name']}{suffix}",
                        "unit": series["unit"],
                        "datapoints": [[v, t] for t, v in zip(series["t"], series["v"])]})
        # Один отсчёт представляет показатель за всё запрошенное окно. Stat в Grafana
        # берёт Last, поэтому сумма периода не суммируется повторно по точкам.
        for metric in result.get("metrics", []):
            out.append({"target": f"{item['name']}: {metric['name']}{suffix}",
                        "unit": metric["unit"],
                        "datapoints": [[metric["value"], t1.timestamp()]]})
    return out


# ---------------------------------------------------------------------------
#  Дашборд из раскладки страницы «Графики»
# ---------------------------------------------------------------------------
def _overrides(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Вид рядов как на странице: ступени, линия или точки, толщина, цвет, заливка."""
    out = []
    for s in series:
        draw = s.get("draw") or "steps"
        props: list[dict[str, Any]] = [
            {"id": "custom.drawStyle", "value": "points" if draw == "points" else "line"},
            {"id": "custom.lineInterpolation",
             "value": "stepAfter" if draw == "steps" else "linear"},
            {"id": "custom.showPoints", "value": "always" if draw == "points" else "never"},
            {"id": "custom.lineWidth", "value": s.get("width") or 1.6},
            {"id": "custom.fillOpacity", "value": 18 if s.get("fill") else 0},
        ]
        if draw == "points":
            props.append({"id": "custom.pointSize", "value": 8})
        if s.get("color"):
            props.append({"id": "color", "value": {"mode": "fixed", "fixedColor": s["color"]}})
        if s.get("bool"):
            # Своя шкала 0–1: иначе дискретный тег прижмётся к оси соседнего ряда
            props += [{"id": "min", "value": -0.1}, {"id": "max", "value": 1.1},
                      {"id": "decimals", "value": 0}]
        out.append({"matcher": {"id": "byName", "options": s["name"]}, "properties": props})
    return out


def _panel(number: int, spec: dict[str, Any], y: int, catalog: dict[str, str]) -> dict[str, Any]:
    mode = spec.get("type", "timeseries")
    if mode not in ("timeseries", "stat"):
        raise GrafanaError("тип панели — timeseries или stat")
    targets = []
    for k, item in enumerate(spec["items"]):
        path = catalog.get(item)
        if path:
            targets.append({"refId": chr(65 + k), "target": path, "datasource": DATASOURCE})
    height = {"low": 7, "high": 14}.get(spec.get("height"), 10)
    panel = {
        "id": number, "type": "timeseries", "title": spec.get("title") or f"График {number}",
        "datasource": DATASOURCE, "targets": targets,
        "gridPos": {"x": 0, "y": y, "w": 24, "h": height},
        "fieldConfig": {
            "defaults": {"color": {"mode": "palette-classic"},
                         "custom": {"drawStyle": "line", "lineInterpolation": "stepAfter",
                                    "lineWidth": 1.6, "fillOpacity": 0, "showPoints": "never",
                                    "spanNulls": True}},
            "overrides": _overrides(spec.get("series") or []),
        },
        "options": {"legend": {"displayMode": "table", "placement": "bottom", "showLegend": True,
                               "calcs": ["lastNotNull", "min", "max", "mean"]},
                    "tooltip": {"mode": "multi", "sort": "none"}},
    }
    if mode == "stat":
        panel["type"] = "stat"
        panel["fieldConfig"] = {"defaults": {"noValue": "Нет данных"}, "overrides": []}
        panel["options"] = {
            "reduceOptions": {"values": False, "calcs": ["lastNotNull"], "fields": ""},
            "orientation": "auto", "textMode": "value_and_name", "colorMode": "value",
            "graphMode": "none", "justifyMode": "auto",
        }
    return panel


async def build_dashboard(db, title: str, panels: list[dict[str, Any]],
                          span: dict[str, Any]) -> dict[str, Any]:
    """panels: [{title, height, items: ['t:12', 's:3'], series: [вид рядов]}]."""
    catalog: dict[str, str] = {}
    for path, entry in (await _catalog(db)).items():
        if "tag" in entry:
            catalog.setdefault(f"t:{entry['tag']['tag_id']}", path)
        else:
            catalog[f"s:{entry['script']['script_id']}"] = path
    built = []
    y = 0
    for i, spec in enumerate(panels):
        panel = _panel(i + 1, spec, y, catalog)
        if panel["targets"]:
            built.append(panel)
            y += panel["gridPos"]["h"]
    if not built:
        raise GrafanaError("на графиках нет ни тегов, ни скриптов — сохранять нечего")
    if span.get("range") == "custom":
        moments = [datetime.fromtimestamp(float(span[k]), timezone.utc).isoformat()
                   for k in ("from", "to")]
        window = {"from": moments[0], "to": moments[1]}
    else:
        window = {"from": f"now-{span.get('range') or '1h'}", "to": "now"}
    return {"uid": dashboard_uid(title), "title": title, "tags": ["historian2grafana"],
            "timezone": "browser", "schemaVersion": 39, "editable": True, "graphTooltip": 1,
            "refresh": "10s", "time": window, "panels": built, "templating": {"list": []},
            "annotations": {"list": []}}


def dashboard_uid(title: str) -> str:
    """Одно название — один дашборд: сохранение под тем же именем заменяет его."""
    return "h2g-" + hashlib.sha1(title.casefold().encode("utf-8")).hexdigest()[:16]


def saved_dashboards(folder: Path) -> list[dict[str, str]]:
    out = []
    for file in folder.glob("h2g-*.json") if folder.is_dir() else []:
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
            out.append({"uid": data["uid"], "title": data["title"]})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(out, key=lambda d: d["title"].lower())


def save_dashboard(folder: Path, dashboard: dict[str, Any]) -> bool:
    """Записать файл дашборда. Вернёт True, если такой уже был и заменён."""
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / f"{dashboard['uid']}.json"
    existed = file.exists()
    if not existed and len(list(folder.glob("h2g-*.json"))) >= MAX_DASHBOARDS:
        raise GrafanaError(f"сохранено уже {MAX_DASHBOARDS} дашбордов, удалите ненужные")
    # Сначала во временный файл: Grafana следит за папкой и не должна увидеть половину
    temp = folder / f"{dashboard['uid']}.tmp"
    temp.write_text(json.dumps(dashboard, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(file)
    return existed


def delete_dashboard(folder: Path, uid: str) -> bool:
    if not re.fullmatch(r"h2g-[0-9a-f]{16}", uid):
        return False
    file = folder / f"{uid}.json"
    if not file.exists():
        return False
    file.unlink()
    return True
