"""Скрипты выборок: язык, функции, песочница и API (API — с PostgreSQL)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.historian import Tag
from app.main import create_app
from app.scripts import Program, ScriptError, Series, _thin

T0 = datetime(2026, 10, 20, 8, 0, tzinfo=timezone.utc).timestamp()


def run(code: str, **data: Series) -> dict:
    period = (T0, T0 + 3600)
    return Program(code).execute(data, period)


def outputs(result: dict) -> dict[str, Series]:
    return dict(result["outputs"])


def wave(n: int = 361, step: float = 10.0) -> Series:
    """Час значений раз в 10 с: синус с периодом 10 мин и тремя выбросами."""
    t = [T0 + i * step for i in range(n)]
    v = [50 + 10 * math.sin(2 * math.pi * i * step / 600) for i in range(n)]
    for i in (60, 200, 300):
        v[i] = 95.0
    return Series(t, v, t[-1], unit="°C", source="Line1_Temp")


def test_peaks_threshold_and_distance():
    res = run('t = tag("T")\n'
              'show(peaks(t), "все")\n'
              'show(peaks(t, level=90), "выбросы")\n'
              'show(peaks(t, level=55, distance="20m"), "редкие")\n'
              'n = count(peaks(t, level=90))\n'
              'print("пиков:", n)', T=wave())
    out = outputs(res)
    spikes = out["выбросы"]
    assert spikes.events and spikes.v == [95.0, 95.0, 95.0]
    assert spikes.t == [T0 + 600, T0 + 2000, T0 + 3000]
    assert spikes.source == "Line1_Temp" and spikes.unit == "°C"    # на шкале исходного тега
    assert len(out["все"].t) >= 6
    rare = out["редкие"].t
    assert all(b - a >= 1200 for a, b in zip(rare, rare[1:]))
    assert res["text"] == ["пиков: 3"]


def test_prominence_ignores_small_wiggles():
    t = [T0 + i for i in range(9)]
    s = Series(t, [0, 10, 9, 9.5, 9, 10.2, 0, 3, 0], t[-1])
    # Выступ пика 10 — всего 1: справа до более высокого 10,2 впадина лишь до 9
    out = outputs(run('show(peaks(tag("S"), prominence=0.8), "p")', S=s))
    assert out["p"].v == [10, 10.2, 3]
    out = outputs(run('show(peaks(tag("S"), prominence=2), "p")', S=s))
    assert out["p"].v == [10.2, 3]
    out = outputs(run('show(peaks(tag("S"), prominence=5), "p")', S=s))
    assert out["p"].v == [10.2]


def test_threshold_keeps_gaps_and_duration_counts_time():
    t = [T0, T0 + 600, T0 + 1200, T0 + 1800]
    s = Series(t, [70.0, 85.0, 90.0, 60.0], T0 + 3600)
    res = run('t = tag("S")\n'
              'show(above(t, 80), "выше")\n'
              'h = duration(t > 80, "min")\n'
              'print(h)\n'
              'print(duration(above(t, 80), "h"))', S=s)
    hi = outputs(res)["выше"]
    assert hi.v == [None, 85.0, 90.0, None] and hi.end == T0 + 3600
    assert res["text"] == ["20", "0,3333"]


def test_arithmetic_aligns_step_series():
    a = Series([T0, T0 + 10, T0 + 20], [1.0, 2.0, 3.0], T0 + 30, unit="т/ч", source="A")
    b = Series([T0 + 5, T0 + 15], [10.0, 20.0], T0 + 30, unit="т/ч", source="B")
    out = outputs(run('show(tag("A") + tag("B"), "сумма")\nshow(tag("A") * 2, "x2")', A=a, B=b))
    s = out["сумма"]
    assert s.t == [T0 + 5, T0 + 10, T0 + 15, T0 + 20]
    assert s.v == [11.0, 12.0, 22.0, 23.0]
    assert s.unit == "т/ч" and s.source is None           # одна единица — общая шкала
    assert out["x2"].unit is None and out["x2"].v == [2.0, 4.0, 6.0]


def test_where_crossings_and_logic():
    t = [T0 + i * 60 for i in range(6)]
    temp = Series(t, [10.0, 20.0, 30.0, 20.0, 10.0, 30.0], t[-1])
    run_ = Series([T0, T0 + 150], [1.0, 0.0], t[-1])
    res = run('t = tag("T")\nr = tag("R")\n'
              'show(where(t, r == 1 and t > 15), "w")\n'
              'show(crossings(t, 25, "up"), "up")\n'
              'show(crossings(t, 25), "both")', T=temp, R=run_)
    out = outputs(res)
    # Работа выключается на 150-й секунде: 30 °C в 120 с ещё попадает
    assert out["w"].v[:4] == [None, 20.0, 30.0, None]
    assert out["up"].t == [T0 + 120, T0 + 300] and out["up"].v == [25.0, 25.0]
    assert len(out["both"].t) == 3


def test_smooth_resample_rate_shift():
    t = [T0, T0 + 1800]
    s = Series(t, [10.0, 20.0], T0 + 3600, unit="°C", source="S")
    out = outputs(run('s = tag("S")\n'
                      'show(smooth(s, "10m"), "sm")\n'
                      'show(resample(s, "15m"), "r")\n'
                      'show(resample(s, "15m", "max"), "rmax")\n'
                      'show(rate(s, "1h"), "rate")\n'
                      'show(shift(s, "-5m"), "sh")', S=s))
    sm = out["sm"]
    assert sm.v[0] == pytest.approx(10.0) and sm.v[-1] == pytest.approx(20.0)
    assert min(v for v in sm.v if v is not None) >= 10 - 1e-9
    assert out["r"].v == [pytest.approx(10.0), pytest.approx(10.0), pytest.approx(20.0),
                          pytest.approx(20.0)]
    assert out["rate"].v == [pytest.approx(20.0)] and out["rate"].unit == "°C/1h"
    assert out["sh"].t[0] == T0 - 300 and out["sh"].source == "S"


def test_fit_and_corr_find_linear_relation():
    t = [T0 + i * 30 for i in range(120)]
    x1 = [math.sin(i / 7) for i in range(120)]
    x2 = [math.cos(i / 11) for i in range(120)]
    y = [2 + 3 * a - 0.5 * b for a, b in zip(x1, x2)]
    res = run('y = tag("Y")\na = tag("A")\nb = tag("B")\n'
              'm = fit(y, a, b)\nshow(m, "модель")\n'
              'c = corr(y, a)\nprint(round(corr(a, a * 2 + 1), 3))',
              Y=Series(t, y, t[-1], unit="кг"), A=Series(t, x1, t[-1]), B=Series(t, x2, t[-1]))
    text = res["text"]
    assert text[0].startswith("Модель: y ≈ 2 + 3·a − 0,5·b; R² = 1")
    assert text[1] == "1"
    assert outputs(res)["модель"].unit == "кг"


def test_quantile():
    t = [T0 + i for i in range(101)]
    s = Series(t, [float(i) for i in range(101)], t[-1])
    res = run('s = tag("S")\nprint(quantile(s, 0.95), quantile(s, 0), quantile(s, 0.5))', S=s)
    assert res["text"] == ["95 0 50"]
    with pytest.raises(ScriptError, match="доля — от 0 до 1"):
        run('quantile(tag("S"), 95)', S=s)


def test_bare_lines_show_series_and_numbers():
    res = run('t = tag("T")\nt\nmax(t)\nmean(t) > 0\nshow(t)\nshow(t * 1)', T=wave())
    # Тег без изменений подписан своим именем, вычисленный ряд — выражением
    assert [name for name, _ in res["outputs"]] == ["Line1_Temp", "Line1_Temp", "t * 1"]
    assert res["text"] == ["max(t) = 95", "mean(t) > 0 = да"]


@pytest.mark.parametrize("code, message", [
    ("import os", "импорт недоступен"),
    ("__import__('os')", "нет функции «__import__»"),
    ("x = __builtins__", "имена не могут начинаться"),
    ('open("x")', "нет функции «open»"),
    ('t = tag("T")\nt.mean()', "обращения через точку нет"),
    ("for i in t: pass", "циклов в скриптах нет"),
    ('name = "T"\ntag(name)', "имя тега пишется в кавычках"),
    ('x = tag("T") +', "ошибка записи"),
    ('tag = 5', "имя «tag» занято функцией"),
    ('(lambda: 1)()', "свои функции объявлять нельзя"),
    ('x = 2 ** 100', "степень"),
    ('t = tag("T")\n\ny = t + z', "строка 3: имя «z» не задано"),
    ('peaks(tag("T"), 1, 2, 3, 4)', "peaks: неверные аргументы"),
    ('above(5, 1)', "above: первый аргумент — ряд"),
    ('smooth(tag("T"), "5 лет")', "не понял интервал"),
])
def test_sandbox_and_errors(code, message):
    with pytest.raises(ScriptError) as err:
        run(code, T=wave())
    assert message in str(err.value)


@pytest.mark.parametrize("code, message", [
    ('t = tag("T")\nshow(above(t, 60,5))', "через точку: 60.5, а не 60,5"),
    ('t = tag("T")\nshow(const(60,5))', "через точку"),
    ('t = tag("T")\nshow(peak(t))', "нет функции «peak» — может быть, peaks?"),
    ('T = tag("T")\nshow(t)', "Может быть, «T»? Большие и маленькие буквы различаются"),
    ('show(Mixer1_Temp)', 'Если это имя тега — пишите tag("Mixer1_Temp")'),
    ('t = tag(«T»)', "кавычки пишутся прямые"),
    ('t = tag("T")\nshow(t – 1)', "вместо минуса стоит тире"),
    ('t = tag("T")\nshow(smooth(t, 5m))', "интервал пишется в кавычках"),
    ('t = tag("T")\nshow(peaks(t, level=80,5))', "через точку: 80.5"),
    ('t = tag("T")\nshow(t))', "лишняя закрывающая скобка"),
    ('t = tag("T")\nif max(t) > 50:\n    print(1)', "условий if нет"),
    ('t = tag("T")\nshow(peaks(t level=80))', "пропущена запятая"),
])
def test_friendly_errors_for_beginners(code, message):
    with pytest.raises(ScriptError) as err:
        run(code, T=wave())
    assert message in str(err.value)


def test_minus_sign_from_output_is_a_minus():
    res = run('t = tag("T")\nprint(max(t − 1) == max(t) − 1)', T=wave())
    assert res["text"] == ["да"]


def test_missing_tag_error_has_line():
    with pytest.raises(ScriptError) as err:
        Program('x = 1\ny = tag("нет такого")').execute(
            {"нет такого": "тега «нет такого» нет в базе"}, (T0, T0 + 1))
    assert str(err.value) == "строка 2: тега «нет такого» нет в базе"


def test_thin_keeps_extremes_and_gaps():
    n = 100_000
    t = [T0 + i for i in range(n)]
    v = [0.0] * n
    v[12_345] = 100.0
    v[54_321] = -50.0
    v[70_000] = None
    ts, vs = _thin(Series(t, v, t[-1]), 500)
    assert len(ts) < 3_000
    assert 100.0 in vs and -50.0 in vs and None in vs


# ------------------------------------------------------------------ API с базой
async def fill(settings, now: datetime) -> None:
    db = Database(settings)
    await db.connect(wait_s=5)
    try:
        ids = await db.upsert_tags([Tag("Line1_Temp", "температура", "°C"),
                                    Tag("Line1_Run", "в работе", None, "bool"),
                                    Tag("Line1_Recipe", "рецепт", None, "string")])
        start = now - timedelta(hours=1)
        records = []
        for i in range(361):
            ts = start + timedelta(seconds=10 * i)
            temp = 95.0 if i in (100, 250) else 50 + 10 * math.sin(i / 20)
            records.append((ts, ids["Line1_Temp"], temp, None, 0))
            records.append((ts, ids["Line1_Run"], float(i // 60 % 2), None, 0))
        records.append((start + timedelta(seconds=5), ids["Line1_Recipe"], None, "DARK", 0))
        await db.write_window(list(ids.values()), start - timedelta(seconds=1), now, records)
    finally:
        await db.close()


def test_scripts_api(test_settings):
    import asyncio

    now = datetime.now(timezone.utc).replace(microsecond=0)
    asyncio.run(fill(test_settings, now))
    app = create_app(test_settings)
    period = {"from": (now - timedelta(hours=1)).isoformat(), "to": now.isoformat(),
              "points": 200, "tz": -180}
    with TestClient(app) as client:
        listing = client.get("/api/scripts").json()
        assert listing["items"] == [] and any(h["name"] == "peaks" for h in listing["help"])

        code = 't = tag("line1_temp")\nshow(t)\nshow(peaks(t, level=90), "пики")\nprint(max(t))'
        created = client.post("/api/scripts", json={"name": "Пики", "code": code}).json()
        dup = client.post("/api/scripts", json={"name": "Пики", "code": ""})
        assert dup.status_code == 409

        result = client.post(f"/api/scripts/{created['script_id']}/run", json=period).json()
        assert result["name"] == "Пики" and result["text"] == ["95"]
        line, peaks = result["outputs"]
        assert line["kind"] == "line" and line["unit"] == "°C" and line["source"] == "Line1_Temp"
        assert peaks["kind"] == "events" and peaks["v"] == [95.0, 95.0]

        bad = client.post("/api/scripts/run", json={**period, "code": 'x = tag("Line1_Recipe")'})
        assert bad.status_code == 400 and "строковый" in bad.json()["detail"]
        missing = client.post("/api/scripts/run", json={**period, "code": 'tag("Nope")'})
        assert missing.status_code == 400 and "строка 1" in missing.json()["detail"]
        run_ = client.post("/api/scripts/run", json={
            **period, "code": 'print(duration(tag("Line1_Run") == 1, "min"))'}).json()
        assert run_["text"] == ["30"]

        renamed = client.put(f"/api/scripts/{created['script_id']}",
                             json={"name": "Выбросы", "code": code}).json()
        assert renamed["name"] == "Выбросы"
        assert client.delete(f"/api/scripts/{created['script_id']}").json() == {"ok": True}
        assert client.delete(f"/api/scripts/{created['script_id']}").status_code == 404

        temp = client.get("/api/tags", params={"q": "Line1"}).json()["items"]
        ids = ",".join(str(t["tag_id"]) for t in temp)
        csv = client.get("/api/export", params={"ids": ids, "from": period["from"],
                                                "to": period["to"], "tz": -180})
        lines = csv.content.decode("utf-8-sig").splitlines()
        assert lines[0] == "Время;Тег;Значение;Качество"
        assert len(lines) == 1 + 2 * 360 + 1
        assert any(x.endswith(";Line1_Recipe;DARK;хорошее") for x in lines)
        assert any(";Line1_Temp;95,0;хорошее" in x for x in lines)
        assert csv.headers["content-disposition"].startswith("attachment;")
