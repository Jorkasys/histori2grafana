"""База TimescaleDB (PostgreSQL): схема, настройки, запись и чтение значений."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

import asyncpg

from .config import Settings
from .historian import Tag

log = logging.getLogger("db")

SCHEMA = Path(__file__).with_name("schema.sql")
VALUE_COLUMNS = ("ts", "tag_id", "value", "value_text", "quality")
# Сырые данные старше этого срока TimescaleDB сжимает (в 10–20 раз)
COMPRESS_AFTER = "7 days"
# Поиск без учёта регистра и для русских букв. Комплект без интернета создаёт базу без
# локали (initdb --no-locale), и там ILIKE и lower() кириллицу не сворачивают
_UPPER_RU = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
_LOWER_RU = _UPPER_RU.lower()


def _folded(column: str) -> str:
    return f"translate(lower({column}), '{_UPPER_RU}', '{_LOWER_RU}')"


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def quote_literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


class Database:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.pool: asyncpg.Pool | None = None
        self.timescale = False

    # ---------------------------------------------------------------- запуск
    async def connect(self, wait_s: float = 120) -> None:
        """Подключиться, дождавшись базы: при старте контейнеров она может
        подняться позже приложения."""
        s = self.settings
        deadline = time.monotonic() + wait_s
        while True:
            try:
                self.pool = await asyncpg.create_pool(
                    host=s.db_host, port=s.db_port, database=s.db_name, user=s.db_user,
                    password=s.db_password, min_size=1, max_size=6, command_timeout=600)
                break
            except (OSError, asyncpg.PostgresError, asyncio.TimeoutError) as exc:
                if time.monotonic() > deadline:
                    raise
                log.info("база %s:%s пока недоступна (%s) — жду", s.db_host, s.db_port, exc)
                await asyncio.sleep(3)
        await self.migrate()

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def acquire(self):
        assert self.pool is not None, "база не подключена"
        return self.pool.acquire()

    async def migrate(self) -> None:
        async with self.acquire() as conn:
            # В Docker база идёт с TimescaleDB, в комплекте без Docker это обычный
            # PostgreSQL. Приложение работает с обеими
            available = await conn.fetchval(
                "SELECT count(*) FROM pg_available_extensions WHERE name = 'timescaledb'")
            if available:
                try:
                    await conn.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
                except asyncpg.PostgresError as exc:
                    log.warning("TimescaleDB не подключилась (%s) — данные хранятся в "
                                "обычных таблицах PostgreSQL", exc)
            else:
                log.info("база — PostgreSQL без TimescaleDB: данные хранятся в обычных таблицах")
            self.timescale = bool(await conn.fetchval(
                "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'"))
            await conn.execute(SCHEMA.read_text(encoding="utf-8"))
            if self.timescale:
                await self._timescale(conn)
        await self.ensure_reader()

    async def _timescale(self, conn) -> None:
        await conn.execute(
            "SELECT create_hypertable('tag_value', 'ts', "
            "chunk_time_interval => INTERVAL '1 day', migrate_data => TRUE, "
            "if_not_exists => TRUE)")
        enabled = await conn.fetchval(
            "SELECT compression_enabled FROM timescaledb_information.hypertables "
            "WHERE hypertable_name = 'tag_value'")
        try:
            if not enabled:
                await conn.execute(
                    "ALTER TABLE tag_value SET (timescaledb.compress, "
                    "timescaledb.compress_segmentby = 'tag_id', "
                    "timescaledb.compress_orderby = 'ts DESC')")
            await conn.execute(
                f"SELECT add_compression_policy('tag_value', INTERVAL '{COMPRESS_AFTER}', "
                "if_not_exists => TRUE)")
        except asyncpg.PostgresError as exc:
            log.warning("сжатие данных не включено: %s", exc)

    async def ensure_reader(self) -> None:
        """Учётная запись для Grafana: читает теги и значения, но не настройки
        (в них пароль историка) и ничего не может изменить."""
        s = self.settings
        if not s.reader_user:
            return
        role = quote_ident(s.reader_user)
        try:
            async with self.acquire() as conn:
                exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1",
                                             s.reader_user)
                if not exists:
                    await conn.execute(f"CREATE ROLE {role} LOGIN")
                await conn.execute(
                    f"ALTER ROLE {role} WITH LOGIN PASSWORD {quote_literal(s.reader_password)}")
                await conn.execute(
                    f"GRANT CONNECT ON DATABASE {quote_ident(s.db_name)} TO {role}")
                await conn.execute(f"GRANT USAGE ON SCHEMA public TO {role}")
                await conn.execute(
                    f"GRANT SELECT ON tag, tag_value, tag_sync, tag_latest TO {role}")
        except asyncpg.PostgresError as exc:
            log.warning("не удалось настроить учётную запись Grafana %s: %s", s.reader_user, exc)

    # ------------------------------------------------------------- настройки
    async def load_setting(self, key: str) -> dict[str, Any] | None:
        async with self.acquire() as conn:
            raw = await conn.fetchval("SELECT value FROM app_setting WHERE key = $1", key)
        return None if raw is None else json.loads(raw)

    async def save_setting(self, key: str, value: dict[str, Any]) -> None:
        async with self.acquire() as conn:
            await conn.execute(
                "INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                key, json.dumps(value, ensure_ascii=False))

    # ------------------------------------------------------------ копирование
    async def upsert_tags(self, tags: Sequence[Tag]) -> dict[str, int]:
        """Завести теги в справочнике; теги, которых больше нет под масками,
        пометить неактивными (их данные остаются). Вернуть {имя: tag_id}."""
        async with self.acquire() as conn:
            async with conn.transaction():
                rows = []
                if tags:
                    rows = await conn.fetch(
                        """
                        INSERT INTO tag (name, description, unit, datatype, min_value,
                                         max_value, active)
                        SELECT x.name, x.descr, x.unit, x.dtype, x.minv, x.maxv, true
                        FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                                    $5::float8[], $6::float8[])
                             AS x(name, descr, unit, dtype, minv, maxv)
                        ON CONFLICT (name) DO UPDATE
                            SET description = EXCLUDED.description,
                                unit        = EXCLUDED.unit,
                                datatype    = EXCLUDED.datatype,
                                min_value   = EXCLUDED.min_value,
                                max_value   = EXCLUDED.max_value,
                                active      = true,
                                updated_at  = now()
                        RETURNING tag_id, name
                        """,
                        [t.name for t in tags], [t.description for t in tags],
                        [t.unit for t in tags], [t.datatype for t in tags],
                        [t.min_value for t in tags], [t.max_value for t in tags])
                await conn.execute(
                    "UPDATE tag SET active = false, updated_at = now() "
                    "WHERE active AND NOT (name = ANY($1::text[]))", [t.name for t in tags])
        return {r["name"]: r["tag_id"] for r in rows}

    async def load_watermarks(self, tag_ids: Sequence[int]) -> dict[int, datetime]:
        async with self.acquire() as conn:
            rows = await conn.fetch(
                "SELECT tag_id, synced_until FROM tag_sync WHERE tag_id = ANY($1::int[])",
                list(tag_ids))
        return {r["tag_id"]: r["synced_until"] for r in rows}

    async def write_window(self, tag_ids: Sequence[int], start: datetime, end: datetime,
                           records: list[tuple]) -> None:
        """Заменить значения тегов в (start, end] и сдвинуть отметку «скопировано
        до» одной транзакцией, чтобы повторное чтение окна не давало дублей.

        records: кортежи (ts, tag_id, value, value_text, quality).
        """
        ids = list(tag_ids)
        async with self.acquire() as conn:
            async with conn.transaction():
                deleted = await conn.fetch(
                    "DELETE FROM tag_value WHERE tag_id = ANY($1::int[]) "
                    "AND ts > $2 AND ts <= $3 RETURNING tag_id", ids, start, end)
                if records:
                    await conn.copy_records_to_table("tag_value", records=records,
                                                     columns=VALUE_COLUMNS)
                delta = Counter(r[1] for r in records)
                delta.subtract(r["tag_id"] for r in deleted)
                await conn.execute(
                    """
                    INSERT INTO tag_sync (tag_id, synced_until, row_count)
                    SELECT unnest($1::int[]), $2, unnest($3::bigint[])
                    ON CONFLICT (tag_id) DO UPDATE
                        SET synced_until = EXCLUDED.synced_until,
                            row_count    = greatest(tag_sync.row_count + EXCLUDED.row_count, 0),
                            updated_at   = now()
                    """,
                    ids, end, [delta.get(i, 0) for i in ids])

    async def reset_data(self) -> None:
        """Удалить все скопированные значения и отметки: копирование начнётся
        заново, с загрузки истории."""
        async with self.acquire() as conn:
            async with conn.transaction():
                await conn.execute("TRUNCATE tag_value")
                await conn.execute("DELETE FROM tag_sync")

    # ------------------------------------------------------------------ чтение
    async def stats(self) -> dict[str, Any]:
        async with self.acquire() as conn:
            tags = await conn.fetchrow(
                "SELECT count(*) FILTER (WHERE active) AS active, count(*) AS total FROM tag")
            sync = await conn.fetchrow(
                "SELECT min(s.synced_until) AS oldest, max(s.synced_until) AS newest, "
                "coalesce(sum(s.row_count), 0) AS rows "
                "FROM tag_sync s JOIN tag t USING (tag_id) WHERE t.active")
            rows_total = await conn.fetchval("SELECT coalesce(sum(row_count), 0) FROM tag_sync")
            size = await conn.fetchval("SELECT pg_database_size(current_database())")
        return {"tags_active": tags["active"], "tags_total": tags["total"],
                "rows": int(rows_total), "db_bytes": int(size),
                "synced_oldest": _iso(sync["oldest"]), "synced_newest": _iso(sync["newest"]),
                "timescale": self.timescale}

    async def list_tags(self, query: str = "", limit: int = 200, offset: int = 0,
                        include_inactive: bool = False, ids: Sequence[int] | None = None
                        ) -> tuple[int, list[dict[str, Any]]]:
        text = query.lower()
        pattern = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        name, descr = _folded("t.name"), _folded("coalesce(t.description, '')")
        where = [f"($1 = '' OR {name} LIKE $2 OR {descr} LIKE $2)", "(t.active OR $3)"]
        args: list[Any] = [query, pattern, include_inactive]
        if ids is not None:
            where.append("t.tag_id = ANY($4::int[])")
            args.append(list(ids))
        cond = " AND ".join(where)
        async with self.acquire() as conn:
            total = await conn.fetchval(f"SELECT count(*) FROM tag t WHERE {cond}", *args)
            rows = await conn.fetch(
                f"""
                SELECT t.tag_id, t.name, t.description, t.unit, t.datatype, t.active,
                       s.synced_until, s.row_count, v.ts, v.value, v.value_text, v.quality
                FROM tag t
                LEFT JOIN tag_sync s ON s.tag_id = t.tag_id
                LEFT JOIN LATERAL (
                    SELECT x.ts, x.value, x.value_text, x.quality FROM tag_value x
                    WHERE x.tag_id = t.tag_id ORDER BY x.ts DESC LIMIT 1) v ON true
                WHERE {cond}
                ORDER BY t.name
                LIMIT {int(limit)} OFFSET {int(offset)}
                """, *args)
        return int(total), [{
            "tag_id": r["tag_id"], "name": r["name"], "description": r["description"],
            "unit": r["unit"], "datatype": r["datatype"], "active": r["active"],
            "synced_until": _iso(r["synced_until"]), "rows": r["row_count"] or 0,
            "ts": _iso(r["ts"]), "value": r["value"], "text": r["value_text"],
            "quality": r["quality"]} for r in rows]

    async def chart_tags(self) -> list[dict[str, Any]]:
        """Теги, которые можно нарисовать: числовые и дискретные, по которым есть данные
        или которые копируются. Без последних значений, поэтому быстро."""
        async with self.acquire() as conn:
            rows = await conn.fetch(
                "SELECT t.tag_id, t.name, t.unit, t.datatype FROM tag t "
                "WHERE t.datatype <> 'string' AND (t.active OR EXISTS "
                "(SELECT 1 FROM tag_sync s WHERE s.tag_id = t.tag_id)) ORDER BY t.name")
        return [dict(r) for r in rows]

    async def series(self, tags: Sequence[dict[str, Any]], start: datetime, end: datetime,
                     points: int = 800) -> dict[int, dict[str, Any]]:
        """Данные для графиков: на каждый шаг (end − start) / points среднее,
        минимум, максимум и последнее значение. Добавляется и значение до начала
        окна, чтобы график не начинался с пустоты, и его продолжение до конца
        скопированного."""
        numeric = [t["tag_id"] for t in tags if t["datatype"] != "string"]
        texts = [t["tag_id"] for t in tags if t["datatype"] == "string"]
        step = max((end - start) / max(points, 10), timedelta(seconds=1))
        out: dict[int, dict[str, Any]] = {t["tag_id"]: {"points": [], "changes": []}
                                          for t in tags}
        async with self.acquire() as conn:
            if numeric:
                rows = await conn.fetch(
                    """
                    SELECT tag_id, date_bin($4::interval, ts, $2::timestamptz) AS bucket,
                           avg(value) AS avg_value, min(value) AS min_value,
                           max(value) AS max_value,
                           (array_agg(value ORDER BY ts DESC))[1] AS last_value
                    FROM tag_value
                    WHERE tag_id = ANY($1::int[]) AND ts > $2 AND ts <= $3
                      AND quality = 0 AND value IS NOT NULL
                    GROUP BY 1, 2
                    ORDER BY 1, 2
                    """, numeric, start, end, step)
                # Точку ставим в середину шага: среднее относится ко всему шагу
                half = step.total_seconds() / 2
                for r in rows:
                    out[r["tag_id"]]["points"].append(
                        [min(r["bucket"].timestamp() + half, end.timestamp()), r["avg_value"],
                         r["min_value"], r["max_value"], r["last_value"]])
                before = await conn.fetch(
                    """
                    SELECT t.id AS tag_id, p.ts, p.value
                    FROM unnest($1::int[]) AS t(id)
                    CROSS JOIN LATERAL (
                        SELECT x.ts, x.value FROM tag_value x
                        WHERE x.tag_id = t.id AND x.ts <= $2 AND x.quality = 0
                          AND x.value IS NOT NULL
                        ORDER BY x.ts DESC LIMIT 1) p
                    """, numeric, start)
                for r in before:
                    v = r["value"]
                    out[r["tag_id"]]["points"].insert(0, [start.timestamp(), v, v, v, v])
                synced = await conn.fetch(
                    "SELECT tag_id, synced_until FROM tag_sync WHERE tag_id = ANY($1::int[])",
                    numeric)
                for r in synced:
                    pts = out[r["tag_id"]]["points"]
                    edge = min(r["synced_until"], end).timestamp()
                    if pts and edge > pts[-1][0]:
                        last = pts[-1][4]
                        pts.append([edge, last, last, last, last])
            if texts:
                rows = await conn.fetch(
                    """
                    SELECT tag_id, ts, value_text, quality FROM (
                        SELECT tag_id, ts, value_text, quality,
                               row_number() OVER (PARTITION BY tag_id ORDER BY ts DESC) AS n
                        FROM tag_value
                        WHERE tag_id = ANY($1::int[]) AND ts > $2 AND ts <= $3) x
                    WHERE n <= 200
                    ORDER BY tag_id, ts DESC
                    """, texts, start, end)
                for r in rows:
                    out[r["tag_id"]]["changes"].append(
                        [r["ts"].timestamp(), r["value_text"], r["quality"]])
        return out

    async def raw_values(self, names: Sequence[str], start: datetime, end: datetime,
                         limit: int) -> dict[str, dict[str, Any]]:
        """Значения тегов для скриптов в том виде, как они скопированы, без усреднения.

        Возвращает {имя из скрипта: {name, unit, datatype, t, v, end, too_many}}.
        Имя ищется без учёта регистра, как в историке. None в v означает плохое
        качество. Первая точка хранит значение, действовавшее к началу периода."""
        if not names:
            return {}
        wanted = {n.lower(): n for n in names}
        out: dict[str, dict[str, Any]] = {}
        async with self.acquire() as conn:
            tags = await conn.fetch(
                "SELECT t.tag_id, t.name, t.unit, t.datatype, s.synced_until "
                "FROM tag t LEFT JOIN tag_sync s USING (tag_id) "
                "WHERE lower(t.name) = ANY($1::text[]) ORDER BY t.tag_id", list(wanted))
            for tag in tags:
                key = wanted.get(tag["name"].lower())
                if key is None or (key in out and out[key]["name"] == key):
                    continue
                item = {"name": tag["name"], "unit": tag["unit"], "datatype": tag["datatype"],
                        "t": [], "v": [], "end": end.timestamp(), "too_many": False}
                out[key] = item
                if tag["datatype"] == "string":
                    continue
                rows = await conn.fetch(
                    "SELECT ts, CASE WHEN quality = 0 THEN value END AS v FROM tag_value "
                    "WHERE tag_id = $1 AND ts > $2 AND ts <= $3 ORDER BY ts LIMIT $4",
                    tag["tag_id"], start, end, limit + 1)
                if len(rows) > limit:
                    item["too_many"] = True
                    continue
                before = await conn.fetchrow(
                    "SELECT CASE WHEN quality = 0 THEN value END AS v FROM tag_value "
                    "WHERE tag_id = $1 AND ts <= $2 ORDER BY ts DESC LIMIT 1",
                    tag["tag_id"], start)
                if before is not None:
                    item["t"].append(start.timestamp())
                    item["v"].append(before["v"])
                item["t"] += [r["ts"].timestamp() for r in rows]
                item["v"] += [r["v"] for r in rows]
                synced = tag["synced_until"]
                edge = min(synced, end) if synced is not None else (
                    rows[-1]["ts"] if rows else start)
                item["end"] = max(edge.timestamp(), item["t"][-1] if item["t"] else 0.0)
        return out

    async def export_rows(self, tag_ids: Sequence[int], start: datetime, end: datetime,
                          limit: int):
        """Значения тегов по порядку времени, по частям, для выгрузки в CSV."""
        async with self.acquire() as conn:
            async with conn.transaction():
                cursor = conn.cursor(
                    "SELECT v.ts, t.name, v.value, v.value_text, v.quality "
                    "FROM tag_value v JOIN tag t USING (tag_id) "
                    "WHERE v.tag_id = ANY($1::int[]) AND v.ts > $2 AND v.ts <= $3 "
                    "ORDER BY v.ts, t.name LIMIT $4", list(tag_ids), start, end, limit,
                    prefetch=5000)
                async for row in cursor:
                    yield row

    # ---------------------------------------------------------------- скрипты
    async def list_scripts(self) -> list[dict[str, Any]]:
        async with self.acquire() as conn:
            rows = await conn.fetch(
                "SELECT script_id, name, code, updated_at FROM script ORDER BY lower(name)")
        return [{"script_id": r["script_id"], "name": r["name"], "code": r["code"],
                 "updated_at": _iso(r["updated_at"])} for r in rows]

    async def get_script(self, script_id: int) -> dict[str, Any] | None:
        async with self.acquire() as conn:
            r = await conn.fetchrow("SELECT script_id, name, code FROM script "
                                    "WHERE script_id = $1", script_id)
        return dict(r) if r else None

    async def save_script(self, script_id: int | None, name: str, code: str) -> int | None:
        """Создать (script_id=None) или изменить скрипт. Вернёт None, если такого
        скрипта нет, а при повторе имени бросит asyncpg.UniqueViolationError."""
        async with self.acquire() as conn:
            if script_id is None:
                return await conn.fetchval(
                    "INSERT INTO script (name, code) VALUES ($1, $2) RETURNING script_id",
                    name, code)
            return await conn.fetchval(
                "UPDATE script SET name = $2, code = $3, updated_at = now() "
                "WHERE script_id = $1 RETURNING script_id", script_id, name, code)

    async def delete_script(self, script_id: int) -> bool:
        async with self.acquire() as conn:
            return await conn.fetchval("DELETE FROM script WHERE script_id = $1 "
                                       "RETURNING true", script_id) or False


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
