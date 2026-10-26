"""Скрипты выборок по скопированным значениям тегов.

Скрипт состоит из нескольких строк на языке, похожем на Python:

    t = tag("Line1_Temp")
    show(t)
    show(peaks(t, level=80), "пики выше 80")

Он берёт значения тегов из базы приложения за выбранный период и отбирает
нужное: пики, участки выше порога, разности и связи тегов. Ни историк, ни
данные в базе скрипт не меняет. Копия остаётся полной, а отбор делается в
момент показа.

Интерпретатор Python скрипт не выполняет. Приложение разбирает текст само и
вычисляет только разрешённое: присваивания, арифметику, сравнения и вызовы
функций из списка HELP. Циклов, импорта, доступа к файлам и сети у скрипта
нет, поэтому запускать его безопасно.
"""

from __future__ import annotations

import ast
import asyncio
import bisect
import difflib
import inspect
import math
import operator
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

MAX_CODE = 20_000          # символов в скрипте
MAX_NODES = 3_000          # элементов разбора
MAX_STATEMENTS = 300
MAX_TAGS = 20              # разных тегов в одном скрипте
MAX_VALUES = 500_000       # значений одного тега за период
MAX_OUTPUTS = 20           # рядов на графике
MAX_TEXT = 200             # строк вывода
MAX_SECONDS = 30.0
GRID = 2_000               # точек общей сетки для corr и fit
MAX_GRID = 20_000          # точек для resample и smooth
MAX_EVENTS = 5_000         # событий (пиков и т. п.) в ответе


