// Страница «Копирование»: идёт ли копирование, лента опросов историка, журнал, теги.

import {
  ago, bytes, clear, confirmDialog, count, dateTime, debounce, el, fail, get, plural, post,
  shared, tagValue, toast, TYPES,
} from './core.js';

const STATE = {
  stopped: ['Копирование остановлено', ''],
  starting: ['Подключение к историку…', 'warn'],
  backfill: ['Загрузка истории', 'warn'],
  live: ['Копирование идёт', 'ok'],
  error: ['Ошибка копирования', 'bad'],
};
const PAGE = 200;
const TAPE_S = 900;             // лента показывает последние 15 минут
const JOURNAL = 12;             // строк журнала до «Показать весь журнал»
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function figure(label) {
  const value = el('div', { class: 'value' }, '—');
  const sub = el('div', { class: 'sub' }, '');
  return { node: el('div', { class: 'fig' }, el('div', { class: 'label' }, label), value, sub),
    value, sub };
}

// Подряд идущие «Загрузка истории: N %» сворачиваем в одну строку с последним процентом
function journalLines(events) {
  const out = [];
  for (const e of events) {
    const progress = e.text.startsWith('Загрузка истории:');
    if (progress && out.length && out[out.length - 1].progress) continue;
    out.push({ ...e, progress });
  }
  return out;
}

