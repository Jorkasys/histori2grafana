// Страница «Графики»: несколько графиков, на каждом теги и результаты скриптов.

import {
  RANGES, arrowKeys, clear, count, dateTime, debounce, el, fail, get, grafanaBase, guardGrafana,
  hashParams, keepFocus, plural, post, recall, remember, shared, toast,
} from './core.js';
import { loadPeriod, periodPicker, savePeriod, spanOf } from './period.js';
import { PENS, Trend } from './trend.js';

const MAX_PANELS = 8;
const MAX_ITEMS = 8;          // тегов и скриптов на одном графике
const MAX_TAGS = 20;          // разных тегов на странице, больше /api/series не отдаёт
const STORE = 'charts.v2';

const iso = (seconds) => new Date(seconds * 1000).toISOString();

// Графики в адресе страницы: p=t12.t15~s3 — графики через «~», теги (t) и скрипты (s) через «.»
function parsePanels(text) {
  return text.split('~').map((part) => ({
    items: part.split('.').map((x) => x.match(/^([ts])(\d+)$/)).filter(Boolean)
      .map((m) => `${m[1]}:${m[2]}`),
    fixed: {},
  }));
}

function formatPanels(panels) {
  return panels.map((p) => p.items.map((k) => k.replace(':', '')).join('.')).join('~');
}

const idOf = (key) => Number(key.split(':')[1]);