class ScriptError(Exception):
    """Ошибка в скрипте, понятная пользователю. line — номер строки, если известен."""

    def __init__(self, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.line = line

    def __str__(self) -> str:
        return f"строка {self.line}: {self.message}" if self.line else self.message


# ---------------------------------------------------------------------------
#  Ряд значений
# ---------------------------------------------------------------------------
class Series:
    """Ряд значений во времени.

    t хранит моменты (секунды Unix) по возрастанию, v значения. None в v
    означает разрыв: плохое качество или значение, отброшенное отбором.
    Каждое значение держится до следующего момента, а последнее до end,
    так же, как историк записывает изменения.

    events=True значит, что в ряду отдельные события (пики, пересечения
    порога), а не непрерывный сигнал. logical=True значит, что ряд состоит из
    1 и 0, то есть получен сравнением. unit и source хранят единицу и тег, из
    которого ряд получен: по ним график кладёт ряд на шкалу исходного тега.
    """

    __slots__ = ("t", "v", "end", "unit", "source", "events", "logical")

    def __init__(self, t: list[float], v: list[float | None], end: float | None = None, *,
                 unit: str | None = None, source: str | None = None, events: bool = False,
                 logical: bool = False) -> None:
        self.t = t
        self.v = v
        self.end = end if end is not None else (t[-1] if t else 0.0)
        self.unit = unit
        self.source = source
        self.events = events
        self.logical = logical

    def derive(self, t: list[float], v: list[float | None], end: float | None = None,
               **changes: Any) -> "Series":
        meta = {"unit": self.unit, "source": self.source, "events": self.events,
                "logical": self.logical, **changes}
        return Series(t, v, self.end if end is None else end, **meta)

    def valid(self) -> list[float]:
        return [v for v in self.v if v is not None]

    def segments(self):
        """Интервалы (начало, конец, значение), на которых держится каждое значение."""
        n = len(self.t)
        for i in range(n):
            t1 = self.t[i + 1] if i + 1 < n else self.end
            if t1 > self.t[i]:
                yield self.t[i], t1, self.v[i]


def _align(a: Series, b: Series) -> tuple[list[float], list, list, float]:
    """Общая сетка двух непрерывных рядов: моменты обоих, значения держатся."""
    end = min(a.end, b.end)
    if not a.t or not b.t:
        return [], [], [], end
    start = max(a.t[0], b.t[0])
    ts: list[float] = []
    va: list = []
    vb: list = []
    i = j = 0
    na, nb = len(a.t), len(b.t)
    cur_a = cur_b = None
    while i < na or j < nb:
        ta = a.t[i] if i < na else math.inf
        tb = b.t[j] if j < nb else math.inf
        t = ta if ta < tb else tb
        if t > end:
            break
        if ta == t:
            cur_a = a.v[i]
            i += 1
        if tb == t:
            cur_b = b.v[j]
            j += 1
        if t >= start:
            ts.append(t)
            va.append(cur_a)
            vb.append(cur_b)
    return ts, va, vb, end


def _sample(s: Series, times: list[float]) -> list[float | None]:
    """Значения ряда в заданные (возрастающие) моменты."""
    out: list[float | None] = []
    i, n = 0, len(s.t)
    if s.events:
        index = dict(zip(s.t, s.v))
        return [index.get(x) for x in times]
    cur = None
    have = False
    for x in times:
        while i < n and s.t[i] <= x:
            cur = s.v[i]
            have = True
            i += 1
        out.append(cur if have and x <= s.end else None)
    return out


def _combine(a: Series, b: Series, fn, **meta: Any) -> Series:
    if a.events or b.events:
        if a.events and b.events:
            index = dict(zip(b.t, b.v))
            pairs = [(t, v, index[t]) for t, v in zip(a.t, a.v) if t in index]
            return Series([p[0] for p in pairs], [fn(p[1], p[2]) for p in pairs], a.end,
                          events=True, **meta)
        ev, line = (a, b) if a.events else (b, a)
        sampled = _sample(line, ev.t)
        pairs = zip(ev.v, sampled) if a.events else zip(sampled, ev.v)
        return Series(list(ev.t), [fn(x, y) for x, y in pairs], ev.end, events=True, **meta)
    t, va, vb, end = _align(a, b)
    return Series(t, [fn(x, y) for x, y in zip(va, vb)], end, **meta)


def _safe(fn):
    def op(x, y):
        if x is None or y is None:
            return None
        try:
            r = fn(x, y)
        except (ZeroDivisionError, OverflowError, ValueError):
            return None
        if isinstance(r, complex) or (isinstance(r, float) and not math.isfinite(r)):
            return None
        return r
    return op


def _truth(x) -> bool | None:
    return None if x is None else x != 0


# ---------------------------------------------------------------------------
#  Время и числа
# ---------------------------------------------------------------------------
_DURATION = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*([a-zа-яё]*)\s*$", re.I)
_UNITS = {"": 1, "s": 1, "sec": 1, "с": 1, "сек": 1,
          "m": 60, "min": 60, "м": 60, "мин": 60,
          "h": 3600, "hour": 3600, "ч": 3600, "час": 3600,
          "d": 86400, "day": 86400, "д": 86400, "дн": 86400, "сут": 86400}


def seconds(value: Any, what: str) -> float:
    """Переводит «30s», «5m», «2h», «1d» (или «5мин», «2ч») в секунды. Число уже в секундах."""
    if isinstance(value, bool):
        raise ScriptError(f"{what}: ожидался интервал, например \"5m\"")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = _DURATION.match(value)
        if m and m.group(2).lower() in _UNITS:
            return float(m.group(1).replace(",", ".")) * _UNITS[m.group(2).lower()]
    raise ScriptError(f"{what}: не понял интервал {value!r} — пишите \"30s\", \"5m\", "
                      "\"2h\" или \"1d\"")


def fmt(value: Any) -> str:
    if value is None:
        return "нет данных"
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, int):
        return f"{value:,}".replace(",", " ").replace("-", "−")
    if isinstance(value, float):
        if not math.isfinite(value):
            return "нет данных"
        a = abs(value)
        if a and (a < 1e-3 or a >= 1e9):
            text = f"{value:.3e}"
        else:
            text = f"{value:.{4 if a < 1000 else 2}f}".rstrip("0").rstrip(".")
        return text.replace(".", ",").replace("-", "−")
    if isinstance(value, Series):
        n = len(value.valid())
        kind = "событий" if value.events else "значений"
        return f"ряд: {n} {kind}"
    return str(value)


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# ---------------------------------------------------------------------------
#  Справка: функции, которые есть в скриптах (её же показывает страница)
# ---------------------------------------------------------------------------
HELP: list[tuple[str, str, str]] = [
    ("tag", 'tag("имя")', "Берёт значения тега за выбранный период."),
    ("show", 'show(ряд, "подпись")', "Показывает ряд на графике. Число или текст попадёт в вывод."),
    ("print", "print(…)", "Выводит числа и текст в блок «Вывод»."),
    ("above", "above(ряд, порог)", "Оставляет только значения выше порога, в остальном ряд "
     "прерывается."),
    ("below", "below(ряд, порог)", "Оставляет только значения ниже порога."),
    ("between", "between(ряд, от, до)", "Оставляет только значения в диапазоне."),
    ("where", "where(ряд, условие)",
     "Оставляет значения там, где условие выполняется. Например, where(t, p > 5) даст "
     "температуру, пока давление выше 5."),
    ("peaks", 'peaks(ряд, level=…, prominence=…, distance="10m")',
     "Находит пики, то есть локальные максимумы. level отсекает пики ниже уровня, prominence "
     "требует, чтобы пик возвышался над соседними впадинами хотя бы на столько, distance "
     "оставляет не больше одного пика за интервал."),
    ("valleys", 'valleys(ряд, level=…, prominence=…, distance="10m")',
     "Находит впадины, то есть локальные минимумы. level здесь отсекает впадины выше уровня."),
    ("crossings", 'crossings(ряд, порог, "up")',
     'Находит моменты, когда ряд перешёл порог: "up" снизу вверх, "down" сверху вниз, "both" '
     'в обе стороны.'),
    ("smooth", 'smooth(ряд, "5m")', "Сглаживает ряд скользящим средним за окно."),
    ("rate", 'rate(ряд, "1m")', "Скорость изменения: на сколько ряд меняется за минуту "
     "(или за другой интервал)."),
    ("shift", 'shift(ряд, "30s")', "Сдвигает ряд по времени. Пригодится, чтобы сравнить теги "
     "с запаздыванием."),
    ("resample", 'resample(ряд, "1m", "mean")',
     'Приводит ряд к ровному шагу: "mean" берёт среднее за шаг, "min" и "max" крайние '
     'значения, "last" последнее.'),
    ("const", "const(80, ряд)", "Рисует горизонтальную линию, например порог, на шкале "
     "указанного ряда."),
    ("mean", "mean(ряд)", "Среднее за период с учётом того, сколько держалось каждое значение."),
    ("min", "min(ряд)", "Наименьшее значение. min(a, b) вернёт меньшее из чисел."),
    ("max", "max(ряд)", "Наибольшее значение."),
    ("std", "std(ряд)", "Разброс значений (среднеквадратичное отклонение)."),
    ("quantile", "quantile(ряд, 0.95)",
     "Уровень, ниже которого лежит заданная доля значений. При 0.95 выше него остаётся 5 %."),
    ("count", "count(ряд)", "Сколько в ряду значений. count(peaks(t)) считает пики."),
    ("sum", "sum(ряд)", "Сумма значений."),
    ("last", "last(ряд)", "Последнее значение."),
    ("duration", 'duration(t > 80, "h")',
     'Сколько времени условие выполнялось (или ряд имел значения). Единицы: "h" часы, "min" '
     'минуты, "s" секунды.'),
    ("corr", "corr(ряд1, ряд2)", "Корреляция двух рядов, число от −1 до 1."),
    ("fit", "fit(y, x1, x2, …)",
     "Строит линейную модель y ≈ a + b·x1 + …, печатает коэффициенты и R² и возвращает "
     "расчётный ряд."),
    ("abs", "abs(x)", "Модуль числа или ряда."),
    ("round", "round(x, 2)", "Округляет число или ряд."),
]
FUNCTIONS = {name for name, _sig, _text in HELP}
SIGNATURES = {name: sig for name, sig, _text in HELP}

