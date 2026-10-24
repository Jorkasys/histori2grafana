"""Веб-приложение: страницы в браузере и API для них."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import asyncpg
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, scripts
from .config import Settings
from .db import Database
from .historian import DEFAULTS, HistorianError, check, normalize
from .sync import Copier

log = logging.getLogger("app")

WEB = Path(__file__).resolve().parent.parent / "web"
SETTING_KEY = "historian"
EXPORT_LIMIT = 2_000_000       # строк в одном файле CSV


def create_app(settings: Settings | None = None, *, historian_factory=None,
               check_options: dict | None = None) -> FastAPI:
    """historian_factory и check_options подменяют историк в тестах."""
    settings = settings or Settings.from_env()
    db = Database(settings)
    copier = Copier(db, **({"historian_factory": historian_factory} if historian_factory else {}))

    async def saved_config() -> dict[str, Any]:
        return normalize(await db.load_setting(SETTING_KEY) or {}, strict=False)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await db.connect()
        config = await saved_config()
        if config["enabled"] and config["server"]:
            await copier.start(config)
        yield
        await copier.stop(quiet=True)
        await db.close()

    app = FastAPI(title="historian2grafana", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None)
    app.state.db = db
    app.state.copier = copier

    def public(config: dict[str, Any]) -> dict[str, Any]:
        out = dict(config)
        out["password_set"] = bool(out.pop("password", ""))
        return out

    def merged(body: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
        """Новые настройки поверх сохранённых. Пустой пароль — «не менять»."""
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
    async def get_settings() -> dict[str, Any]:
        return public(await saved_config())

    @app.put("/api/settings")
    async def put_settings(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        old = await saved_config()
        config = merged(body, old)
        config["enabled"] = old["enabled"]
        await db.save_setting(SETTING_KEY, config)
        if copier.running:
            await copier.start(config)
        return public(config)

    @app.post("/api/test")
    async def test(body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        config = merged(body, await saved_config())
        steps = await check(config, **(check_options or {}))
        return {"ok": all(s.ok for s in steps), "steps": [s.as_dict() for s in steps]}

    @app.post("/api/copy/start")
    async def copy_start(body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        config = merged(body, await saved_config())
        if not config["server"]:
            raise HTTPException(400, "сначала укажите сервер историка")
        config["enabled"] = True
        await db.save_setting(SETTING_KEY, config)
        await copier.start(config)
        return copier.status()

    @app.post("/api/copy/stop")
    async def copy_stop() -> dict[str, Any]:
        config = await saved_config()
        config["enabled"] = False
        await db.save_setting(SETTING_KEY, config)
        await copier.stop()
        return copier.status()

    @app.post("/api/copy/reset")
    async def copy_reset() -> dict[str, Any]:
        """Удалить скопированные значения и загрузить историю заново."""
        was_running = copier.running
        await copier.stop(quiet=True)
        await db.reset_data()
        copier.event("info", "Скопированные значения удалены")
        config = await saved_config()
        if was_running and config["server"]:
            await copier.start(config)
        return copier.status()

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        return {"copy": copier.status(), "db": await db.stats()}

    @app.get("/api/tags")
    async def tags(q: str = "", limit: int = Query(200, ge=1, le=2000),
                   offset: int = Query(0, ge=0), inactive: bool = False,
                   ids: str = "") -> dict[str, Any]:
        id_list = _ids(ids) if ids else None
        total, items = await db.list_tags(q.strip(), limit, offset, inactive, id_list)
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
        """Значения тегов за период в CSV для Excel: время по часам браузера
        (tz — смещение из Date.getTimezoneOffset), «;» и десятичная запятая."""
        id_list = _ids(ids)[:50]
        t0, t1 = _period(start, end)
        zone = timezone(timedelta(minutes=-tz))

        def number(value: float | None) -> str:
            return "" if value is None else repr(float(value)).replace(".", ",")

        async def lines():
            # BOM — чтобы Excel сразу понял кодировку UTF-8
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
        return {"items": await db.list_scripts(),
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
