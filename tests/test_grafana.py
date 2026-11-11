"""Grafana: дерево тегов и скриптов, значения и дашборды из раскладки «Графиков»."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from test_scripts import fill

from app import grafana
from app.main import create_app

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
FORM = {"Content-Type": "application/x-www-form-urlencoded"}


@pytest.mark.parametrize("text, expected", [
    ("now", NOW),
    ("-1h", NOW - timedelta(hours=1)),
    ("-5min", NOW - timedelta(minutes=5)),
    ("-2d", NOW - timedelta(days=2)),
    ("-1mon", NOW - timedelta(days=30)),
    (str(NOW.timestamp() - 60), NOW - timedelta(seconds=60)),
])
def test_moment_understands_grafana_time(text, expected):
    assert grafana.moment(text, NOW) == expected


def test_moment_rejects_nonsense():
    with pytest.raises(grafana.GrafanaError, match="не понял время"):
        grafana.moment("вчера", NOW)


def test_names_fit_a_graphite_path():
    assert grafana.node("Пики температуры, смеситель") == "Пики_температуры_смеситель"
    assert grafana.tag_path("Line1.Mixer Temp.PV") == "Line1.Mixer_Temp.PV"
    nodes = grafana.script_nodes([{"script_id": 2, "name": "А Б"}, {"script_id": 7, "name": "А_Б"}])
    assert sorted(nodes) == ["А_Б", "А_Б_7"]


def test_patterns():
    assert grafana._split("Теги.{a.b,c}.d") == ["Теги", "{a.b,c}", "d"]
    assert grafana._match(["Теги", "*temp*"], "Теги.Line1_Temp")
    assert grafana._match(["Теги", "{x,Line1_Temp}"], "Теги.Line1_Temp")
    assert not grafana._match(["Теги", "x"], "Теги.Line1_Temp")
    assert not grafana._match(["Теги"], "Теги.Line1_Temp")


def render(client, *targets, start="-1h", points=200):
    return client.post("/graphite/render", data={
        "target": list(targets), "from": start, "until": "now", "format": "json",
        "maxDataPoints": points})


@pytest.mark.asyncio
async def test_numeric_scripts_render_without_a_database(monkeypatch):
    class DB:
        async def list_tags(self, *args, **kwargs):
            return []

        async def list_scripts(self):
            return [{"script_id": 1, "name": "Вес", "code":
                     'w = samples("W")\nd = w - 28\n'
                     'show(cumsum(d), "накоплено")\n'
                     'stat(sum(d), "баланс", "кг")\nstat(last(samples("Empty")), "нет")'}]

        async def raw_values(self, names, start, end, limit):
            return {"W": {"name": "W", "unit": "кг", "datatype": "float64",
                           "t": [start.timestamp(), start.timestamp() + 10], "v": [28.5, 27.8],
                           "end": end.timestamp(), "too_many": False},
                    "Empty": {"name": "Empty", "unit": "", "datatype": "float64", "t": [],
                              "v": [], "end": end.timestamp(), "too_many": False}}

    async def catalog(_db):
        return {"Скрипты.Вес": {"script": (await _db.list_scripts())[0]}}

    monkeypatch.setattr(grafana, "_catalog", catalog)
    monkeypatch.setattr(grafana, "_cache", {})
    db = DB()
    end = NOW.timestamp()
    result = await grafana.render(db, ['aliasSub(Скрипты.Вес, "(^.*$)", "\\1 A")'],
                                  str(end - 3600), str(end), 2)
    assert [r["target"] for r in result] == ["Вес: накоплено A", "Вес: баланс A", "Вес: нет A"]
    assert result[1]["datapoints"] == [[pytest.approx(0.3), end]]
    assert result[1]["unit"] == "кг"
    assert result[2]["datapoints"] == [[None, end]]
    assert result[0]["datapoints"][-1][0] == pytest.approx(0.3)
    # Число и накопление не зависят от количества точек для отрисовки.
    other = await grafana.render(db, ["Скрипты.Вес"], str(end - 3600), str(end), 2000)
    assert other[1]["datapoints"] == result[1]["datapoints"]


def test_stat_panel_exports_last_value_and_no_sparkline():
    panel = grafana._panel(1, {"items": ["s:1"], "type": "stat", "title": "Итого"},
                           0, {"s:1": "Скрипты.Вес"})
    assert panel["type"] == "stat"
    assert panel["targets"][0]["target"] == "Скрипты.Вес"
    assert panel["options"]["reduceOptions"]["calcs"] == ["lastNotNull"]
    assert panel["options"]["graphMode"] == "none"
    with pytest.raises(grafana.GrafanaError, match="тип панели"):
        grafana._panel(1, {"items": [], "type": "unknown"}, 0, {})


@pytest.mark.asyncio
async def test_fixed_period_cache_does_not_merge_nearby_boundaries(monkeypatch):
    calls = []

    async def calculate(db, code, start, end, **kwargs):
        calls.append(start)
        return {"outputs": [], "metrics": [], "text": []}

    monkeypatch.setattr(grafana.scripts, "run", calculate)
    monkeypatch.setattr(grafana, "_cache", {})
    db = object()
    script = {"name": "Итого", "code": "stat(1)"}
    await grafana._run_script(db, script, NOW - timedelta(hours=1), NOW, 100)
    await grafana._run_script(db, script, NOW - timedelta(hours=1), NOW, 100)
    await grafana._run_script(db, script, NOW - timedelta(hours=1, seconds=1), NOW, 100)
    assert len(calls) == 2


def make_app(settings, tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    asyncio.run(fill(settings, now))
    return create_app(replace(settings, dashboards_dir=str(tmp_path / "boards")))


def test_tree_and_values(test_settings, tmp_path):
    with TestClient(make_app(test_settings, tmp_path)) as client:
        code = 't = tag("Line1_Temp")\nshow(hold(peaks(t, level=90)), "держим")\nshow(peaks(t, level=90), "пики")'
        made = client.post("/api/scripts", json={"name": "Пики и ступени", "code": code}).json()
        assert client.get("/api/scripts").json()["items"][0]["node"] == "Пики_и_ступени"

        def find(query):
            return client.get("/graphite/metrics/find", params={"query": query}).json()
        assert [x["text"] for x in find("*")] == ["Скрипты", "Теги"]
        assert all(x["expandable"] == 1 for x in find("*"))
        names = [x["text"] for x in find("Теги.*")]
        assert "Line1_Temp" in names and "Line1_Run" in names
        assert "Line1_Recipe" not in names          # строковый тег не нарисовать
        assert [x["text"] for x in find("Теги.*TEMP*")] == ["Line1_Temp"]
        leaf = find("Скрипты.*")[0]
        assert leaf["text"] == "Пики_и_ступени" and leaf["leaf"] == 1
        # Запрос редактора приходит и как POST
        posted = client.post("/graphite/metrics/find", data={"query": "*"}, headers=FORM).json()
        assert [x["text"] for x in posted] == ["Скрипты", "Теги"]

        # Grafana оборачивает запрос и по приписке к имени узнаёт, какой он
        wrapped = render(client, 'aliasSub(Теги.Line1_Temp, "(^.*$)", "\\1 A")',
                         'aliasSub(Скрипты.Пики_и_ступени, "(^.*$)", "\\1 B")').json()
        by_name = {s["target"]: s for s in wrapped}
        assert sorted(by_name) == ["Line1_Temp A", "Пики и ступени: держим B", "Пики и ступени: пики B"]
        assert by_name["Line1_Temp A"]["unit"] == "°C" and by_name["Line1_Temp A"]["datapoints"]
        points = by_name["Пики и ступени: пики B"]["datapoints"]
        assert [p[0] for p in points] == [95.0, 95.0]
        held = by_name["Пики и ступени: держим B"]["datapoints"]
        assert len(held) == 3 and held[-1][0] == 95.0 and held[-1][1] > points[-1][1]

        many = render(client, "Теги.{Line1_Temp,Line1_Run}").json()
        assert sorted(s["target"] for s in many) == ["Line1_Run", "Line1_Temp"]
        flag = next(s for s in many if s["target"] == "Line1_Run")
        assert {p[0] for p in flag["datapoints"]} <= {0.0, 1.0}

        assert render(client, "Теги.Нет_такого").json() == []
        assert render(client, "Скрипты.").json() == []
        check = render(client, 'aliasSub(constantLine(100), "(^.*$)", "\\1 A")').json()
        assert check[0]["target"] == "constantLine(100) A"

        foreign = render(client, "sumSeries(Теги.*)")
        assert foreign.status_code == 400 and "странице «Скрипты»" in foreign.json()["message"]
        assert render(client, "Теги.*", start="вчера").status_code == 400

        client.put(f"/api/scripts/{made['script_id']}", json={"name": "Пики и ступени",
                                                              "code": 'tag("Нет")'})
        broken = render(client, "Скрипты.Пики_и_ступени")
        assert broken.status_code == 400
        assert "скрипт «Пики и ступени», строка 1" in broken.json()["message"]

        assert client.get("/graphite/functions").json() == {}
        assert client.get("/graphite/tags/autoComplete/tags").json() == []


def test_script_cache_keeps_windows_apart(test_settings, tmp_path, monkeypatch):
    calls = []
    real = grafana.scripts.run

    async def counted(*args, **kwargs):
        calls.append(args[2])
        return await real(*args, **kwargs)

    monkeypatch.setattr(grafana.scripts, "run", counted)
    with TestClient(make_app(test_settings, tmp_path)) as client:
        client.post("/api/scripts", json={"name": "Кэш", "code": 'show(tag("Line1_Temp"), "кэш")'})
        assert render(client, "Скрипты.Кэш", start="-6h").status_code == 200
        assert render(client, "Скрипты.Кэш", start="-6h").status_code == 200
        assert len(calls) == 1                      # обновление панели не считает заново
        # То же окно по длине, но другое по времени: это уже другие данные
        end = datetime.now(timezone.utc) - timedelta(hours=3)
        old = client.post("/graphite/render", data={
            "target": "Скрипты.Кэш", "from": str((end - timedelta(hours=6)).timestamp()),
            "until": str(end.timestamp()), "maxDataPoints": 200})
        assert old.status_code == 200 and len(calls) == 2


def test_dashboard_from_charts_page(test_settings, tmp_path):
    with TestClient(make_app(test_settings, tmp_path)) as client:
        made = client.post("/api/scripts", json={"name": "Скрипт", "code": 'show(tag("Line1_Temp"))'})
        script = made.json()["script_id"]
        tags = {t["name"]: t["tag_id"] for t in client.get("/api/tags").json()["items"]}
        body = {"title": "Смена  1", "span": {"range": "6h"}, "panels": [
            {"title": "Температура", "items": [f"t:{tags['Line1_Temp']}", f"t:{tags['Line1_Run']}"],
             "series": [{"name": "Line1_Temp", "draw": "line", "width": 2.6, "fill": True,
                         "color": "#c0392b"},
                        {"name": "Line1_Run", "draw": "steps", "bool": True}]},
            {"items": [f"s:{script}", "t:999999"], "height": "high",
             "series": [{"name": "Скрипт: Line1_Temp", "draw": "points"}]},
        ]}
        saved = client.post("/api/dashboards", json=body).json()
        assert saved["title"] == "Смена 1" and saved["replaced"] is False
        assert saved["path"] == f"/d/{saved['uid']}/"
        file = tmp_path / "boards" / f"{saved['uid']}.json"
        board = json.loads(file.read_text(encoding="utf-8"))
        assert board["time"] == {"from": "now-6h", "to": "now"}
        first, second = board["panels"]
        assert [t["target"] for t in first["targets"]] == ["Теги.Line1_Temp", "Теги.Line1_Run"]
        assert first["title"] == "Температура" and second["title"] == "График 2"
        # Тег, которого нет в базе, не ломает дашборд
        assert [t["target"] for t in second["targets"]] == ["Скрипты.Скрипт"]
        assert second["gridPos"]["y"] == first["gridPos"]["h"]
        assert second["gridPos"]["h"] > first["gridPos"]["h"]

        def props(panel, k):
            rule = panel["fieldConfig"]["overrides"][k]
            return rule["matcher"]["options"], {p["id"]: p["value"] for p in rule["properties"]}
        name, line = props(first, 0)
        assert name == "Line1_Temp" and line["custom.lineInterpolation"] == "linear"
        assert line["custom.lineWidth"] == 2.6 and line["custom.fillOpacity"] > 0
        assert line["color"]["fixedColor"] == "#c0392b"
        _, flag = props(first, 1)
        assert flag["custom.lineInterpolation"] == "stepAfter" and flag["max"] == 1.1
        _, dots = props(second, 0)
        assert dots["custom.drawStyle"] == "points" and dots["custom.showPoints"] == "always"

        again = client.post("/api/dashboards", json={**body, "title": "смена 1",
            "span": {"range": "custom", "from": 1793500000, "to": 1793503600}}).json()
        assert again["uid"] == saved["uid"] and again["replaced"] is True
        board = json.loads(file.read_text(encoding="utf-8"))
        assert board["time"]["from"].startswith("2026-")
        assert [d["uid"] for d in client.get("/api/dashboards").json()["items"]] == [saved["uid"]]

        assert client.post("/api/dashboards", json={**body, "title": " "}).status_code == 400
        assert client.post("/api/dashboards", json={**body, "title": "я" * 101}).status_code == 400
        empty = client.post("/api/dashboards", json={"title": "Пусто", "panels": [{"items": []}]})
        assert empty.status_code == 400 and "сохранять нечего" in empty.json()["detail"]

        assert client.delete(f"/api/dashboards/{saved['uid']}").json() == {"ok": True}
        assert not file.exists()
        assert client.delete(f"/api/dashboards/{saved['uid']}").status_code == 404
        # Имя файла берётся только из проверенного номера: выйти из папки нельзя
        assert client.delete("/api/dashboards/..%2F..%2Fapp").status_code in (404, 405)
        assert client.get("/api/dashboards").json() == {"items": []}