_ALLOWED = (
    ast.Module, ast.Expr, ast.Assign, ast.Name, ast.Load, ast.Store, ast.Constant,
    ast.BinOp, ast.UnaryOp, ast.Compare, ast.BoolOp, ast.Call, ast.keyword, ast.Pass,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.USub, ast.UAdd, ast.Not,
    ast.And, ast.Or, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
)
_FORBIDDEN = {
    "For": "циклов в скриптах нет: функции работают сразу со всем рядом — например, "
           "above(t, 80)",
    "While": "циклов в скриптах нет: функции работают сразу со всем рядом",
    "If": "условий if нет — отбирайте значения функциями where, above, below",
    "IfExp": "условий if нет — отбирайте значения функциями where, above, below",
    "Import": "импорт недоступен", "ImportFrom": "импорт недоступен",
    "FunctionDef": "свои функции объявлять нельзя", "Lambda": "свои функции объявлять нельзя",
    "Attribute": "обращения через точку нет — пишите mean(t), а не t.mean()",
    "Subscript": "индексов [ ] нет", "List": "списков нет", "Tuple": "кортежей нет",
    "JoinedStr": "f-строк нет — передайте значения в print через запятую",
}
_ARITH = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
          ast.Div: operator.truediv, ast.Mod: operator.mod}
_COMPARE = {ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt,
            ast.LtE: operator.le, ast.Eq: operator.eq, ast.NotEq: operator.ne}


_QUOTES = "«»“”„‘’‚"
_DASHES = "–—"


def _syntax(exc: SyntaxError) -> str:
    """Сообщение Python об ошибке записи — понятными словами."""
    text = (exc.msg or "").lower()
    if "unterminated string" in text or "eol while scanning" in text:
        return "не закрыта кавычка"
    if "never closed" in text or "unexpected eof" in text:
        return "не закрыта скобка"
    if "unmatched" in text:
        return "лишняя закрывающая скобка"
    if "indent" in text:
        return "лишний отступ в начале строки — команды пишутся с самого начала строки"
    if "non-printable" in text:
        return ("в строке невидимый символ (например, неразрывный пробел из Word) — наберите "
                "строку заново")
    found = re.search(r"invalid character '(.)'", exc.msg or "")
    if found:
        char = found.group(1)
        if char in _QUOTES:
            return ("кавычки пишутся прямые: \"…\", а не «…» или “…” (так бывает, если текст "
                    "скопирован из Word)")
        if char in _DASHES:
            return "вместо минуса стоит тире — напишите обычный минус -"
        return f"недопустимый символ «{char}»"
    if "decimal literal" in text:
        return "число слито с буквами: интервал пишется в кавычках (\"5m\"), имя — с буквы"
    if "positional argument follows keyword" in text:
        return ("после аргумента с именем (например level=80) идёт аргумент без имени; дробные "
                "числа пишутся через точку: 80.5, а не 80,5")
    if "forgot a comma" in text:
        return "пропущена запятая между аргументами"
    if "cannot assign" in text:
        return "слева от знака = должно стоять имя: x = …; сравнение «равно» пишется =="
    if "expected ':'" in text:
        return "конструкций if, for и while в скриптах нет — отбирайте значения функциями"
    return "ошибка записи — проверьте скобки, кавычки и запятые в этой строке"


# ---------------------------------------------------------------------------
#  Разбор
# ---------------------------------------------------------------------------
class Program:
    """Разобранный и проверенный скрипт. tags — имена тегов, которые он берёт."""

    def __init__(self, code: str) -> None:
        if len(code) > MAX_CODE:
            raise ScriptError(f"скрипт длиннее {MAX_CODE} символов")
        self.code = code
        try:
            # Минус «−» из вывода print — тот же минус, его можно скопировать в скрипт
            self.tree = ast.parse(code.replace("−", "-"), mode="exec")
        except SyntaxError as exc:
            raise ScriptError(_syntax(exc), exc.lineno) from None
        if len(self.tree.body) > MAX_STATEMENTS:
            raise ScriptError(f"больше {MAX_STATEMENTS} строк-команд")
        self.tags: list[str] = []
        nodes = 0
        for node in ast.walk(self.tree):
            nodes += 1
            if nodes > MAX_NODES:
                raise ScriptError("скрипт слишком сложный")
            self._check(node)
        if len(self.tags) > MAX_TAGS:
            raise ScriptError(f"больше {MAX_TAGS} разных тегов в одном скрипте")

    def _check(self, node: ast.AST) -> None:
        line = getattr(node, "lineno", None)
        name = type(node).__name__
        if not isinstance(node, _ALLOWED):
            raise ScriptError(_FORBIDDEN.get(name, f"конструкция {name} не поддерживается"), line)
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float, str)) \
                and node.value is not None:
            raise ScriptError("такие значения не поддерживаются", line)
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ScriptError("имена не могут начинаться с «_»", line)
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if not isinstance(target, ast.Name):
                    raise ScriptError("присваивать можно только имени: x = …", line)
                if target.id in FUNCTIONS:
                    raise ScriptError(f"имя «{target.id}» занято функцией — выберите другое",
                                      line)
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ScriptError(_FORBIDDEN.get(type(node.func).__name__,
                                                 "вызывать можно только функции из справки"),
                                  line)
            if node.func.id not in FUNCTIONS:
                close = difflib.get_close_matches(node.func.id.lower(), FUNCTIONS, n=1)
                hint = f" — может быть, {close[0]}?" if close else "."
                raise ScriptError(f"нет функции «{node.func.id}»{hint} Список функций — в "
                                  "справке", line)
            if any(isinstance(a, ast.Starred) for a in node.args) or \
                    any(k.arg is None for k in node.keywords):
                raise ScriptError("распаковка * и ** не поддерживается", line)
            if node.func.id == "tag":
                if len(node.args) != 1 or node.keywords or not (
                        isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str)):
                    raise ScriptError('имя тега пишется в кавычках: tag("Line1_Temp")', line)
                tag = node.args[0].value.strip()
                if tag not in self.tags:
                    self.tags.append(tag)

    def execute(self, data: dict[str, Any], period: tuple[float, float],
                tz: timezone = timezone.utc, deadline: float | None = None) -> dict[str, Any]:
        """data — {имя тега: Series или текст ошибки}; period — (начало, конец)."""
        run = _Run(self, data, period, tz, deadline or time.monotonic() + MAX_SECONDS)
        for statement in self.tree.body:
            run.statement(statement)
        return {"outputs": run.outputs, "text": run.text}


