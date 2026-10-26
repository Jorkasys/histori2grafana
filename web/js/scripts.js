// Страница «Скрипты»: выборки по тегам (пики, пороги, связи). Результат сразу на
// графике; сохранённый скрипт можно положить на любой график страницы «Графики».

import {
  RANGES, arrowKeys, clear, confirmDialog, dateTime, debounce, del, el, fail, get, keepFocus, num,
  post, put, recall, remember, saveCsv, toast,
} from './core.js';
import { PENS, Trend } from './trend.js';

const STORE = 'scripts';
const iso = (seconds) => new Date(seconds * 1000).toISOString();

const BLANK = '# Новый скрипт. Например:\n# t = tag("имя тега")\n# show(peaks(t, level=80), "пики")\n';

const EXAMPLES = [
  { name: 'Пики выше порога', code: (a) => `# Пики выше уровня, который превышают лишь 5 % значений,
# не чаще одного за 10 минут. Уровень можно задать числом: level = 80
t = tag("${a}")
level = quantile(t, 0.95)
p = peaks(t, level=level, distance="10m")
show(t)
show(p, "пики")
print("уровень:", level)
print("пиков за период:", count(p))
` },
  { name: 'Выше порога и сколько времени', code: (a) => `# Участки выше порога и общее время над ним.
# Порог можно задать числом: limit = 80
t = tag("${a}")
limit = quantile(t, 0.8)
show(t)
show(const(limit, t), "порог")
show(above(t, limit), "выше порога")
print("порог:", limit)
print("выше порога всего, ч:", duration(t > limit))
print("пересечений снизу вверх:", count(crossings(t, limit, "up")))
` },
  { name: 'Разность двух тегов', code: (a, b) => `# Например, приход и расход: разность и её среднее
a = tag("${a}")
b = tag("${b}")
d = a - b
show(d, "разность")
show(smooth(d, "15m"), "среднее за 15 мин")
print("средняя разность:", mean(d))
` },
  { name: 'Связь тегов и модель', code: (a, b) => `# Как один тег зависит от другого: корреляция и линейная модель
y = tag("${a}")
x = tag("${b}")
print("корреляция:", corr(y, x))
show(y)
show(fit(y, x), "модель")
` },
];

