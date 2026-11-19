"""Веб-приложение: страницы в браузере и API для них."""

from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import asyncpg
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, grafana, scripts
from .config import Settings
from .db import Database
from .historian import DEFAULTS, HistorianError, check, normalize
from .sync import Copier

log = logging.getLogger("app")

WEB = Path(__file__).resolve().parent.parent / "web"
SETTING_KEY = "historian"
MAX_SOURCES = 12
EXPORT_LIMIT = 2_000_000       # строк в одном файле CSV


def create_app(settings: Settings | None = None, *, historian_factory=None,
               check_options: dict | None = None) -> FastAPI:
    """historian_factory и check_options подменяют историк в тестах."""
    settings = settings or Settings.from_env()
    db = Database(settings)
    workers: dict[str, Copier] = {}
    source_lock = asyncio.Lock()

    def worker(source: str) -> Copier:
        if source not in workers:
            workers[source] = Copier(db, source=source, **(
                {"historian_factory": historian_factory} if historian_factory else {}))
        return workers[source]

    def config_key(source: str) -> str:
        return SETTING_KEY if source == "main" else f"{SETTING_KEY}:{source}"

    async def saved_config(source: str) -> dict[str, Any]:
        raw = await db.load_setting(config_key(source))
        if source != "main" and raw is None:
            raise HTTPException(404, "источник Historian не найден")
        return normalize(raw or {}, strict=False)

    async def all_configs() -> dict[str, dict[str, Any]]:
        raw = await db.source_settings()
        return {s: normalize(c, strict=False) for s, c in {"main": {}, **raw}.items()}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await db.connect()
        try:
            for source, config in (await all_configs()).items():
                if config["enabled"] and config["server"]:
                    await worker(source).start(config)
            yield
        finally:
            await asyncio.gather(*(c.stop(quiet=True) for c in workers.values()))
            await db.close()

    app = FastAPI(title="historian2grafana", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None)
    app.state.db = db
    app.state.copier = worker("main")

    def public(config: dict[str, Any]) -> dict[str, Any]:
        out = dict(config)
        out["password_set"] = bool(out.pop("password", ""))
        return out

    def merged(body: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
        """Новые настройки поверх сохранённых. Пустой пароль значит «не менять»."""
        raw = {**old, **{k: v for k, v in body.items() if k in DEFAULTS}}
        if not body.get("password"):
            raw["password"] = old.get("password", "")
        try:
            return normalize(raw)
        except HistorianError as exc:
            raise HTTPException(400, str(exc)) from exc

    # ------------------------------------------------------------------ API
    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/api/info")
    async def info() -> dict[str, Any]:
        return {"version": __version__, "grafana_url": settings.grafana_url,
                "grafana_port": settings.grafana_port, "timescale": db.timescale}

    @app.get("/api/settings")
    async def get_settings(source: str = "main") -> dict[str, Any]:
        return public(await saved_config(source))

    @app.get("/api/sources")
    async def list_sources() -> dict[str, Any]:
        return {"items": [{"id": source, "server": config["server"],
                           "state": worker(source).state} for source, config in
                          (await all_configs()).items()]}

    @app.post("/api/sources", status_code=201)
    async def create_source(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        source = str(body.get("id") or "").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", source):
            raise HTTPException(400, "имя источника: 1–32 символа, латинские буквы, цифры, - и _; "
                               "первый символ — буква")
        async with source_lock:
            configs = await all_configs()
            if source in configs:
                raise HTTPException(409, "такой источник уже есть")
            if len(configs) >= MAX_SOURCES:
                raise HTTPException(400, f"допускается не больше {MAX_SOURCES} источников")
            await db.save_setting(config_key(source), {"enabled": False})
        return {"id": source}

    @app.put("/api/settings")
    async def put_settings(body: dict[str, Any] = Body(...), source: str = "main") -> dict[str, Any]:
        async with source_lock:
            old = await saved_config(source)
            config = merged(body, old)
            config["enabled"] = old["enabled"] and bool(config["server"])
            await db.save_setting(config_key(source), config)
            if config["enabled"]:
                await worker(source).start(config)
            elif worker(source).running:
                await worker(source).stop()
            return public(config)

    @app.post("/api/test")
    async def test(body: dict[str, Any] = Body(default={}), source: str = "main") -> dict[str, Any]:
        config = merged(body, await saved_config(source))
        steps = await check(config, **(check_options or {}))
        return {"ok": all(s.ok for s in steps), "steps": [s.as_dict() for s in steps]}

    @app.post("/api/copy/start")
    async def copy_start(body: dict[str, Any] = Body(default={}), source: str = "main") -> dict[str, Any]:
        async with source_lock:
            config = merged(body, await saved_config(source))
            if not config["server"]:
                raise HTTPException(400, "сначала укажите сервер историка")
            config["enabled"] = True
            await db.save_setting(config_key(source), config)
            await worker(source).start(config)
            return worker(source).status()

    @app.post("/api/copy/stop")
    async def copy_stop(source: str = "main") -> dict[str, Any]:
        async with source_lock:
            config = await saved_config(source)
            config["enabled"] = False
            await db.save_setting(config_key(source), config)
            await worker(source).stop()
            return worker(source).status()

    @app.post("/api/copy/reset")
    async def copy_reset(source: str = "main") -> dict[str, Any]:
        """Удалить скопированные значения и загрузить историю заново."""
        async with source_lock:
            config = await saved_config(source)
            copier = worker(source)
            was_running = copier.running
            await copier.stop(quiet=True)
            try:
                await db.reset_data(source)
                copier.event("info", "Скопированные значения удалены")
            finally:
                if was_running and config["server"]:
                    await copier.start(config)
            return copier.status()

    @app.get("/api/status")
    async def status(source: str = "main") -> dict[str, Any]:
        configs = await all_configs()
        if source not in configs:
            raise HTTPException(404, "источник Historian не найден")
        return {"copy": worker(source).status(), "db": await db.stats(),
                "sources": [{"id": s, "state": worker(s).state} for s in configs]}

    @app.get("/api/tags")
    async def tags(q: str = "", limit: int = Query(200, ge=1, le=2000),
                   offset: int = Query(0, ge=0), inactive: bool = False,
                   ids: str = "", source: str | None = None) -> dict[str, Any]:
        id_list = _ids(ids) if ids else None
        total, items = await db.list_tags(q.strip(), limit, offset, inactive, id_list, source)
        return {"total": total, "items": items}

    @app.get("/api/series")
    async def series(ids: str, start: str = Query(..., alias="from"),
                     end: str | None = Query(None, alias="to"),
                     points: int = Query(800, ge=10, le=5000)) -> dict[str, Any]:
        id_list = _ids(ids)[:20]
        t0, t1 = _period(start, end)
        _, items = await db.list_tags(limit=len(id_list) or 1, include_inactive=True,
                                      ids=id_list)
        data = await db.series(items, t0, t1, points)
        return {"from": t0.timestamp(), "to": t1.timestamp(),
                "tags": [{**t, **data[t["tag_id"]]} for t in items]}

    @app.get("/api/export")
    async def export(ids: str, start: str = Query(..., alias="from"),
                     end: str | None = Query(None, alias="to"),
                     tz: int = Query(0, ge=-900, le=900)) -> StreamingResponse:
        """Значения тегов за период в CSV для Excel: время по часам браузера (tz
        берётся из Date.getTimezoneOffset), разделитель «;», десятичная запятая."""
        id_list = _ids(ids)[:50]
        t0, t1 = _period(start, end)
        zone = timezone(timedelta(minutes=-tz))

        def number(value: float | None) -> str:
            return "" if value is None else repr(float(value)).replace(".", ",")

        async def lines():
            # BOM нужен, чтобы Excel сразу понял кодировку UTF-8
            yield "﻿Время;Тег;Значение;Качество\r\n".encode("utf-8")
            n = 0
            chunk: list[str] = []
            async for row in db.export_rows(id_list, t0, t1, EXPORT_LIMIT):
                local = row["ts"].astimezone(zone)
                stamp = local.strftime("%d.%m.%Y %H:%M:%S")
                if local.microsecond:
                    stamp += f",{local.microsecond // 1000:03d}"
                value = row["value_text"] if row["value_text"] is not None else number(
                    row["value"])
                value = str(value).replace(";", ",").replace("\r", " ").replace("\n", " ")
                chunk.append(f"{stamp};{row['name']};{value};"
                             f"{'хорошее' if row['quality'] == 0 else 'плохое'}\r\n")
                n += 1
                if len(chunk) >= 2000:
                    yield "".join(chunk).encode("utf-8")
                    chunk = []
            if n >= EXPORT_LIMIT:
                chunk.append(f"# выгружены первые {EXPORT_LIMIT} строк — сократите период\r\n")
            yield "".join(chunk).encode("utf-8")

        name = f"historian_{t0.astimezone(zone):%Y%m%d_%H%M}.csv"
        return StreamingResponse(lines(), media_type="text/csv; charset=utf-8",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ------------------------------------------------------------ скрипты
    def script_body(body: dict[str, Any]) -> tuple[str, str]:
        name = str(body.get("name") or "").strip()
        code = str(body.get("code") or "")
        if not name:
            raise HTTPException(400, "укажите название скрипта")
        if len(name) > 100:
            raise HTTPException(400, "название длиннее 100 символов")
        if len(code) > scripts.MAX_CODE:
            raise HTTPException(400, f"скрипт длиннее {scripts.MAX_CODE} символов")
        return name, code

    async def run_script(code: str, body: dict[str, Any]) -> dict[str, Any]:
        t0, t1 = _period(str(body.get("from") or ""), body.get("to"))
        try:
            points = min(max(int(body.get("points") or 1000), 10), 5000)
            tz = min(max(int(body.get("tz") or 0), -900), 900)
        except (TypeError, ValueError):
            raise HTTPException(400, "points и tz — числа") from None
        try:
            return await scripts.run(db, code, t0, t1, points=points, tz_minutes=tz)
        except scripts.ScriptError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.get("/api/scripts")
    async def scripts_list() -> dict[str, Any]:
        items = await db.list_scripts()
        nodes = {s["script_id"]: name for name, s in grafana.script_nodes(items).items()}
        for item in items:
            item["node"] = nodes[item["script_id"]]
        return {"items": items,
                "help": [{"name": n, "signature": s, "text": t} for n, s, t in scripts.HELP]}

    @app.post("/api/scripts")
    async def script_create(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        name, code = script_body(body)
        try:
            script_id = await db.save_script(None, name, code)
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, f"скрипт «{name}» уже есть — выберите другое название") \
                from None
        return {"script_id": script_id, "name": name, "code": code}

    @app.put("/api/scripts/{script_id}")
    async def script_update(script_id: int, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        name, code = script_body(body)
        try:
            found = await db.save_script(script_id, name, code)
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, f"скрипт «{name}» уже есть — выберите другое название") \
                from None
        if found is None:
            raise HTTPException(404, "такого скрипта нет — возможно, его удалили")
        return {"script_id": script_id, "name": name, "code": code}

    @app.delete("/api/scripts/{script_id}")
    async def script_delete(script_id: int) -> dict[str, Any]:
        if not await db.delete_script(script_id):
            raise HTTPException(404, "такого скрипта нет — возможно, его уже удалили")
        return {"ok": True}

    @app.post("/api/scripts/run")
    async def script_run(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return await run_script(str(body.get("code") or ""), body)

    @app.post("/api/scripts/{script_id}/run")
    async def script_run_saved(script_id: int,
                               body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        script = await db.get_script(script_id)
        if script is None:
            raise HTTPException(404, "такого скрипта нет — возможно, его удалили")
        return {"name": script["name"], **await run_script(script["code"], body)}

    # ------------------------------------------------------------ Grafana
    # Источник данных «Теги и скрипты»: Grafana обращается сюда как к Graphite
    async def graphite_params(request: Request) -> dict[str, list[str]]:
        params: dict[str, list[str]] = {}
        for key, value in request.query_params.multi_items():
            params.setdefault(key, []).append(value)
        if request.method == "POST":
            body = (await request.body()).decode("utf-8", "replace")
            for key, values in parse_qs(body, keep_blank_values=True).items():
                params.setdefault(key, []).extend(values)
        return params

    @app.api_route("/graphite/metrics/find", methods=["GET", "POST"])
    async def graphite_find(request: Request) -> list[dict[str, Any]]:
        params = await graphite_params(request)
        return await grafana.find(db, (params.get("query") or ["*"])[0])

    @app.api_route("/graphite/render", methods=["GET", "POST"])
    async def graphite_render(request: Request) -> Any:
        params = await graphite_params(request)

        def one(key: str, default: str | None = None) -> str | None:
            return (params.get(key) or [default])[0]
        try:
            points = int(float(one("maxDataPoints", "1000")))
            return await grafana.render(db, params.get("target") or [], one("from"), one("until"),
                                        points)
        except (grafana.GrafanaError, ValueError) as exc:
            return JSONResponse({"message": str(exc), "error": str(exc)}, status_code=400)

    @app.get("/graphite/functions")
    async def graphite_functions() -> dict[str, Any]:
        # Функций Graphite нет: расчёты пишутся на странице «Скрипты»
        return {}

    @app.get("/graphite/version")
    async def graphite_version() -> str:
        return "1.1.10"

    @app.get("/graphite/tags/{rest:path}")
    async def graphite_tags(rest: str) -> list[str]:
        return []

    def dashboards_folder() -> Path:
        return Path(settings.dashboards_dir)

    def dashboard_info(item: dict[str, str]) -> dict[str, str]:
        return {**item, "path": f"/d/{item['uid']}/"}

    @app.get("/api/dashboards")
    async def dashboards_list() -> dict[str, Any]:
        return {"items": [dashboard_info(d)
                          for d in grafana.saved_dashboards(dashboards_folder())]}

    @app.post("/api/dashboards")
    async def dashboard_save(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        title = " ".join(str(body.get("title") or "").split())
        if not title:
            raise HTTPException(400, "укажите название дашборда")
        if len(title) > 100:
            raise HTTPException(400, "название длиннее 100 символов")
        panels = body.get("panels")
        if not isinstance(panels, list) or len(panels) > 20:
            raise HTTPException(400, "panels: ожидался список графиков")
        try:
            board = await grafana.build_dashboard(db, title, panels, body.get("span") or {})
            replaced = grafana.save_dashboard(dashboards_folder(), board)
        except (grafana.GrafanaError, KeyError, TypeError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, f"не удалось записать файл дашборда: {exc}") from exc
        return {**dashboard_info({"uid": board["uid"], "title": title}), "replaced": replaced}

    @app.delete("/api/dashboards/{uid}")
    async def dashboard_delete(uid: str) -> dict[str, Any]:
        if not grafana.delete_dashboard(dashboards_folder(), uid):
            raise HTTPException(404, "такого дашборда нет — возможно, его уже удалили")
        return {"ok": True}

    # ------------------------------------------------------------ страницы
    @app.middleware("http")
    async def no_stale_pages(request, call_next):
        # После обновления приложения браузер должен взять новые страницы,
        # а не старые из своего кэша
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB / "index.html")

    app.mount("/", StaticFiles(directory=WEB), name="web")
    return app


def _ids(text: str) -> list[int]:
    try:
        return [int(x) for x in text.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "ids: ожидались номера тегов через запятую") from None


def _period(start: str, end: str | None) -> tuple[datetime, datetime]:
    t1 = _time(end) if end else datetime.now(timezone.utc)
    t0 = _time(start)
    if t0 >= t1:
        raise HTTPException(400, "начало периода должно быть раньше конца")
    if t1 - t0 > timedelta(days=400):
        raise HTTPException(400, "период больше 400 дней")
    return t0, t1


def _time(text: str) -> datetime:
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"не понял время {text!r}") from None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value