# ---------------------------------------------------------------------------
#  Выполнение
# ---------------------------------------------------------------------------
class _Run:
    def __init__(self, program: Program, data: dict[str, Any], period: tuple[float, float],
                 tz: timezone, deadline: float) -> None:
        self.program = program
        self.data = data
        self.period = period
        self.tz = tz
        self.deadline = deadline
        self.env: dict[str, Any] = {}
        self.outputs: list[tuple[str, Series]] = []
        self.text: list[str] = []
        self.call_node: ast.Call | None = None
        # Ряды, взятые tag() без изменений: на графике подписываются именем тега
        self.raw: dict[int, tuple[Series, str]] = {}

    # --- служебное ------------------------------------------------------------
    def check_time(self) -> None:
        if time.monotonic() > self.deadline:
            raise ScriptError(f"скрипт выполняется дольше {int(MAX_SECONDS)} с — сократите "
                              "период или упростите скрипт")

    def source(self, node: ast.AST) -> str:
        text = ast.get_source_segment(self.program.code, node) or ""
        text = " ".join(text.split())
        return text if len(text) <= 60 else text[:57] + "…"

    def arg_text(self, i: int) -> str:
        node = self.call_node
        if node is not None and i < len(node.args):
            return self.source(node.args[i])
        return "ряд"

    def raw_name(self, x: Any) -> str | None:
        entry = self.raw.get(id(x))
        return entry[1] if entry and entry[0] is x else None

    def say(self, line: str) -> None:
        if len(self.text) < MAX_TEXT:
            self.text.append(line)
        elif len(self.text) == MAX_TEXT:
            self.text.append("… вывод сокращён")

    def show(self, name: str, series: Series) -> None:
        if len(self.outputs) >= MAX_OUTPUTS:
            raise ScriptError(f"на графике не больше {MAX_OUTPUTS} рядов")
        self.outputs.append((name, series))

    def when(self, t: float) -> str:
        return datetime.fromtimestamp(t, self.tz).strftime("%d.%m.%Y %H:%M:%S")

    # --- инструкции -------------------------------------------------------------
    def statement(self, node: ast.stmt) -> None:
        self.check_time()
        if isinstance(node, ast.Pass):
            return
        if isinstance(node, ast.Assign):
            value = self.eval(node.value)
            for target in node.targets:
                self.env[target.id] = value
            return
        value = self.eval(node.value)
        # Строка без присваивания — как в блокноте: ряд на график, число в вывод
        if isinstance(node.value, ast.Call) and node.value.func.id in ("show", "print"):
            return
        if isinstance(value, Series):
            self.show(self.raw_name(value) or self.source(node.value), value)
        elif value is not None:
            self.say(f"{self.source(node.value)} = {fmt(value)}")

    def _unknown(self, name: str) -> str:
        """Подсказка к незаданному имени: опечатка, регистр букв или имя тега без tag()."""
        text = f"имя «{name}» не задано — сначала присвойте его: {name} = …"
        same = [k for k in self.env if k.lower() == name.lower()]
        close = same or difflib.get_close_matches(name, list(self.env), n=1, cutoff=0.7)
        if close:
            text += f". Может быть, «{close[0]}»? Большие и маленькие буквы различаются"
        elif "_" in name or any(c.isdigit() for c in name):
            text += f". Если это имя тега — пишите tag(\"{name}\")"
        return text

    def eval(self, node: ast.AST) -> Any:
        self.check_time()
        try:
            if isinstance(node, ast.Constant):
                return node.value
            if isinstance(node, ast.Name):
                if node.id in self.env:
                    return self.env[node.id]
                if node.id in FUNCTIONS:
                    raise ScriptError(f"«{node.id}» — функция: добавьте скобки, "
                                      f"{SIGNATURES[node.id]}")
                raise ScriptError(self._unknown(node.id))
            if isinstance(node, ast.BinOp):
                return self.binop(node.op, self.eval(node.left), self.eval(node.right))
            if isinstance(node, ast.UnaryOp):
                return self.unary(node.op, self.eval(node.operand))
            if isinstance(node, ast.Compare):
                return self.compare(node)
            if isinstance(node, ast.BoolOp):
                return self.boolop(node)
            if isinstance(node, ast.Call):
                return self.call(node)
        except ScriptError as exc:
            if exc.line is None:
                exc.line = getattr(node, "lineno", None)
            raise
        raise ScriptError("не поддерживается", getattr(node, "lineno", None))

    # --- операции -------------------------------------------------------------
    def binop(self, op: ast.operator, a: Any, b: Any) -> Any:
        for x in (a, b):
            if isinstance(x, str):
                raise ScriptError("с текстом арифметика не работает")
        if isinstance(op, ast.Pow):
            if not _number(b) or abs(b) > 10:
                raise ScriptError("степень — число не больше 10 по модулю")
            fn = operator.pow
        else:
            fn = _ARITH[type(op)]
        safe = _safe(fn)
        if not isinstance(a, Series) and not isinstance(b, Series):
            if a is None or b is None:
                return None
            if isinstance(op, (ast.Div, ast.Mod)) and b == 0:
                raise ScriptError("деление на ноль")
            return safe(float(a), float(b))
        additive = isinstance(op, (ast.Add, ast.Sub))
        if isinstance(a, Series) and isinstance(b, Series):
            same_unit = a.unit if a.unit == b.unit else None
            meta = {"unit": same_unit if additive else None,
                    "source": a.source if additive and a.source == b.source else None}
            return _combine(a, b, safe, **meta)
        s, k = (a, b) if isinstance(a, Series) else (b, a)
        if k is None:
            return s.derive(list(s.t), [None] * len(s.v), logical=False)
        k = float(k)
        neutral = additive or (isinstance(op, (ast.Mult, ast.Div)) and k == 1)
        meta = {"logical": False} if neutral else {"unit": None, "source": None,
                                                    "logical": False}
        if s is a:
            values = [safe(v, k) for v in s.v]
        else:
            values = [safe(k, v) for v in s.v]
        return s.derive(list(s.t), values, **meta)

    def unary(self, op: ast.unaryop, a: Any) -> Any:
        if isinstance(a, str):
            raise ScriptError("с текстом арифметика не работает")
        if isinstance(op, ast.Not):
            if isinstance(a, Series):
                return a.derive(list(a.t), [None if v is None else float(v == 0) for v in a.v],
                                unit=None, source=None, logical=True)
            return float(not a)
        sign = -1.0 if isinstance(op, ast.USub) else 1.0
        if isinstance(a, Series):
            return a.derive(list(a.t), [None if v is None else sign * v for v in a.v],
                            source=a.source if sign > 0 else None)
        return None if a is None else sign * a

    def compare(self, node: ast.Compare) -> Any:
        left = self.eval(node.left)
        result = None
        for op, right_node in zip(node.ops, node.comparators):
            right = self.eval(right_node)
            part = self._compare_pair(_COMPARE[type(op)], left, right)
            result = part if result is None else self._both(result, part)
            left = right
        return result

    def _compare_pair(self, fn, a: Any, b: Any) -> Any:
        if isinstance(a, str) or isinstance(b, str):
            raise ScriptError("сравнивать можно числа и ряды")

        def cmp(x, y):
            return None if x is None or y is None else float(fn(x, y))
        if isinstance(a, Series) and isinstance(b, Series):
            return _combine(a, b, cmp, logical=True)
        if isinstance(a, Series):
            return a.derive(list(a.t), [cmp(v, b) for v in a.v], unit=None, source=None,
                            logical=True)
        if isinstance(b, Series):
            return b.derive(list(b.t), [cmp(a, v) for v in b.v], unit=None, source=None,
                            logical=True)
        return None if a is None or b is None else bool(fn(a, b))

    def _both(self, a: Any, b: Any) -> Any:
        def f(x, y):
            tx, ty = _truth(x), _truth(y)
            return None if tx is None or ty is None else float(tx and ty)
        return self._logic(a, b, f, lambda x, y: bool(x) and bool(y))

    def _either(self, a: Any, b: Any) -> Any:
        def f(x, y):
            tx, ty = _truth(x), _truth(y)
            if tx or ty:
                return 1.0
            return None if tx is None or ty is None else 0.0
        return self._logic(a, b, f, lambda x, y: bool(x) or bool(y))

    def _logic(self, a: Any, b: Any, series_fn, number_fn) -> Any:
        if isinstance(a, Series) and isinstance(b, Series):
            return _combine(a, b, series_fn, logical=True)
        if isinstance(a, Series) or isinstance(b, Series):
            s, k = (a, b) if isinstance(a, Series) else (b, a)
            k = None if k is None else float(bool(k))
            return s.derive(list(s.t), [series_fn(v, k) for v in s.v], unit=None, source=None,
                            logical=True)
        return number_fn(a, b)

    def boolop(self, node: ast.BoolOp) -> Any:
        values = [self.eval(v) for v in node.values]
        combine = self._both if isinstance(node.op, ast.And) else self._either
        result = values[0]
        for value in values[1:]:
            result = combine(result, value)
        return result

    def call(self, node: ast.Call) -> Any:
        name = node.func.id
        args = [self.eval(a) for a in node.args]
        kwargs = {k.arg: self.eval(k.value) for k in node.keywords}
        method = getattr(self, f"f_{name}")
        # «60,5» вместо «60.5» — два целых числа подряд: подскажем про точку
        comma = any(isinstance(a, ast.Constant) and isinstance(b, ast.Constant)
                    and type(a.value) is int and type(b.value) is int
                    for a, b in zip(node.args, node.args[1:]))
        hint = ". Дробные числа пишутся через точку: 60.5, а не 60,5" if comma else ""
        try:
            inspect.signature(method).bind(*args, **kwargs)
        except TypeError:
            raise ScriptError(f"{name}: неверные аргументы — пишите {SIGNATURES[name]}{hint}",
                              node.lineno) from None
        saved, self.call_node = self.call_node, node
        try:
            return method(*args, **kwargs)
        except ScriptError as exc:
            if hint and hint not in exc.message:
                exc.message += hint
            raise
        finally:
            self.call_node = saved

    # --- проверка аргументов --------------------------------------------------
    @staticmethod
    def series(x: Any, fn: str, what: str = "первый аргумент") -> Series:
        if isinstance(x, Series):
            return x
        raise ScriptError(f"{fn}: {what} — ряд, например tag(\"имя\"), а получено "
                          f"{'текст' if isinstance(x, str) else 'число'}")

    @staticmethod
    def number(x: Any, fn: str, what: str) -> float:
        if _number(x):
            return float(x)
        raise ScriptError(f"{fn}: {what} — число")

    @staticmethod
    def optional(x: Any, fn: str, what: str) -> float | None:
        return None if x is None else _Run.number(x, fn, what)

    # --- данные и вывод ---------------------------------------------------------
    def f_tag(self, name: str) -> Series:
        found = self.data.get(name.strip())
        if isinstance(found, Series):
            series = found.derive(list(found.t), list(found.v))
            self.raw[id(series)] = (series, found.source or name.strip())
            return series
        raise ScriptError(found or f"тега «{name}» нет в базе приложения")

    def f_show(self, x: Any, name: Any = None) -> None:
        label = name if isinstance(name, str) and name.strip() else (
            self.raw_name(x) or self.arg_text(0))
        if isinstance(x, Series):
            self.show(label, x)
        elif isinstance(x, str):
            self.say(x)
        else:
            self.say(f"{label} = {fmt(x)}")

    def f_print(self, *items: Any) -> None:
        self.say(" ".join(fmt(i) for i in items))

    # --- отбор значений ---------------------------------------------------------
    def _keep(self, s: Series, test) -> Series:
        return s.derive(list(s.t), [v if v is not None and test(v) else None for v in s.v],
                        logical=False)

    def f_above(self, x: Any, level: Any) -> Series:
        s = self.series(x, "above")
        lv = self.number(level, "above", "порог")
        return self._keep(s, lambda v: v > lv)

    def f_below(self, x: Any, level: Any) -> Series:
        s = self.series(x, "below")
        lv = self.number(level, "below", "порог")
        return self._keep(s, lambda v: v < lv)

    def f_between(self, x: Any, low: Any, high: Any) -> Series:
        s = self.series(x, "between")
        lo = self.number(low, "between", "нижняя граница")
        hi = self.number(high, "between", "верхняя граница")
        return self._keep(s, lambda v: lo <= v <= hi)

    def f_where(self, x: Any, condition: Any) -> Series:
        s = self.series(x, "where")
        cond = self.series(condition, "where", "условие")
        return _combine(s, cond, lambda v, c: v if v is not None and _truth(c) else None,
                        unit=s.unit, source=s.source)

    # --- пики и пересечения -----------------------------------------------------
    def _extrema(self, fn: str, x: Any, sign: int, level: Any, prominence: Any,
                 distance: Any) -> Series:
        s = self.series(x, fn)
        lv = self.optional(level, fn, "level")
        prom = self.optional(prominence, fn, "prominence")
        gap = None if distance is None else seconds(distance, f"{fn}: distance")
        # Подряд идущие равные значения (полка) — одна точка
        ts: list[float] = []
        vs: list[float | None] = []
        for t, v in zip(s.t, s.v):
            if v is not None and vs and vs[-1] == v:
                continue
            ts.append(t)
            vs.append(v)
        found: list[int] = []
        for i in range(1, len(vs) - 1):
            v, a, b = vs[i], vs[i - 1], vs[i + 1]
            if v is None or a is None or b is None:
                continue
            if sign * v > sign * a and sign * v > sign * b:
                if lv is None or sign * v >= sign * lv:
                    found.append(i)
        if prom is not None:
            kept = []
            for n, i in enumerate(found):
                if n % 500 == 0:
                    self.check_time()
                if self._prominence(vs, i, sign) >= prom:
                    kept.append(i)
            found = kept
        if gap:
            accepted: list[float] = []
            chosen = []
            for i in sorted(found, key=lambda k: -sign * vs[k]):
                pos = bisect.bisect_left(accepted, ts[i])
                near = [accepted[k] for k in (pos - 1, pos) if 0 <= k < len(accepted)]
                if all(abs(ts[i] - a) >= gap for a in near):
                    accepted.insert(pos, ts[i])
                    chosen.append(i)
            found = sorted(chosen)
        return Series([ts[i] for i in found], [vs[i] for i in found], s.end, unit=s.unit,
                      source=s.source, events=True)

    @staticmethod
    def _prominence(vs: list, i: int, sign: int) -> float:
        peak = sign * vs[i]
        bases = []
        for step in (-1, 1):
            low = peak
            j = i + step
            while 0 <= j < len(vs) and vs[j] is not None and sign * vs[j] <= peak:
                low = min(low, sign * vs[j])
                j += step
            bases.append(low)
        return peak - max(bases)

    def f_peaks(self, x: Any, level: Any = None, prominence: Any = None,
                distance: Any = None) -> Series:
        return self._extrema("peaks", x, 1, level, prominence, distance)

    def f_valleys(self, x: Any, level: Any = None, prominence: Any = None,
                  distance: Any = None) -> Series:
        return self._extrema("valleys", x, -1, level, prominence, distance)

    def f_crossings(self, x: Any, level: Any, direction: Any = "both") -> Series:
        s = self.series(x, "crossings")
        lv = self.number(level, "crossings", "порог")
        way = {"up": 1, "вверх": 1, "down": -1, "вниз": -1, "both": 0, "оба": 0}.get(
            str(direction).strip().lower())
        if way is None:
            raise ScriptError('crossings: направление — "up", "down" или "both"')
        ts: list[float] = []
        prev = None
        for t, v in zip(s.t, s.v):
            if v is None:
                prev = None
                continue
            if prev is not None:
                if way >= 0 and prev < lv <= v:
                    ts.append(t)
                elif way <= 0 and prev >= lv > v:
                    ts.append(t)
            prev = v
        return Series(ts, [lv] * len(ts), s.end, unit=s.unit, source=s.source, events=True)

    # --- преобразования ---------------------------------------------------------
    def _grid(self, s: Series, step: float, fn: str) -> list[float]:
        if not s.t:
            return []
        n = int(math.ceil((s.end - s.t[0]) / step)) if s.end > s.t[0] else 1
        if n > MAX_GRID:
            raise ScriptError(f"{fn}: слишком мелкий шаг для такого периода — получится больше "
                              f"{MAX_GRID} точек")
        return [s.t[0] + k * step for k in range(max(n, 1))]

    @staticmethod
    def _integrals(s: Series):
        """Накопленные площадь и время с данными к началу каждого отрезка."""
        area = [0.0]
        dur = [0.0]
        for t0, t1, v in s.segments():
            area.append(area[-1] + (v * (t1 - t0) if v is not None else 0.0))
            dur.append(dur[-1] + ((t1 - t0) if v is not None else 0.0))
        starts = [seg[0] for seg in s.segments()]
        values = [seg[2] for seg in s.segments()]

        def at(q: float) -> tuple[float, float]:
            k = bisect.bisect_right(starts, q) - 1
            if k < 0:
                return 0.0, 0.0
            v = values[k]
            seg_end = starts[k + 1] if k + 1 < len(starts) else s.end
            dt = min(q, seg_end) - starts[k]
            return (area[k] + (v * dt if v is not None else 0.0),
                    dur[k] + (dt if v is not None else 0.0))
        return at

    def f_smooth(self, x: Any, window: Any) -> Series:
        s = self.series(x, "smooth")
        if s.events:
            raise ScriptError("smooth: нужен непрерывный ряд, а не события")
        w = seconds(window, "smooth: окно")
        if w <= 0:
            raise ScriptError("smooth: окно должно быть больше нуля")
        step = max(w / 10, (s.end - s.t[0]) / MAX_GRID if s.t else 1, 1e-3)
        times = self._grid(s, step, "smooth")
        at = self._integrals(s)
        values: list[float | None] = []
        for q in times:
            a1, d1 = at(q + step)
            a0, d0 = at(q + step - w)
            values.append((a1 - a0) / (d1 - d0) if d1 - d0 > 0 else None)
        return s.derive(times, values)

    def f_rate(self, x: Any, per: Any = "1m") -> Series:
        s = self.series(x, "rate")
        k = seconds(per, "rate: интервал")
        ts, vs = [], []
        prev_t = prev_v = None
        for t, v in zip(s.t, s.v):
            if v is not None and prev_v is not None and t > prev_t:
                ts.append(t)
                vs.append((v - prev_v) / (t - prev_t) * k)
            elif v is None and ts:
                ts.append(t)
                vs.append(None)
            prev_t, prev_v = t, v
        label = per if isinstance(per, str) else f"{fmt(float(per))} с"
        return s.derive(ts, vs, unit=f"{s.unit}/{label}" if s.unit else None, source=None,
                        logical=False)

    def f_shift(self, x: Any, by: Any) -> Series:
        s = self.series(x, "shift")
        d = seconds(by, "shift: сдвиг") if not (isinstance(by, str) and by.strip().startswith(
            "-")) else -seconds(by.strip()[1:], "shift: сдвиг")
        return s.derive([t + d for t in s.t], list(s.v), s.end + d)

    def f_resample(self, x: Any, step: Any, how: Any = "mean") -> Series:
        s = self.series(x, "resample")
        width = seconds(step, "resample: шаг")
        if width <= 0:
            raise ScriptError("resample: шаг должен быть больше нуля")
        mode = str(how).strip().lower()
        if mode not in ("mean", "min", "max", "last"):
            raise ScriptError('resample: способ — "mean", "min", "max" или "last"')
        times = self._grid(s, width, "resample")
        values: list[float | None] = []
        if mode == "mean":
            at = self._integrals(s)
            for q in times:
                a1, d1 = at(q + width)
                a0, d0 = at(q)
                values.append((a1 - a0) / (d1 - d0) if d1 - d0 > 0 else None)
        else:
            segs = list(s.segments())
            starts = [g[0] for g in segs]
            for q in times:
                k0 = max(bisect.bisect_right(starts, q) - 1, 0)
                k1 = bisect.bisect_left(starts, q + width)
                inside = [g[2] for g in segs[k0:k1] if g[2] is not None and g[1] > q]
                if not inside:
                    values.append(None)
                elif mode == "min":
                    values.append(min(inside))
                elif mode == "max":
                    values.append(max(inside))
                else:
                    values.append(inside[-1])
        return s.derive(times, values, events=False)

    def f_const(self, value: Any, like: Any = None) -> Series:
        k = self.number(value, "const", "значение")
        start, end = self.period
        if like is not None:
            base = self.series(like, "const", "второй аргумент")
            return Series([start], [k], end, unit=base.unit, source=base.source)
        return Series([start], [k], end)

    def f_abs(self, x: Any) -> Any:
        if isinstance(x, Series):
            return x.derive(list(x.t), [None if v is None else abs(v) for v in x.v],
                            source=None)
        return None if x is None else abs(self.number(x, "abs", "аргумент"))

    def f_round(self, x: Any, digits: Any = 0) -> Any:
        n = int(self.number(digits, "round", "число знаков"))
        if isinstance(x, Series):
            return x.derive(list(x.t), [None if v is None else round(v, n) for v in x.v])
        return None if x is None else round(self.number(x, "round", "аргумент"), n)

    # --- числа за период --------------------------------------------------------
    def _values(self, x: Any, fn: str) -> list[float]:
        return self.series(x, fn).valid()

    def f_mean(self, x: Any) -> float | None:
        s = self.series(x, "mean")
        if s.events:
            vals = s.valid()
            return sum(vals) / len(vals) if vals else None
        area = dur = 0.0
        for t0, t1, v in s.segments():
            if v is not None:
                area += v * (t1 - t0)
                dur += t1 - t0
        if dur > 0:
            return area / dur
        vals = s.valid()
        return vals[-1] if vals else None

    def f_min(self, x: Any, *more: Any) -> Any:
        if isinstance(x, Series) and not more:
            vals = x.valid()
            return min(vals) if vals else None
        items = [x, *more]
        return min(self.number(i, "min", "аргументы") for i in items)

    def f_max(self, x: Any, *more: Any) -> Any:
        if isinstance(x, Series) and not more:
            vals = x.valid()
            return max(vals) if vals else None
        items = [x, *more]
        return max(self.number(i, "max", "аргументы") for i in items)

    def f_std(self, x: Any) -> float | None:
        vals = self._values(x, "std")
        if len(vals) < 2:
            return None
        m = sum(vals) / len(vals)
        return math.sqrt(sum((v - m) ** 2 for v in vals) / (len(vals) - 1))

    def f_quantile(self, x: Any, share: Any) -> float | None:
        q = self.number(share, "quantile", "доля (от 0 до 1)")
        if not 0 <= q <= 1:
            raise ScriptError("quantile: доля — от 0 до 1, например 0.95")
        vals = sorted(self._values(x, "quantile"))
        if not vals:
            return None
        pos = q * (len(vals) - 1)
        lo = int(pos)
        hi = min(lo + 1, len(vals) - 1)
        return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)

    def f_count(self, x: Any) -> int:
        return len(self._values(x, "count"))

    def f_sum(self, x: Any) -> float:
        return float(sum(self._values(x, "sum")))

    def f_last(self, x: Any) -> float | None:
        vals = self._values(x, "last")
        return vals[-1] if vals else None

    def f_duration(self, x: Any, unit: Any = "h") -> float:
        s = self.series(x, "duration")
        k = {"h": 3600, "ч": 3600, "min": 60, "мин": 60, "m": 60, "s": 1, "с": 1,
             "d": 86400, "сут": 86400}.get(str(unit).strip().lower())
        if k is None:
            raise ScriptError('duration: единица — "h", "min", "s" или "d"')
        if s.events:
            raise ScriptError("duration: нужен непрерывный ряд или условие, а не события")
        total = 0.0
        for t0, t1, v in s.segments():
            if v is not None and (not s.logical or v != 0):
                total += t1 - t0
        return total / k

    # --- связи тегов ------------------------------------------------------------
    def _common_grid(self, series: list[Series], fn: str) -> list[float]:
        start = max(s.t[0] for s in series if s.t) if all(s.t for s in series) else None
        if start is None:
            return []
        end = min(s.end for s in series)
        if end <= start:
            return []
        step = (end - start) / GRID
        return [start + (k + 0.5) * step for k in range(GRID)]

    def f_corr(self, x: Any, y: Any) -> float | None:
        a = self.series(x, "corr")
        b = self.series(y, "corr", "второй аргумент")
        grid = self._common_grid([a, b], "corr")
        pairs = [(p, q) for p, q in zip(_sample(a, grid), _sample(b, grid))
                 if p is not None and q is not None]
        if len(pairs) < 3:
            return None
        n = len(pairs)
        ma = sum(p for p, _ in pairs) / n
        mb = sum(q for _, q in pairs) / n
        sab = sum((p - ma) * (q - mb) for p, q in pairs)
        saa = sum((p - ma) ** 2 for p, _ in pairs)
        sbb = sum((q - mb) ** 2 for _, q in pairs)
        if saa <= 0 or sbb <= 0:
            return None
        return sab / math.sqrt(saa * sbb)

    def f_fit(self, y: Any, *xs: Any) -> Series:
        target = self.series(y, "fit")
        if not xs:
            raise ScriptError("fit: укажите хотя бы один ряд-фактор: fit(y, x1, x2)")
        if len(xs) > 5:
            raise ScriptError("fit: не больше пяти рядов-факторов")
        factors = [self.series(x, "fit", f"фактор {i + 1}") for i, x in enumerate(xs)]
        grid = self._common_grid([target, *factors], "fit")
        columns = [_sample(target, grid)] + [_sample(f, grid) for f in factors]
        rows = [(r[0], [1.0, *r[1:]]) for r in zip(*columns) if all(v is not None for v in r)]
        times = [t for t, r in zip(grid, zip(*columns)) if all(v is not None for v in r)]
        k = len(factors) + 1
        if len(rows) <= k:
            raise ScriptError("fit: мало общих данных у рядов за этот период")
        # Нормальные уравнения (XᵀX) b = Xᵀy, решение методом Гаусса
        a = [[sum(r[1][i] * r[1][j] for r in rows) for j in range(k)] for i in range(k)]
        rhs = [sum(r[1][i] * r[0] for r in rows) for i in range(k)]
        coef = _solve(a, rhs)
        if coef is None:
            raise ScriptError("fit: факторы линейно зависимы (или постоянны) — модель не "
                              "определяется")
        fitted = [sum(c * x for c, x in zip(coef, r[1])) for r in rows]
        mean_y = sum(r[0] for r in rows) / len(rows)
        ss_tot = sum((r[0] - mean_y) ** 2 for r in rows)
        ss_res = sum((r[0] - f) ** 2 for r, f in zip(rows, fitted))
        r2 = 1 - ss_res / ss_tot if ss_tot > 0 else None
        names = [self.arg_text(i) for i in range(1 + len(factors))]
        terms = [fmt(coef[0])]
        for c, name in zip(coef[1:], names[1:]):
            terms.append(f"{'−' if c < 0 else '+'} {fmt(abs(c))}·{name}")
        self.say(f"Модель: {names[0]} ≈ {' '.join(terms)}; R² = {fmt(r2)} "
                 f"(по {len(rows)} точкам)")
        return Series(times, fitted, target.end, unit=target.unit, source=target.source)