export async function scriptsPage(view) {
  const saved = recall(STORE, {});
  let list = [];
  let help = [];
  let current = { script_id: null };
  let dirty = false;
  let range = saved.range && RANGES.some((r) => r[0] === saved.range) ? saved.range : '6h';
  let trend = null;

  // --- разметка ---------------------------------------------------------------
  const savedList = el('ul', { class: 'script-list' });
  const examples = el('ul', { class: 'script-list' });
  const nameInput = el('input', { placeholder: 'Например: пики температуры смесителя',
    'aria-label': 'Название скрипта' });
  const btnSave = el('button', { type: 'button', onclick: () => save(),
    title: 'Сохранить скрипт (Ctrl+S)' }, 'Сохранить');
  const btnDelete = el('button', { class: 'danger', type: 'button', onclick: () => remove() },
    'Удалить');
  const tagSearch = el('input', { type: 'search', placeholder: 'Вставить тег: начните вводить имя',
    'aria-label': 'Вставить тег в скрипт', autocomplete: 'off' });
  const suggest = el('div', { class: 'suggest-list', hidden: true, id: 'tag-suggest' });
  tagSearch.setAttribute('aria-controls', 'tag-suggest');
  const segs = el('div', { class: 'segs', role: 'group', 'aria-label': 'Период' });
  const gutter = el('pre', { class: 'gutter', 'aria-hidden': 'true' });
  const code = el('textarea', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    'aria-label': 'Текст скрипта', 'aria-describedby': 'code-keys' });
  const codeKeys = el('span', { class: 'sr-only', id: 'code-keys' }, 'Tab вставляет отступ. ' +
    'Чтобы перейти к следующей кнопке, нажмите Esc, затем Tab. Ctrl+Enter выполняет скрипт, ' +
    'Ctrl+S сохраняет.');
  const btnRun = el('button', { class: 'primary', type: 'button', onclick: () => run() },
    'Выполнить');
  const runState = el('span', { class: 'muted', role: 'status' });
  const errorBox = el('div', {});
  const chartBox = el('div', {});
  const outputBox = el('div', {});
  const eventsBox = el('div', {});
  const reference = el('div', { class: 'reference' });

  view.append(
    el('h1', {}, 'Скрипты'),
    el('p', { class: 'lead' }, 'Скрипт берёт значения тегов из базы приложения за выбранный ' +
      'период и отбирает нужное: пики, участки выше порога, разности и связи тегов. Данные в ' +
      'базе и историк скрипт не меняет. Сохранённый скрипт можно положить на любой график. ' +
      'Впервые пишете скрипт? Откройте ',
    el('a', { href: 'help/scripts.html', target: '_blank', rel: 'noopener' },
      'руководство для начинающих'), '.'),
    el('div', { class: 'scripts-layout' },
      el('aside', {},
        el('p', { class: 'side-title' }, 'Сохранённые'),
        savedList,
        el('button', { class: 'small', type: 'button', style: 'margin:-8px 0 22px',
          onclick: () => open(null) }, 'Новый скрипт'),
        el('p', { class: 'side-title' }, 'Примеры'),
        examples),
      el('section', {},
        el('div', { class: 'toolbar' },
          el('div', { style: 'flex:1;min-width:240px' }, nameInput), btnSave, btnDelete),
        el('div', { class: 'toolbar' },
          el('div', { class: 'suggest', style: 'flex:1;min-width:240px' }, tagSearch, suggest),
          segs),
        el('div', { class: 'editor' }, gutter, code), codeKeys,
        el('div', { class: 'toolbar', style: 'margin-top:12px' }, btnRun,
          el('span', { class: 'muted' }, 'или Ctrl+Enter'), runState),
        // Справка рядом с редактором, а не под результатами
        el('details', { class: 'card reference-box' },
          el('summary', {}, 'Справка: что можно писать в скрипте'),
          el('p', { class: 'hint' }, 'Язык похож на Python. Строка без присваивания показывает ' +
            'результат: ряд — на графике, число — в выводе. Комментарии — после #. Дробные числа ' +
            'в скрипте пишутся через точку (60.5), а вывод показывает их по-русски, с запятой. ' +
            'Подробно, с примерами и разбором ошибок — в ',
          el('a', { href: 'help/scripts.html', target: '_blank', rel: 'noopener' },
            'руководстве для начинающих'), '.'),
          reference),
        errorBox, chartBox, outputBox, eventsBox)),
  );

  // --- редактор ----------------------------------------------------------------
  function drawGutter(errorLine = null) {
    const n = code.value.split('\n').length;
    clear(gutter);
    for (let i = 1; i <= n; i += 1) {
      gutter.append(i === errorLine ? el('span', { class: 'err' }, String(i)) : String(i),
        i < n ? '\n' : '');
    }
    gutter.scrollTop = code.scrollTop;
  }

  function markDirty() {
    dirty = true;
    keep();
  }

  function keep() {
    remember(STORE, { id: current.script_id, range,
      draft: dirty ? { name: nameInput.value, code: code.value } : null });
  }

  code.addEventListener('input', () => { markDirty(); drawGutter(); });
  code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });
  let escaped = false;
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      // Tab вставляет отступ; Esc, затем Tab — уйти из редактора к следующей кнопке
      if (escaped) return;
      e.preventDefault();
      code.setRangeText('    ', code.selectionStart, code.selectionEnd, 'end');
      markDirty();
    }
    escaped = e.key === 'Escape';
  });
  // Ctrl+S сохраняет скрипт, а не страницу браузера
  for (const node of [code, nameInput]) {
    node.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ы' || e.code === 'KeyS')) {
        e.preventDefault();
        save();
      }
    });
  }
  nameInput.addEventListener('input', markDirty);

  // --- вставка тега ---------------------------------------------------------------
  let options = [];
  async function lookup() {
    const q = tagSearch.value.trim();
    if (!q) {
      suggest.hidden = true;
      return;
    }
    try {
      const data = await get(`/tags?${new URLSearchParams({ q, limit: 12 })}`);
      options = data.items.filter((t) => t.datatype !== 'string');
      clear(suggest);
      for (const t of options) {
        suggest.append(el('button', { type: 'button', onmousedown: (e) => e.preventDefault(),
          onclick: () => insertTag(t.name) }, t.name,
        t.description ? el('span', { class: 'desc' }, t.description) : null));
      }
      if (!options.length) suggest.append(el('p', { class: 'muted', style: 'margin:8px 10px' },
        'Числовых тегов с таким именем нет'));
      suggest.hidden = false;
    } catch (error) { fail(error); }
  }

  function insertTag(name) {
    code.focus();
    code.setRangeText(`tag("${name}")`, code.selectionStart, code.selectionEnd, 'end');
    tagSearch.value = '';
    suggest.hidden = true;
    markDirty();
    drawGutter();
  }

  tagSearch.addEventListener('input', debounce(lookup, 250));
  tagSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && options.length && !suggest.hidden) {
      e.preventDefault();
      insertTag(options[0].name);
    } else if (e.key === 'ArrowDown' && !suggest.hidden) {
      // Стрелка вниз — в список вариантов, там стрелками и Enter
      const first = suggest.querySelector('button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Escape') {
      suggest.hidden = true;
    }
  });
  arrowKeys(suggest, 'button');
  suggest.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      suggest.hidden = true;
      tagSearch.focus();
    } else if (e.key === 'ArrowUp' && document.activeElement === suggest.querySelector('button')) {
      tagSearch.focus();
    }
  });
  // Список прячется, когда фокус ушёл и из поля, и из вариантов
  const hideSoon = () => setTimeout(() => {
    if (!suggest.contains(document.activeElement) && document.activeElement !== tagSearch) {
      suggest.hidden = true;
    }
  }, 150);
  tagSearch.addEventListener('blur', hideSoon);
  suggest.addEventListener('focusout', hideSoon);

  // --- период ----------------------------------------------------------------------
  function drawPeriod() {
    keepFocus(segs, () => {
      clear(segs);
      for (const [key, label] of RANGES) {
        segs.append(el('button', { class: `seg small${range === key ? ' on' : ''}`, type: 'button',
          dataset: { key }, 'aria-pressed': String(range === key),
          onclick: () => setRange(key) }, label));
      }
    });
  }

  // Новый период — результат сразу пересчитывается, как на странице «Графики»
  function setRange(key) {
    if (range === key) return;
    range = key;
    keep();
    drawPeriod();
    if (code.value.trim()) run();
  }

  function period() {
    const span = (RANGES.find((r) => r[0] === range) || RANGES[2])[2];
    const now = Date.now() / 1000;
    return [now - span, now];
  }

  // --- список скриптов ---------------------------------------------------------------
  function drawList() {
    keepFocus(savedList, () => {
      clear(savedList);
      for (const s of list) {
        const on = s.script_id === current.script_id;
        savedList.append(el('li', {}, el('button', {
          type: 'button', class: on ? 'on' : '', dataset: { key: String(s.script_id) },
          'aria-current': on ? 'true' : null, onclick: () => open(s),
        }, s.name)));
      }
      if (!list.length) savedList.append(el('li', { class: 'muted', style: 'padding:7px 4px' },
        'Пока ни одного'));
    });
    clear(examples);
    for (const ex of EXAMPLES) {
      examples.append(el('li', {}, el('button', { type: 'button', onclick: () => example(ex) },
        ex.name)));
    }
    btnDelete.hidden = !current.script_id;
  }

  async function confirmLeave() {
    return !dirty || confirmDialog('Изменения не сохранены',
      'Текст скрипта изменён и не сохранён. Если продолжить, изменения пропадут.',
      'Продолжить без сохранения');
  }

  async function open(script) {
    if (!(await confirmLeave())) return;
    current = script ? { ...script } : { script_id: null };
    nameInput.value = script ? script.name : '';
    code.value = script ? script.code : BLANK;
    dirty = false;
    keep();
    drawGutter();
    drawList();
    clearResults();
    if (script) run();
  }

  async function example(ex) {
    if (!(await confirmLeave())) return;
    let names = ['имя тега', 'имя второго тега'];
    try {
      const data = await get('/tags?limit=50');
      const numeric = data.items.filter((t) => t.datatype === 'float64').map((t) => t.name);
      if (numeric.length) names = [numeric[0], numeric[1] || numeric[0]];
    } catch { /* останутся заглушки */ }
    current = { script_id: null };
    nameInput.value = ex.name;
    code.value = ex.code(...names);
    dirty = true;
    keep();
    drawGutter();
    drawList();
    clearResults();
    run();
  }

  async function refreshList() {
    const data = await get('/scripts');
    list = data.items;
    help = data.help;
    drawList();
  }

  async function save() {
    const name = nameInput.value.trim();
    if (!name) {
      fail(new Error('Укажите название скрипта'));
      nameInput.focus();
      return;
    }
    try {
      btnSave.disabled = true;
      const body = { name, code: code.value };
      const result = current.script_id ? await put(`/scripts/${current.script_id}`, body)
        : await post('/scripts', body);
      current = result;
      dirty = false;
      keep();
      await refreshList();
      toast('Скрипт сохранён', 'ok');
    } catch (error) { fail(error); } finally { btnSave.disabled = false; }
  }

  async function remove() {
    if (!current.script_id) return;
    const ok = await confirmDialog(`Удалить скрипт «${current.name}»?`,
      'Скрипт пропадёт и с графиков, куда он был добавлен. Данные тегов не меняются.',
      'Удалить скрипт');
    if (!ok) return;
    try {
      await del(`/scripts/${current.script_id}`);
      dirty = false;
      current = { script_id: null };
      await refreshList();
      await open(null);
      toast('Скрипт удалён', 'ok');
    } catch (error) { fail(error); }
  }

  // --- выполнение -------------------------------------------------------------------
  function clearResults() {
    clear(errorBox);
    clear(outputBox);
    clear(eventsBox);
    runState.textContent = '';
    if (trend) {
      trend.destroy();
      trend = null;
    }
  }

  async function run() {
    const [from, to] = period();
    btnRun.disabled = true;
    clear(runState).append(el('span', { class: 'spinner' }), ' Выполняю…');
    clear(errorBox);
    drawGutter();
    try {
      const result = await post('/scripts/run', { code: code.value, from: iso(from), to: iso(to),
        points: 1200, tz: new Date().getTimezoneOffset() });
      runState.textContent = `Готово за ${result.elapsed_ms.toLocaleString('ru-RU')} мс`;
      showResult(result, [from, to]);
    } catch (error) {
      // Старый результат рядом с ошибкой сбивает с толку: убираем его
      clearResults();
      const line = (error.message.match(/^строка (\d+)/) || [])[1];
      drawGutter(line ? Number(line) : null);
      errorBox.append(el('div', { class: 'note bad', role: 'alert', style: 'margin-top:14px' },
        error.message));
    } finally {
      btnRun.disabled = false;
    }
  }

  function showResult(result, window) {
    clear(outputBox);
    clear(eventsBox);
    // Каждая линия своим цветом, события (пики) цветом линии своего тега
    const colors = [];
    const lineOf = new Map();
    result.outputs.forEach((out, k) => {
      if (out.kind === 'events') return;
      colors[k] = PENS[lineOf.size % PENS.length];
      lineOf.set(`o${k}`, colors[k]);
      if (out.source && !lineOf.has(out.source)) lineOf.set(out.source, colors[k]);
    });
    // Пики без своей линии берут следующее свободное перо: первое — синее, а не красное,
    // которое читается как авария
    let spare = lineOf.size;
    result.outputs.forEach((out, k) => {
      if (out.kind !== 'events') return;
      colors[k] = (out.source && lineOf.get(out.source)) || PENS[spare++ % PENS.length];
    });
    const specs = result.outputs.map((out, k) => ({
      key: `o${k}`, label: out.name, title: out.name, unit: out.unit || '', bool: out.logical,
      color: colors[k],
      scale: out.unit ? `u:${out.unit}` : out.source ? `src:${out.source}` : `own:${k}`,
      kind: out.kind === 'events' ? 'events' : 'line', t: out.t, v: out.v, count: out.count,
      removable: false,
    }));
    if (specs.length) {
      if (!trend) {
        clear(chartBox);
        trend = new Trend(chartBox, { title: 'Результат', height: 300, sync: 'scripts',
          empty: 'Скрипт ничего не показал' });
        trend.node.style.marginTop = '14px';
      }
      trend.update(specs, window);
    } else if (trend) {
      trend.destroy();
      trend = null;
    }
    if (result.text.length) {
      outputBox.append(el('p', { class: 'side-title', style: 'margin-top:14px' }, 'Вывод'),
        el('pre', { class: 'output' }, result.text.join('\n')));
    }
    if (!specs.length && !result.text.length) {
      outputBox.append(el('p', { class: 'muted', style: 'margin-top:14px' },
        'Скрипт выполнен, но ничего не показал. Добавьте show(…) или print(…).'));
    }
    for (const out of result.outputs.filter((o) => o.kind === 'events')) {
      const rows = out.t.map((t, i) => [t, out.v[i]]);
      eventsBox.append(el('div', { style: 'margin-top:14px' },
        el('div', { class: 'row', style: 'margin-bottom:6px' },
          el('span', { class: 'side-title', style: 'margin:0' },
            `${out.name}: ${out.count.toLocaleString('ru-RU')} шт.`),
          out.truncated ? el('span', { class: 'muted' }, 'показаны первые 5000') : null,
          el('span', { class: 'spacer' }),
          rows.length ? el('button', { class: 'small', type: 'button', onclick: () => saveCsv(
            `${out.name.replace(/[^\wа-яё -]+/gi, '_').slice(0, 60)}.csv`, ['Время', 'Значение'],
            rows.map(([t, v]) => [dateTime(t), v])) }, 'Скачать CSV') : null),
        rows.length ? el('div', { class: 'table-wrap', style: 'max-height:240px' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Время'), el('th', {}, 'Значение'))),
          el('tbody', {}, rows.slice(0, 500).map(([t, v]) => el('tr', {},
            el('td', { style: 'width:200px' }, dateTime(t)),
            el('td', {}, v === null ? '—' : `${num(v)}${out.unit ? ` ${out.unit}` : ''}`))))))
          : el('p', { class: 'muted' }, 'За период не найдено')));
    }
  }

  function drawReference() {
    clear(reference);
    for (const h of help) {
      reference.append(el('div', {}, el('code', {}, h.signature), el('p', {}, h.text)));
    }
    reference.append(
      el('div', {}, el('code', {}, '+  -  *  /  **'), el('p', {}, 'Арифметика с рядами и ' +
        'числами. Ряды с разными моментами значений сводятся сами: значение держится до ' +
        'следующего изменения.')),
      el('div', {}, el('code', {}, '>  <  >=  <=  ==  !=  and  or  not'), el('p', {},
        'Условие: 1 — выполняется, 0 — нет. Например, where(t, p > 5 and r == 1).')),
      el('div', {}, el('code', {}, '"30s"  "5m"  "2h"  "1d"'), el('p', {}, 'Интервалы ' +
        '(можно и по-русски: "5мин", "2ч").')));
  }

  // --- запуск -------------------------------------------------------------------------
  drawPeriod();
  try {
    await refreshList();
  } catch (error) { fail(error); }
  drawReference();
  const last = list.find((s) => s.script_id === saved.id);
  if (saved.draft) {
    current = last ? { ...last } : { script_id: null };
    nameInput.value = saved.draft.name;
    code.value = saved.draft.code;
    dirty = true;
  } else if (last) {
    current = { ...last };
    nameInput.value = last.name;
    code.value = last.code;
  } else {
    code.value = BLANK;
  }
  drawGutter();
  drawList();
  if (current.script_id && !dirty) run();

  return {
    async leave() {
      const ok = await confirmLeave();
      if (ok && dirty) {
        // Ушли без сохранения, черновик больше не нужен
        dirty = false;
        keep();
      }
      return ok;
    },
    destroy() {
      if (trend) trend.destroy();
    },
  };
}