export async function loadingPage(view) {
  const f = {
    tags: figure('Тегов копируется'), behind: figure('Отставание от историка'),
    last: figure('Последний опрос'), rows: figure('Строк в базе'), size: figure('Размер базы'),
  };
  const stateText = el('span', { class: 'copy-state' }, 'Получаю состояние…');
  const stateSub = el('span', { class: 'copy-sub' });
  const progress = el('div', { style: 'width:0' });
  const progressBox = el('div', { class: 'progress', hidden: true }, progress);
  const errorBox = el('div', { 'aria-live': 'polite' });
  const btnToggle = el('button', { type: 'button', onclick: () => toggle(), disabled: true },
    'Запустить копирование');
  const tapeBox = el('div', { class: 'tape' });
  // Пока мышь над лентой, она не едет: иначе подсказка у штриха исчезает каждую секунду
  let hovering = false;
  tapeBox.addEventListener('mouseenter', () => { hovering = true; });
  tapeBox.addEventListener('mouseleave', () => { hovering = false; });
  const tapeCaption = el('p', { class: 'tape-caption' });
  const journal = el('ol', { class: 'journal' });
  const journalMore = el('button', { class: 'link', type: 'button', hidden: true,
    onclick: () => { journalAll = !journalAll; drawJournal(); } });

  const search = el('input', { type: 'search', placeholder: 'Поиск по имени или описанию тега',
    'aria-label': 'Поиск тега' });
  const inactive = el('input', { type: 'checkbox' });
  const tbody = el('tbody', {});
  const footer = el('div', { class: 'row', style: 'margin-top:10px' });
  let shown = PAGE;
  let running = false;
  let last = null;              // последний ответ /status
  let offset = 0;               // часы сервера минус часы браузера, с
  let journalAll = false;
  let timer = null;
  let tagTimer = null;
  let tapeTimer = null;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  view.append(
    el('h1', {}, 'Копирование из историка'),
    el('div', { class: 'copy-head' },
      el('div', { class: 'copy-status', 'aria-live': 'polite' }, stateText, stateSub),
      el('span', { class: 'spacer' }),
      btnToggle,
      el('a', { class: 'btn', href: '#/connection' }, 'Настройки подключения')),
    progressBox,
    errorBox,
    tapeBox,
    tapeCaption,
    el('div', { class: 'figures' },
      el('section', { class: 'figgroup' }, el('h2', {}, 'Историк → база'),
        el('div', { class: 'figrow' }, f.tags.node, f.behind.node, f.last.node)),
      el('section', { class: 'figgroup' }, el('h2', {}, 'База приложения'),
        el('div', { class: 'figrow' }, f.rows.node, f.size.node))),
    el('section', { class: 'card' },
      el('h2', {}, 'Журнал'),
      el('p', { class: 'hint' }, 'События копирования, новые сверху. Подробности ошибок есть и ' +
        'в журнале приложения: окно start.bat или docker compose logs app.'),
      journal, journalMore),
    el('section', { class: 'card' },
      el('h2', {}, 'Теги'),
      el('p', { class: 'hint' }, 'Что уже лежит в базе. Имя тега открывает его график.'),
      el('div', { class: 'row', style: 'margin-bottom:10px' },
        el('div', { style: 'flex:1;min-width:220px' }, search),
        el('label', { class: 'check' }, inactive, 'показать и теги, которые больше не подходят под маски')),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Тег'), el('th', {}, 'Тип'), el('th', {}, 'Последнее значение'),
          el('th', { class: 'num' }, 'Время значения'), el('th', { class: 'num' }, 'Строк в базе'),
          el('th', { class: 'num' }, 'Скопировано до'))),
        tbody)),
      footer),
    el('details', { class: 'card maint' },
      el('summary', {}, 'Обслуживание'),
      el('p', { class: 'hint' }, 'Удаляет все скопированные значения из базы приложения и ' +
        'загружает историю заново за период из настроек. В историке ничего не меняется. Это ' +
        'нужно, например, если вы увеличили глубину истории.'),
      el('button', { class: 'danger', type: 'button', onclick: () => reset() },
        'Удалить скопированное и загрузить заново')),
  );

  // --- лента опросов: каждый опрос — штрих пера, высота — сколько строк забрано ----
  function drawTape() {
    if (!last) return;
    const c = last.copy;
    const now = Date.now() / 1000 + offset;
    const from = now - TAPE_S;
    const cycles = (c.cycles || []).filter((x) => x.ts >= from);
    const w = Math.max(tapeBox.clientWidth - 2, 300);
    const top = 8;
    const bottom = 82;
    const plot = bottom - top;
    const x = (t) => ((t - from) / TAPE_S) * w;
    const most = Math.max(10, ...cycles.map((k) => k.rows || 0));
    const errors = cycles.filter((k) => k.error).length;

    const grid = svg('g', { class: 'tape-grid' });
    for (let s = 0; s <= TAPE_S; s += 60) {
      // Сетка привязана к минутам, поэтому едет вместе с лентой
      const t = Math.ceil(from / 60) * 60 + s;
      if (t > now) break;
      const major = Math.round(t / 60) % 5 === 0;
      grid.append(svg('line', { x1: x(t), x2: x(t), y1: top, y2: bottom,
        class: major ? 'major' : 'minor' }));
    }
    for (let k = 0; k <= 5; k += 1) {
      const y = top + (plot * k) / 5;
      grid.append(svg('line', { x1: 0, x2: w, y1: y, y2: y,
        class: k === 0 || k === 5 ? 'major' : 'minor' }));
    }

    const marks = svg('g', {});
    for (const k of cycles) {
      const at = x(k.ts);
      if (k.error) {
        marks.append(svg('line', { x1: at, x2: at, y1: top, y2: bottom, class: 'tape-error' },
          svg('title', {}, document.createTextNode(`${dateTime(k.ts)} — ошибка опроса`))));
        continue;
      }
      const h = Math.max(3, (Math.log1p(k.rows) / Math.log1p(most)) * plot);
      marks.append(svg('line', { x1: at, x2: at, y1: bottom, y2: bottom - h, class: 'tape-mark' },
        svg('title', {}, document.createTextNode(`${dateTime(k.ts)} — ` +
          `${plural(k.rows, ['строка', 'строки', 'строк'])}, ` +
          `опрос длился ${k.s.toLocaleString('ru-RU')} с`))));
    }

    const labels = svg('g', { class: 'tape-labels' });
    for (const [s, text] of [[TAPE_S, '15 мин назад'], [600, '10 мин назад'], [300, '5 мин назад']]) {
      labels.append(svg('text', { x: x(now - s) + (s === TAPE_S ? 2 : 0), y: 98,
        'text-anchor': s === TAPE_S ? 'start' : 'middle' }, document.createTextNode(text)));
    }
    labels.append(svg('text', { x: w - 2, y: 98, 'text-anchor': 'end' },
      document.createTextNode('сейчас')));
    labels.append(svg('text', { x: 4, y: top + 12, class: 'tape-scale' },
      document.createTextNode(`до ${count(most)} строк за опрос`)));

    const pen = c.running ? svg('g', { class: 'tape-pen' },
      svg('line', { x1: w - 1, x2: w - 1, y1: top, y2: bottom }),
      svg('circle', { cx: w - 1, cy: bottom, r: 3.5 })) : svg('g', {});

    const summary = cycles.length
      ? `Лента опросов за 15 минут: ${plural(cycles.length, ['опрос', 'опроса', 'опросов'])}, ` +
        `ошибок: ${count(errors)}` +
        (c.last_sync_at ? `, последний ${ago(now - c.last_sync_at)} назад` : '')
      : 'За последние 15 минут опросов не было';
    clear(tapeBox).append(svg('svg', { width: w, height: 104, viewBox: `0 0 ${w} 104`,
      role: 'img', 'aria-label': summary }, grid, marks, pen, labels));
    if (!cycles.length) {
      tapeBox.append(el('p', { class: 'tape-empty' }, c.running
        ? 'Первый опрос историка ещё идёт'
        : 'Копирование не идёт: за последние 15 минут опросов не было'));
    }
    tapeCaption.textContent = cycles.length
      ? 'Каждый штрих означает один опрос историка, а его высота показывает, сколько строк он ' +
        `забрал. Наведите мышь на штрих, чтобы увидеть подробности.${errors
        ? ` Красная пунктирная черта отмечает опрос с ошибкой, таких за 15 минут: ${count(errors)}.`
        : ''}`
      : '';
  }

  // --- состояние ----------------------------------------------------------------
  async function refresh() {
    let status;
    try {
      status = await get('/status');
    } catch (error) {
      clear(errorBox).append(el('div', { class: 'note bad' }, error.message));
      return;
    }
    last = status;
    const c = status.copy;
    const db = status.db;
    if (c.now) offset = c.now - Date.now() / 1000;
    const now = Date.now() / 1000 + offset;
    running = c.running;
    const [text, kind] = STATE[c.state] || [c.state, ''];
    const pct = Math.round((c.progress || 0) * 100);
    stateText.textContent = text;
    stateText.className = `copy-state ${kind}`;
    stateSub.textContent = {
      live: `новые значения раз в ${c.poll_s} с, ${c.behind_s < 1 ? 'без отставания'
        : `отставание ${ago(c.behind_s)}`}`,
      backfill: `${pct} %: осталось догрузить ${ago(c.behind_s)} истории. Страницу можно закрыть, ` +
        'загрузка продолжится',
      starting: 'соединяюсь с историком',
      error: 'приложение повторит попытку само',
      stopped: db.rows ? 'нажмите «Запустить копирование», чтобы продолжить' : '',
    }[c.state] || '';
    progressBox.hidden = c.state !== 'backfill';
    progress.style.width = `${pct}%`;

    f.tags.value.textContent = count(c.running ? c.tags : db.tags_active);
    f.tags.sub.textContent = `в справочнике всего: ${count(db.tags_total)}`;
    f.behind.value.textContent = !c.running || c.behind_s === null ? '—'
      : c.behind_s < 1 ? 'нет' : ago(c.behind_s);
    f.behind.sub.textContent = db.synced_newest ? `скопировано до ${dateTime(db.synced_newest)}` : '';
    f.last.value.textContent = c.last_sync_at ? `${ago(now - c.last_sync_at)} назад` : '—';
    f.last.sub.textContent = c.cycle_s !== null && c.cycle_s !== undefined
      ? `опрос длился ${c.cycle_s.toLocaleString('ru-RU')} с` : '';
    f.rows.value.textContent = count(db.rows);
    // Перекрытие перечитывается при каждом опросе, поэтому прочитано больше, чем лежит
    f.rows.sub.textContent = c.running && c.rows_copied
      ? `с запуска прочитано ${count(c.rows_copied)}, перекрытие читается повторно` : '';
    f.size.value.textContent = bytes(db.db_bytes);
    f.size.sub.textContent = db.timescale ? 'TimescaleDB, старое сжимается' : 'PostgreSQL';

    clear(errorBox);
    if (c.last_error) {
      errorBox.append(el('div', { class: 'note bad' }, el('b', {}, 'Ошибка: '), c.last_error));
    } else if (!c.running && !db.rows) {
      errorBox.append(el('div', { class: 'note warn' }, 'Копирование не запущено. Настройте ' +
        'подключение и нажмите «Сохранить и начать копирование». ',
      el('a', { href: '#/connection' }, 'Перейти к подключению')));
    }

    btnToggle.disabled = false;
    btnToggle.textContent = running ? 'Остановить копирование' : 'Запустить копирование';
    btnToggle.className = running ? '' : 'primary';
    drawJournal();
    if (!hovering) drawTape();
  }

  function drawJournal() {
    const lines = last ? journalLines(last.copy.events) : [];
    clear(journal).append(...(lines.length
      ? (journalAll ? lines : lines.slice(0, JOURNAL)).map((e) => el('li', { class: e.level },
        el('time', {}, dateTime(e.ts)), el('span', {}, e.text)))
      : [el('li', {}, el('time', {}, ''), el('span', { class: 'muted' }, 'событий пока нет'))]));
    journalMore.hidden = lines.length <= JOURNAL;
    journalMore.textContent = journalAll ? 'Свернуть журнал'
      : `Показать весь журнал (${count(lines.length)})`;
  }

  async function loadTags() {
    try {
      const params = new URLSearchParams({ q: search.value.trim(), limit: shown,
        inactive: inactive.checked ? 'true' : 'false' });
      const data = await get(`/tags?${params}`);
      clear(tbody);
      for (const t of data.items) {
        const href = `#/charts?ids=${t.tag_id}`;
        tbody.append(el('tr', { class: 'link', onclick: (e) => {
          if (!e.target.closest('a')) location.hash = href;
        } },
        el('td', {}, el('a', { class: 'mono tag-link', href, title: 'Открыть график тега' }, t.name),
          t.active ? null : el('span', { class: 'badge', style: 'margin-left:6px' }, 'не копируется'),
          t.description ? el('span', { class: 'desc' }, t.description) : null),
        el('td', {}, TYPES[t.datatype] || t.datatype),
        el('td', { class: t.quality ? 'bad-q' : '' }, tagValue(t)),
        el('td', { class: 'num' }, dateTime(t.ts)),
        el('td', { class: 'num' }, count(t.rows)),
        el('td', { class: 'num' }, dateTime(t.synced_until))));
      }
      if (!data.items.length) {
        tbody.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' },
          search.value ? 'Ничего не найдено' : 'Тегов пока нет. Они появятся после первого ' +
            'опроса историка')));
      }
      clear(footer).append(el('span', { class: 'muted' },
        `Показано ${count(data.items.length)} из ${count(data.total)}`));
      if (data.total > data.items.length) {
        footer.append(el('button', { class: 'small', type: 'button', onclick: () => {
          shown += PAGE * 5;
          loadTags();
        } }, 'Показать ещё'));
      }
    } catch (error) { fail(error); }
  }

  async function toggle() {
    try {
      btnToggle.disabled = true;
      if (running) {
        await post('/copy/stop');
        toast('Копирование остановлено', 'ok');
      } else {
        await post('/copy/start');
        toast('Копирование запущено', 'ok');
      }
    } catch (error) { fail(error); } finally { btnToggle.disabled = false; }
    refresh();
  }

  async function reset() {
    let hours = shared.settings ? shared.settings.history_hours : null;
    try {
      shared.settings = await get('/settings');
      hours = shared.settings.history_hours;
    } catch { /* останутся прежние настройки */ }
    const rows = last ? last.db.rows : 0;
    const next = !running
      ? 'Копирование сейчас остановлено: история загрузится, когда вы его запустите.'
      : hours > 0
        ? `Затем копирование заново загрузит историю за ${count(hours)} ч. Это может занять время.`
        : 'Затем копирование будет забирать только новые значения: глубина истории в настройках 0 ч.';
    const ok = await confirmDialog('Удалить скопированное и загрузить заново?',
      [el('p', {}, `Из базы приложения будет удалено ${plural(rows, ['строка', 'строки', 'строк'])}. ` +
        'В историке ничего не меняется.'), el('p', {}, next)],
      'Удалить и загрузить заново');
    if (!ok) return;
    try {
      await post('/copy/reset');
      toast('Значения удалены, загрузка началась заново', 'ok');
    } catch (error) { fail(error); }
    refresh();
    loadTags();
  }

  const reload = debounce(() => { shown = PAGE; loadTags(); }, 400);
  search.addEventListener('input', reload);
  inactive.addEventListener('change', reload);
  const resize = new ResizeObserver(() => drawTape());
  resize.observe(tapeBox);

  await refresh();
  await loadTags();
  timer = setInterval(refresh, 3000);
  tagTimer = setInterval(() => { if (document.activeElement !== search) loadTags(); }, 10000);
  // Лента едет раз в секунду; если в системе просят меньше движения, только с данными
  tapeTimer = setInterval(() => {
    if (running && !calm.matches && !document.hidden && !hovering) drawTape();
  }, 1000);
  return {
    destroy() {
      clearInterval(timer);
      clearInterval(tagTimer);
      clearInterval(tapeTimer);
      resize.disconnect();
    },
  };
}