def _solve(a: list[list[float]], b: list[float]) -> list[float] | None:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    scale = max(abs(x) for row in a for x in row) or 1.0
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12 * scale:
            return None
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(n):
            if r != col:
                f = m[r][col] / m[col][col]
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


# ---------------------------------------------------------------------------
#  Ответ для страницы
# ---------------------------------------------------------------------------
def _thin(s: Series, points: int) -> tuple[list[float], list[float | None]]:
    """Сократить непрерывный ряд для графика, сохранив минимумы, максимумы и разрывы."""
    n = len(s.t)
    if n <= points * 2 or not n:
        return list(s.t), list(s.v)
    start, end = s.t[0], max(s.end, s.t[-1])
    width = (end - start) / points or 1.0
    ts: list[float] = []
    vs: list[float | None] = []
    i = 0
    while i < n:
        bucket = int((s.t[i] - start) / width)
        j = i
        keep = {i}
        lo = hi = None
        gap = None
        while j < n and int((s.t[j] - start) / width) == bucket:
            v = s.v[j]
            if v is None:
                if gap is None:
                    gap = j
            else:
                if lo is None or v < s.v[lo]:
                    lo = j
                if hi is None or v > s.v[hi]:
                    hi = j
            j += 1
        keep.add(j - 1)
        for k in (lo, hi, gap):
            if k is not None:
                keep.add(k)
        for k in sorted(keep):
            ts.append(s.t[k])
            vs.append(s.v[k])
        i = j
    return ts, vs