export async function chartsPage(view) {
  const params = hashParams();
  const saved = recall(STORE, {});
  // Период общий со страницей «Скрипты»; если он задан в адресе, берём из адреса
  const shared = loadPeriod(saved.range);
  const state = {
    panels: [],
    active: 0,              // последний график, с которым работали: на него кладёт список слева
    range: params.get('range') || shared.range,
    from: Number(params.get('from')) || (params.get('range') ? null : shared.from),
    to: Number(params.get('to')) || (params.get('range') ? null : shared.to),
    auto: saved.auto !== false,
    colors: saved.colors || {},
    tab: saved.tab || 'tags',
    back: [],
  };
  if (params.get('ids')) {
    state.panels = [{ items: params.get('ids').split(',').filter(Boolean).map((id) => `t:${id}`),
      fixed: {} }];
  } else if (params.get('p') !== null) {
    state.panels = parsePanels(params.get('p'));
  } else if (Array.isArray(saved.panels)) {
    state.panels = saved.panels;
    state.active = saved.active || 0;
  }
  if (!state.panels.length) state.panels = [{ items: [], fixed: {} }];
  state.panels = state.panels.slice(0, MAX_PANELS);
  state.active = Math.min(state.active, state.panels.length - 1);
  if (state.range === 'custom' && !(state.from && state.to && state.from < state.to)) state.range = '1h';
  if (!RANGES.some((r) => r[0] === state.range) && state.range !== 'custom') state.range = '1h';

  const tagInfo = new Map();      // tag_id → {name, description, unit, datatype}
  let scriptList = [];            // [{script_id, name}]
  let found = [];                 // результаты поиска тегов
  let tagData = new Map();
  let scriptData = new Map();
  let views = [];
  let loading = false;
  let again = false;
  let scriptsAt = 0;
  let timer = null;
  let tick = null;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  // Живая лента: период до «сейчас» и включено обновление
  const live = () => state.range !== 'custom' && auto.checked;

  // --- разметка ---------------------------------------------------------------
  const search = el('input', { type: 'search', placeholder: 'Поиск по имени или описанию',
    'aria-label': 'Поиск', 'aria-controls': 'pick-results' });
  const tabTags = el('button', { class: 'seg small', type: 'button',
    onclick: () => setTab('tags') }, 'Теги');
  const tabScripts = el('button', { class: 'seg small', type: 'button',
    onclick: () => setTab('scripts') }, 'Скрипты');
  const pickHint = el('p', { class: 'hint', 'aria-live': 'polite' });
  const results = el('div', { class: 'results', id: 'pick-results' });
  const back = el('button', { class: 'small back', type: 'button', onclick: () => goBack() },
    'Вернуть прежний период');
  // Поля «с … по» нужны только для своего периода: при готовых периодах они спрятаны
  const picker = periodPicker({ get: () => state, onPreset: (key) => setRange(key),
    onCustom: (from, to) => zoomTo(from, to), tail: back });
  const auto = el('input', { type: 'checkbox', checked: state.auto });
  const autoLabel = el('label', { class: 'check' }, auto, 'обновлять каждые 5 с');
  const panelsBox = el('div', {});
  const addPanel = el('button', { class: 'add-panel', type: 'button', onclick: () => newPanel() },
    'Новый график');
  const grafana = el('a', { class: 'btn small', target: '_blank', rel: 'noopener',
    title: 'Те же теги и период в Grafana, в новой вкладке' }, 'Открыть в Grafana');
  guardGrafana(grafana);

  view.append(
    el('h1', {}, 'Графики'),
    el('p', { class: 'lead' }, 'Протяните мышью по графику, чтобы увеличить участок: влево ' +
      'или вправо — время, вверх или вниз — значения. Двойной щелчок возвращает.'),
    el('div', { class: 'charts-layout' },
      el('aside', { class: 'picker' },
        el('div', { class: 'segs' }, tabTags, tabScripts),
        search, pickHint, results),
      el('section', {},
        el('div', { class: 'toolbar' }, picker.segs, autoLabel, picker.box),
        el('div', { class: 'toolbar' },
          el('span', { class: 'tool-group', role: 'group', 'aria-label': 'Раскладка' },
            el('span', { class: 'muted' }, 'Раскладка:'),
            el('button', { class: 'small', type: 'button', onclick: () => merge() },
              'все на один график'),
            el('button', { class: 'small', type: 'button', onclick: () => split() },
              'каждый тег отдельно')),
          el('span', { class: 'spacer' }),
          el('button', { class: 'small', type: 'button', onclick: () => exportCsv(),
            title: 'Все значения тегов с графиков за период, файл для Excel' }, 'Скачать CSV'),
          grafana),
        panelsBox, addPanel)),
  );

  // --- что на графиках ----------------------------------------------------------
  const allItems = () => [...new Set(state.panels.flatMap((p) => p.items))];
  const tagIds = () => [...new Set(allItems().filter((k) => k[0] === 't').map(idOf))];
  const scriptIds = () => [...new Set(allItems().filter((k) => k[0] === 's').map(idOf))];

  function colorOf(key) {
    if (state.colors[key] === undefined) {
      const used = new Set(allItems().map((k) => state.colors[k]).filter((c) => c !== undefined));
      let c = 0;
      while (used.has(c) && c < PENS.length) c += 1;
      state.colors[key] = c % PENS.length;
    }
    return state.colors[key];
  }

  function save() {
    const present = new Set(allItems());
    for (const key of Object.keys(state.colors)) if (!present.has(key)) delete state.colors[key];
    remember(STORE, { panels: state.panels, active: state.active, auto: auto.checked,
      colors: state.colors, tab: state.tab });
    savePeriod({ range: state.range, from: state.from, to: state.to });
    const query = new URLSearchParams({ p: formatPanels(state.panels), range: state.range });
    if (state.range === 'custom') {
      query.set('from', String(Math.round(state.from)));
      query.set('to', String(Math.round(state.to)));
    }
    history.replaceState(null, '', `#/charts?${query}`);
    grafanaLink();
  }

  function changed() {
    save();
    renderPanels();
    drawPicker();
    load();
  }

  // Изменился состав одного графика: перерисовывать сами панели не нужно
  function itemsChanged() {
    save();
    drawPicker();
    drawAdder();
    load();
  }

  // --- выбор тегов и скриптов -----------------------------------------------------
  function setTab(tab) {
    state.tab = tab;
    save();
    tabTags.classList.toggle('on', tab === 'tags');
    tabScripts.classList.toggle('on', tab === 'scripts');
    tabTags.setAttribute('aria-pressed', String(tab === 'tags'));
    tabScripts.setAttribute('aria-pressed', String(tab === 'scripts'));
    search.placeholder = tab === 'tags' ? 'Поиск по имени или описанию' : 'Поиск скрипта';
    find();
  }

  function drawHint() {
    const many = state.panels.length > 1;
    const what = state.tab === 'tags' ? 'тег' : 'результат скрипта';
    if (state.panels[state.active].items.length >= MAX_ITEMS) {
      pickHint.textContent = `На графике уже ${MAX_ITEMS} тегов и скриптов, больше не ` +
        'поместится. Начните новый график кнопкой под графиками.';
    } else if (many) {
      pickHint.textContent = `Щелчок кладёт ${what} на график в синей рамке, с которым вы ` +
        'работали последним. На другой график — кнопка «Добавить тег» в его заголовке.';
    } else {
      pickHint.textContent = state.tab === 'tags'
        ? 'Щелчок кладёт тег на график, повторный щелчок убирает. Стрелки вверх и вниз ' +
          'ходят по списку.'
        : 'Сохранённые скрипты со страницы «Скрипты». Щелчок кладёт результат скрипта на график.';
    }
  }

  async function find() {
    try {
      if (state.tab === 'tags') {
        const data = await get(`/tags?${new URLSearchParams({ q: search.value.trim(), limit: 100 })}`);
        found = data.items;
        for (const t of found) tagInfo.set(t.tag_id, t);
        found.total = data.total;
      } else {
        scriptList = (await get('/scripts')).items;
      }
      drawPicker();
    } catch (error) { fail(error); }
  }

  // Отметка тега: залита — на этом графике, косая черта — на другом
  function mark(key, i = state.active) {
    const here = state.panels[i].items.includes(key);
    const other = !here && allItems().includes(key);
    return el('i', { class: `mark${here ? ' on' : other ? ' other' : ''}`,
      style: here || other ? `--c:${PENS[colorOf(key)]}` : null });
  }

  function pick(key, i, ...content) {
    const on = state.panels[i].items.includes(key);
    return el('button', { class: 'pick', type: 'button', dataset: { key },
      'aria-pressed': String(on), onclick: () => toggle(key, i) }, mark(key, i), ...content);
  }

  const tagLine = (t) => el('span', {}, el('span', { class: 'name' }, t.name),
    t.description ? el('span', { class: 'desc' }, t.description) : null);

  function drawPicker() {
    drawHint();
    keepFocus(results, () => {
      clear(results);
      if (state.tab === 'tags') {
        for (const t of found) results.append(pick(`t:${t.tag_id}`, state.active, tagLine(t)));
        if (!found.length) {
          results.append(el('p', { class: 'muted' }, search.value ? 'Ничего не найдено. ' +
            'Поиск идёт по части имени и по описанию тега.'
            : 'Тегов пока нет: запустите копирование на странице «Копирование».'));
        } else if (found.total > found.length) {
          results.append(el('p', { class: 'muted' },
            `Показаны первые ${count(found.length)} из ${count(found.total)}. Уточните поиск.`));
        }
        return;
      }
      const q = search.value.trim().toLowerCase();
      const list = scriptList.filter((s) => !q || s.name.toLowerCase().includes(q));
      for (const s of list) {
        results.append(pick(`s:${s.script_id}`, state.active, el('span', { class: 'name' }, s.name)));
      }
      if (!list.length) {
        results.append(el('p', { class: 'muted' }, q ? 'Ничего не найдено. ' : 'Скриптов пока нет. ',
          el('a', { href: '#/scripts' }, 'Написать скрипт')));
      }
    });
  }

  function toggle(key, i = state.active) {
    activate(i);
    const panel = state.panels[i];
    if (panel.items.includes(key)) {
      panel.items = panel.items.filter((k) => k !== key);
    } else {
      if (panel.items.length >= MAX_ITEMS) {
        fail(new Error(`На одном графике не больше ${MAX_ITEMS} тегов и скриптов. ` +
          'Начните новый график кнопкой под графиками.'));
        return;
      }
      if (key[0] === 't' && !tagIds().includes(idOf(key)) && tagIds().length >= MAX_TAGS) {
        fail(new Error(`На странице не больше ${MAX_TAGS} тегов. Уберите лишние.`));
        return;
      }
      panel.items = [...panel.items, key];
      colorOf(key);
    }
    itemsChanged();
  }

  // --- «Добавить тег» в заголовке графика ---------------------------------------------
  // Поиск тегов и скриптов прямо в графике: так тег ложится именно туда, куда нужно
  let adder = null;               // { i, box, button, input, list, tags }

  function outside(e) {
    if (adder && !adder.box.contains(e.target) && !adder.button.contains(e.target)) closeAdder();
  }

  function closeAdder(focusBack = false) {
    if (!adder) return;
    const { box, button } = adder;
    adder = null;
    box.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    if (focusBack) button.focus();
  }

  function openAdder(i, button) {
    if (adder && adder.i === i) {
      closeAdder(true);
      return;
    }
    closeAdder();
    activate(i);
    const input = el('input', { type: 'search', placeholder: 'Тег или скрипт: начните вводить',
      'aria-label': `Найти тег или скрипт для графика ${i + 1}` });
    const list = el('div', { class: 'adder-list' });
    const box = el('div', { class: 'adder' }, input, list,
      el('p', { class: 'hint' }, 'Щелчок кладёт на этот график или убирает с него. Esc закрывает.'));
    adder = { i, box, button, input, list, tags: [] };
    views[i].node.insertBefore(box, views[i].legend);
    button.setAttribute('aria-expanded', 'true');
    input.addEventListener('input', debounce(fillAdder, 250));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown') return;
      const first = list.querySelector('.pick');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAdder(true);
      }
    });
    arrowKeys(list, '.pick');
    document.addEventListener('mousedown', outside, true);
    input.focus();
    fillAdder();
  }

  async function fillAdder() {
    const a = adder;
    if (!a) return;
    try {
      const data = await get(`/tags?${new URLSearchParams({ q: a.input.value.trim(), limit: 30 })}`);
      for (const t of data.items) tagInfo.set(t.tag_id, t);
      a.tags = data.items;
    } catch (error) {
      fail(error);
      return;
    }
    if (adder === a) drawAdder();
  }

  function drawAdder() {
    const a = adder;
    if (!a) return;
    const q = a.input.value.trim().toLowerCase();
    const scripts = scriptList.filter((s) => !q || s.name.toLowerCase().includes(q));
    keepFocus(a.list, () => {
      clear(a.list);
      for (const t of a.tags) a.list.append(pick(`t:${t.tag_id}`, a.i, tagLine(t)));
      for (const s of scripts) {
        a.list.append(pick(`s:${s.script_id}`, a.i, el('span', {},
          el('span', { class: 'name' }, s.name), el('span', { class: 'desc' }, 'скрипт'))));
      }
      if (!a.tags.length && !scripts.length) {
        a.list.append(el('p', { class: 'muted' }, 'Ничего не найдено'));
      }
    });
  }

  // --- графики --------------------------------------------------------------------
  function renderPanels() {
    closeAdder();
    for (const v of views) v.destroy();
    views = state.panels.map((panel, i) => {
      const trend = new Trend(panelsBox, {
        title: `График ${i + 1}`,
        fixed: panel.fixed,
        empty: 'Пустой график. Добавьте теги кнопкой «Добавить тег» в заголовке.',
        onActivate: () => activate(i),
        onTimeZoom: (from, to) => zoomTo(from, to),
        onReset: () => goBack(),
        onRemove: (spec) => {
          panel.items = panel.items.filter((k) => k !== spec.item);
          changed();
        },
        onScales: (fixed) => {
          panel.fixed = fixed;
          save();
        },
        live,
      });
      trend.tools.prepend(el('button', { class: 'link', type: 'button', 'aria-expanded': 'false',
        onclick: (e) => openAdder(i, e.currentTarget) }, 'Добавить тег'));
      if (state.panels.length > 1) {
        trend.addTool(el('button', { class: 'link quiet', type: 'button',
          onclick: () => removePanel(i) }, 'Убрать график'));
      }
      trend.setActive(i === state.active, state.panels.length > 1);
      return trend;
    });
    addPanel.disabled = state.panels.length >= MAX_PANELS;
    addPanel.textContent = addPanel.disabled ? `Новый график (не больше ${MAX_PANELS})`
      : 'Новый график';
    if (tagData.size || scriptData.size) draw();
  }

  function activate(i) {
    if (state.active === i) return;
    state.active = i;
    views.forEach((v, k) => v.setActive(k === i, views.length > 1));
    save();
    drawPicker();
  }

  // Слияние и разделение меняют всю раскладку, поэтому их можно отменить
  function undoable(text) {
    const before = { panels: JSON.parse(JSON.stringify(state.panels)), active: state.active };
    return () => toast(text, 'ok', 9000, { label: 'Вернуть как было', run: () => {
      state.panels = before.panels;
      state.active = before.active;
      changed();
    } });
  }

  function newPanel() {
    state.panels.push({ items: [], fixed: {} });
    state.active = state.panels.length - 1;
    changed();
    views[state.active].node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function removePanel(i) {
    const notify = undoable(`График ${i + 1} убран.`);
    state.panels.splice(i, 1);
    state.active = Math.min(state.active > i ? state.active - 1 : state.active,
      state.panels.length - 1);
    changed();
    notify();
  }

  function merge() {
    const items = allItems();
    const notify = undoable(items.length > MAX_ITEMS
      ? `На один график помещается ${MAX_ITEMS} тегов и скриптов, положены первые ${MAX_ITEMS}.`
      : 'Все теги на одном графике.');
    state.panels = [{ items: items.slice(0, MAX_ITEMS), fixed: {} }];
    state.active = 0;
    changed();
    notify();
  }

  function split() {
    const all = allItems();
    const items = all.slice(0, MAX_PANELS);
    const notify = undoable(all.length > MAX_PANELS
      ? `Графиков не больше ${MAX_PANELS}: отдельно положены первые ${MAX_PANELS} тегов.`
      : 'Каждый тег на своём графике.');
    state.panels = items.length ? items.map((k) => ({ items: [k], fixed: {} }))
      : [{ items: [], fixed: {} }];
    state.active = 0;
    changed();
    notify();
  }

  async function load(quiet = false) {
    if (loading) {
      // Период сменился, пока шла прежняя загрузка: повторим сразу после неё
      again = true;
      return;
    }
    loading = true;
    if (!quiet) for (const v of views) v.setLoading(true);
    const [from, to] = period();
    const ids = tagIds();
    const sids = scriptIds();
    try {
      const series = ids.length
        ? get(`/series?${new URLSearchParams({ ids: ids.join(','), from: iso(from), to: iso(to),
          points: 900 })}`)
        : Promise.resolve({ tags: [] });
      // Автообновление пересчитывает скрипты не чаще раза в 30 с: на длинных периодах
      // это заметная работа для приложения
      const fresh = !quiet || Date.now() - scriptsAt > 30000
        || sids.some((id) => !scriptData.has(id));
      const runs = sids.map((id) => (fresh ? post(`/scripts/${id}/run`, {
        from: iso(from), to: iso(to), points: 900, tz: new Date().getTimezoneOffset(),
      }).then((r) => ({ ok: true, r }), (error) => ({ ok: false, error }))
        : Promise.resolve(scriptData.get(id))));
      const [data, ...done] = await Promise.all([series, ...runs]);
      tagData = new Map(data.tags.map((t) => [t.tag_id, t]));
      for (const t of data.tags) tagInfo.set(t.tag_id, t);
      scriptData = new Map(sids.map((id, i) => [id, done[i]]));
      if (fresh) scriptsAt = Date.now();
      state.shown = [from, to];
      draw();
      grafanaLink();
    } catch (error) {
      if (!quiet) fail(error);
      for (const v of views) v.setLoading(false, error.message);
    } finally {
      loading = false;
      if (again) {
        again = false;
        load();
      }
    }
  }

  function scriptName(id) {
    const done = scriptData.get(id);
    if (done && done.ok) return done.r.name;
    const s = scriptList.find((x) => x.script_id === id);
    return s ? s.name : `№ ${id}`;
  }

  function draw() {
    const window = state.shown || period();
    state.panels.forEach((panel, i) => {
      const trend = views[i];
      if (!trend) return;
      const specs = [];
      const notes = [];
      clear(trend.extra);
      for (const key of panel.items) {
        if (key[0] === 't') {
          const tag = tagData.get(idOf(key));
          if (!tag) {
            notes.push({ text: `Тег № ${idOf(key)} не найден в базе`, item: key });
            continue;
          }
          if (tag.datatype === 'string') {
            const last = tag.quality === 0 ? (tag.text ?? '—') : 'плохое качество';
            notes.push({ text: `${tag.name}: ${last} (текстовый тег, изменения под графиком)`,
              item: key, plain: true });
            trend.extra.append(textTable(tag));
            continue;
          }
          const bool = tag.datatype === 'bool';
          const pts = tag.points;
          specs.push({
            key, item: key, label: tag.name,
            title: [tag.description, tag.unit].filter(Boolean).join(', '),
            color: PENS[colorOf(key)], unit: tag.unit || '', bool,
            scale: tag.unit ? `u:${tag.unit}` : `src:${tag.name}`, kind: 'line',
            t: pts.map((p) => p[0]), v: pts.map((p) => (bool ? p[4] : p[1])),
            lo: bool ? null : pts.map((p) => p[2]), hi: bool ? null : pts.map((p) => p[3]),
          });
          continue;
        }
        const done = scriptData.get(idOf(key));
        const name = scriptName(idOf(key));
        if (!done) continue;
        if (!done.ok) {
          notes.push({ text: `Скрипт «${name}»: ${done.error.message}`, item: key });
          continue;
        }
        done.r.outputs.forEach((out, k) => {
          // События (пики) рисуем цветом своего тега. Шкала у ряда из тега та же,
          // что у тега (по единице или по имени тега)
          const base = out.kind === 'events' && out.source && panel.items.find((it) => it[0] === 't'
            && tagData.get(idOf(it)) && tagData.get(idOf(it)).name === out.source);
          specs.push({
            key: `${key}:${k}`, item: key, label: out.name,
            title: `Скрипт «${name}»: ${out.name}`,
            color: PENS[base ? colorOf(base) : (colorOf(key) + k) % PENS.length],
            unit: out.unit || '', bool: out.logical,
            scale: out.unit ? `u:${out.unit}` : out.source ? `src:${out.source}` : `own:${key}:${k}`,
            kind: out.kind === 'events' ? 'events' : 'line', t: out.t, v: out.v, count: out.count,
          });
        });
        if (done.r.text.length) {
          trend.extra.append(el('pre', { class: 'output' },
            done.r.text.map((line) => `${name}: ${line}`).join('\n')));
        }
      }
      trend.update(specs, window, notes);
    });
  }

  function textTable(tag) {
    return el('div', {},
      el('p', { class: 'hint', style: 'margin:8px 0 4px' }, `${tag.name}: изменения за период`),
      tag.changes.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Время'), el('th', {}, 'Значение'))),
          el('tbody', {}, tag.changes.map(([ts, text, q]) => el('tr', {},
            el('td', { class: 'num', style: 'width:190px' }, dateTime(ts)),
            el('td', { class: q ? 'bad-q' : '' }, q ? 'плохое качество' : (text ?? '—')))))))
        : el('p', { class: 'muted' }, 'За этот период изменений нет'));
  }

  // --- период -----------------------------------------------------------------------
  const period = () => spanOf(state);

  function drawPeriod() {
    picker.draw();
    // Кнопка возврата держит место, чтобы панель инструментов не прыгала
    back.disabled = !state.back.length;
    back.classList.toggle('waiting', !state.back.length);
    auto.disabled = state.range === 'custom';
    autoLabel.title = auto.disabled ? 'Свой период заканчивается в прошлом, обновлять нечего' : '';
  }

  function setRange(key) {
    picker.reset();
    state.back = [];
    state.range = key;
    drawPeriod();
    save();
    load();
  }

  function pushBack() {
    state.back.push({ range: state.range, from: state.from, to: state.to });
    if (state.back.length > 30) state.back.shift();
  }

  function zoomTo(from, to) {
    if (!(to - from >= 1)) return;
    picker.reset();
    pushBack();
    state.range = 'custom';
    state.from = from;
    state.to = to;
    drawPeriod();
    save();
    load();
  }

  function goBack() {
    const prev = state.back.pop();
    if (!prev) return;
    picker.reset();
    Object.assign(state, prev);
    drawPeriod();
    save();
    load();
  }

  // --- выгрузка и Grafana -------------------------------------------------------------
  function exportCsv() {
    const ids = tagIds();
    if (!ids.length) {
      fail(new Error('На графиках нет тегов, выгружать нечего'));
      return;
    }
    const [from, to] = period();
    const query = new URLSearchParams({ ids: ids.join(','), from: iso(from), to: iso(to),
      tz: String(new Date().getTimezoneOffset()) });
    const link = el('a', { href: `/api/export?${query}`, download: '' });
    document.body.append(link);
    link.click();
    link.remove();
    toast(`Скачивается CSV: ${plural(ids.length, ['тег', 'тега', 'тегов'])} с ${dateTime(from, false)} по ` +
      `${dateTime(to, false)}. Файл появится в загрузках браузера.`, 'ok');
  }

  function grafanaLink() {
    const query = new URLSearchParams();
    for (const id of tagIds()) {
      const info = tagInfo.get(id);
      if (info) query.append('var-tag', info.name);
    }
    if (state.range === 'custom') {
      query.set('from', String(Math.round(state.from * 1000)));
      query.set('to', String(Math.round(state.to * 1000)));
    } else {
      query.set('from', `now-${state.range}`);
      query.set('to', 'now');
    }
    grafana.href = `${grafanaBase(shared.info)}/d/historian-tags/?${query}`;
  }

  // --- запуск ---------------------------------------------------------------------------
  search.addEventListener('input', debounce(find, 300));
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const first = results.querySelector('.pick');
    if (first) {
      e.preventDefault();
      first.focus();
    }
  });
  arrowKeys(results, '.pick');
  auto.addEventListener('change', save);
  try {
    scriptList = (await get('/scripts')).items;
  } catch { /* список скриптов подтянется при переключении вкладки */ }
  drawPeriod();
  renderPanels();
  setTab(state.tab);
  await load();
  save();
  timer = setInterval(() => {
    if (live() && !document.hidden) load(true);
  }, 5000);
  // Лента пишет: окно времени сдвигается раз в секунду, данные приходят раз в 5 с.
  // Если в системе просят меньше движения, окно сдвигается только вместе с данными
  tick = setInterval(() => {
    if (!live() || calm.matches || document.hidden || !state.shown) return;
    state.shown = period();
    for (const v of views) v.slide(state.shown);
  }, 1000);

  return {
    reuse: () => false,
    destroy() {
      clearInterval(timer);
      clearInterval(tick);
      for (const v of views) v.destroy();
    },
  };
}