def _output(name: str, s: Series, points: int) -> dict[str, Any]:
    if s.events:
        t, v = list(s.t[:MAX_EVENTS]), list(s.v[:MAX_EVENTS])
        truncated = len(s.t) > MAX_EVENTS
    else:
        t, v = _thin(s, points)
        truncated = False
        # Последнее значение держится до конца ряда
        if t and s.end > t[-1]:
            t.append(s.end)
            v.append(v[-1])
    return {"name": name, "kind": "events" if s.events else "line", "unit": s.unit,
            "source": s.source, "logical": s.logical, "t": t, "v": v,
            "count": len(s.valid()), "truncated": truncated}


async def run(db, code: str, start: datetime, end: datetime, *, points: int = 1000,
              tz_minutes: int = 0) -> dict[str, Any]:
    """Выполнить скрипт на данных базы за период [start, end]."""
    began = time.monotonic()
    program = Program(code)
    raw = await db.raw_values(program.tags, start, end, MAX_VALUES)
    data: dict[str, Any] = {}
    for name in program.tags:
        item = raw.get(name)
        if item is None:
            data[name] = (f"тега «{name}» нет в базе приложения — проверьте имя в таблице "
                          "тегов на странице «Загрузка»")
        elif item["datatype"] == "string":
            data[name] = f"тег «{name}» строковый, а скрипты считают только числа"
        elif item["too_many"]:
            data[name] = (f"у тега «{name}» за период больше {MAX_VALUES:,} значений — "
                          "сократите период".replace(",", " "))
        else:
            data[name] = Series(item["t"], item["v"], item["end"], unit=item["unit"] or None,
                                source=item["name"])
    tz = timezone(timedelta(minutes=-tz_minutes))
    period = (start.timestamp(), end.timestamp())
    deadline = time.monotonic() + MAX_SECONDS
    result = await asyncio.to_thread(program.execute, data, period, tz, deadline)
    return {"outputs": [_output(name, s, points) for name, s in result["outputs"]],
            "text": result["text"], "tags": program.tags,
            "elapsed_ms": round((time.monotonic() - began) * 1000)}
