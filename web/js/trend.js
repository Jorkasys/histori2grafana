// Панель-«самописец» на uPlot: несколько рядов на одной сетке, у каждой единицы
// измерения своя шкала. Если протянуть мышью по горизонтали, выбирается время
// (страница загрузит этот период подробнее), по вертикали диапазон значений,
// рамкой и то и другое. Двойной щелчок возвращает масштаб.

import { clear, dateTime, el, icon, keepFocus, num, recall, remember } from './core.js';
import { metricCards } from './metrics.js';

export const PENS = ['#1f5aa6', '#c0392b', '#2e7d32', '#7b3fa0', '#b26a00', '#00838f',
  '#6d4c41', '#546e7a'];
export const HEIGHTS = { low: 170, normal: 260, high: 420 };
const DRAWS = [['steps', 'ступени'], ['line', 'линия'], ['points', 'точки']];
const WIDTHS = [[1, 'тонкая'], [1.6, 'обычная'], [2.6, 'толстая']];
const LOOKS = 'looks';
const AXIS = '#5f6b77';
const GRID = '#d6e0dc';
const MINOR = '#edf2f0';
const FONT = '12px Bahnschrift, "Segoe UI", Arial, sans-serif';

// Подписи оси времени по-русски, 24 часа: на коротких периодах с секундами,
// на длинных с датой
export function timeTicks(_u, splits) {
  const span = splits.length > 1 ? splits[splits.length - 1] - splits[0] : 0;
  return splits.map((v) => {
    const d = new Date(v * 1000);
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit',
      second: span < 600 ? '2-digit' : undefined });
    if (span < 86400 * 1.5) return time;
    const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    return d.getHours() || d.getMinutes() ? `${day} ${time}` : day;
  });
}

function valueTicks(_u, splits) {
  const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1;
  // Знаков после запятой столько, чтобы шаг делений записался точно (для 2,5 нужен 1)
  let digits = 0;
  while (step && digits < 6 && Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits))
    > 1e-6 * 10 ** digits) digits += 1;
  return splits.map((v) => v.toLocaleString('ru-RU', {
    minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

function axisSize(u, values) {
  const longest = Math.max(0, ...(values || []).map((v) => String(v).length));
  return Math.max(36, longest * 7 + 16);
}

function autoRange(min, max) {
  if (min === null || max === null || min === undefined || max === undefined) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.06;
  return [min - pad, max + pad];
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Общая ось времени для рядов с разными моментами. undefined значит, что у ряда в
// этот момент точки нет и линия идёт дальше, null значит разрыв в самих данных
function align(specs) {
  const moments = new Set();
  for (const s of specs) for (const t of s.t) moments.add(t);
  const xs = Array.from(moments).sort((a, b) => a - b);
  const index = new Map(xs.map((t, i) => [t, i]));
  const place = (t, v) => {
    const col = new Array(xs.length).fill(undefined);
    for (let i = 0; i < t.length; i += 1) col[index.get(t[i])] = v[i] === undefined ? null : v[i];
    return col;
  };
  const data = [xs];
  for (const s of specs) {
    data.push(place(s.t, s.v));
    if (s.lo) {
      data.push(place(s.t, s.hi));
      data.push(place(s.t, s.lo));
    }
  }
  return data;
}

// Вид ряда один на все графики обеих страниц, как и цвет тега
const allLooks = () => recall(LOOKS, {});

function saveLook(key, patch) {
  const all = allLooks();
  if (patch) all[key] = { ...all[key], ...patch };
  else delete all[key];
  remember(LOOKS, all);
}

// Скрипт сохранили: вид его рядов переходит к сохранённому скрипту
export function moveLooks(from, to) {
  const all = allLooks();
  for (const key of Object.keys(all).filter((k) => k.startsWith(from))) {
    all[to + key.slice(from.length)] = all[key];
    delete all[key];
  }
  remember(LOOKS, all);
}

// Ряд с настройками вида. Перья по умолчанию: непрерывный ряд — ступени, события — точки
function styled(s, window) {
  const look = allLooks()[s.look || s.key] || {};
  const draw = look.draw || (s.kind === 'events' ? 'points' : 'steps');
  const out = { ...s, look: s.look || s.key, draw, width: look.width || 1.6, fill: !!look.fill,
    colorSet: look.color !== undefined, canBand: !!s.lo };
  if (out.colorSet) out.color = PENS[look.color % PENS.length];
  if (draw === 'points' || look.band === false) {
    out.lo = null;
    out.hi = null;
  }
  // События линией: значение держится до следующего, последнее до конца ряда
  if (s.kind === 'events' && draw !== 'points') {
    const kept = s.t.map((t, i) => [t, s.v[i]]).filter((p) => p[1] !== null && p[1] !== undefined);
    if (draw === 'steps' && kept.length) {
      const end = Math.min(s.end ?? window[1], window[1]);
      if (end > kept[kept.length - 1][0]) kept.push([end, kept[kept.length - 1][1]]);
    }
    out.t = kept.map((p) => p[0]);
    out.v = kept.map((p) => p[1]);
  }
  return out;
}

function value(v, spec) {
  if (spec.bool) return v > 0 ? '1 (вкл)' : '0 (выкл)';
  return spec.unit ? `${num(v)} ${spec.unit}` : num(v);
}

export class Trend {
  /**
   * opts: { title, height, sync, empty, fixed, live() — лента пишет до «сейчас»,
   *         onTimeZoom(from, to), onReset(), onRemove(spec), onScales(fixed), onActivate(),
   *         onLook() — изменился вид рядов, onHeight(имя) — изменилась высота графика }
   *
   * Ряды (update): { key, label, title, color, unit, scale, kind: 'line' | 'events',
   *                  bool, t: [...], v: [...], lo?, hi? (полоса мин–макс), count?,
   *                  look? — ключ настроек вида, если он не совпадает с key, end? — конец ряда }
   */
  constructor(host, opts = {}) {
    this.opts = { height: 260, sync: 'h2g', empty: 'Нет данных', ...opts };
    this.fixed = { ...(opts.fixed || {}) };
    this.hidden = new Set();
    this.specs = [];
    this.notes = [];
    this.items = [];
    this.window = null;
    this.plot = null;
    this.signature = '';
    this.scaleKeys = [];

    this.title = el('button', { class: 'trend-title', type: 'button',
      title: 'Теги из списка слева будут ложиться на этот график',
      onclick: () => this.opts.onActivate && this.opts.onActivate() }, opts.title || '');
    this.spin = el('span', { class: 'spinner', hidden: true, role: 'status',
      'aria-label': 'Загружаю значения' });
    this.time = el('span', { class: 'trend-time' });
    this.scalesButton = el('button', { class: 'link', type: 'button', 'aria-expanded': 'false',
      onclick: () => this.toggleScales() }, 'Шкала');
    this.looksButton = el('button', { class: 'link', type: 'button', 'aria-expanded': 'false',
      onclick: () => this.toggleLooks() }, 'Вид');
    this.tools = el('span', { class: 'trend-tools' }, this.looksButton, this.scalesButton);
    this.legend = el('div', { class: 'legend' });
    this.scalesBox = el('div', { class: 'scales', hidden: true });
    this.looksBox = el('div', { class: 'scales looks', hidden: true });
    this.body = el('div', { class: 'trend-body', role: 'img' });
    this.extra = el('div', { class: 'texts' });
    this.metricsBox = el('div', {});
    this.node = el('section', { class: 'trend' },
      el('div', { class: 'trend-head' }, this.title, this.spin, this.time, this.tools),
      this.legend, this.looksBox, this.scalesBox, this.metricsBox, this.body, this.extra);
    this.node.addEventListener('mousedown', () => this.opts.onActivate && this.opts.onActivate());
    host.append(this.node);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.body);
  }

  addTool(node) {
    this.tools.append(node);
  }

  setTitle(text) {
    this.title.textContent = text;
  }

  // Последний график, с которым работали, в синей рамке: на него кладёт список слева
  setActive(active, many) {
    this.node.classList.toggle('active', active && many);
  }

  // error: загрузка не удалась — пишем причину на месте графика, если рисовать нечего
  setLoading(on, error = null) {
    this.spin.hidden = !on;
    if (error) {
      clear(this.metricsBox);
      this.metrics = [];
      this.body.hidden = false;
    }
    if (this.plot) return;
    if (on) clear(this.body).append(el('div', { class: 'trend-empty' }, 'Загружаю значения…'));
    else if (error) {
      clear(this.body).append(el('div', { class: 'trend-empty bad' },
        `Значения не загрузились: ${error}`));
    }
  }

  // Живая лента: окно времени едет, данные те же
  slide(window) {
    this.window = window;
    if (this.plot) this.plot.setScale('x', { min: window[0], max: window[1] });
  }

  // --- данные -------------------------------------------------------------------
  update(specs, window, notes = [], metrics = []) {
    this.metrics = metrics;
    this.window = window;
    this.raw = specs;
    this.specs = specs.map((s) => styled(s, window));
    this.notes = notes;
    this.scaleKeys = [];
    for (const s of this.specs) if (!this.scaleKeys.includes(s.scale)) this.scaleKeys.push(s.scale);
    this.spin.hidden = true;
    const stat = this.opts.mode === 'stat';
    this.looksButton.hidden = stat;
    this.scalesButton.hidden = stat;
    if (stat) {
      this.looksBox.hidden = true;
      this.scalesBox.hidden = true;
    }
    clear(this.metricsBox);
    const cards = [...metrics];
    if (stat) {
      for (const s of specs) {
        const value = s.v.findLast((v) => v !== null && v !== undefined);
        cards.push({ name: s.label, value: value ?? null, unit: s.unit, item: s.item });
      }
    }
    if (cards.length) this.metricsBox.append(metricCards(cards, this.opts.onRemove));
    this.body.hidden = stat || (!specs.length && cards.length > 0);
    if (stat) {
      if (this.plot) this.plot.destroy();
      this.plot = null;
      this.signature = '';
      this.renderLegend();
      if (!cards.length) this.metricsBox.append(el('p', { class: 'muted' }, this.opts.empty));
      return;
    }
    // Для экранного диктора: что нарисовано и за какой период
    this.body.setAttribute('aria-label', specs.length
      ? `${this.title.textContent || 'График'}: ${specs.map((s) => s.label).join(', ')}; ` +
        `с ${dateTime(window[0], false)} по ${dateTime(window[1], false)}`
      : this.opts.empty);
    if (!specs.length) {
      if (this.plot) this.plot.destroy();
      this.plot = null;
      this.signature = '';
      clear(this.body).append(el('div', { class: 'trend-empty' }, this.opts.empty));
      this.renderLegend();
      this.drawLooksIfIdle();
      return;
    }
    const data = align(this.specs);
    const signature = this.specs.map((s) => [s.key, s.scale, s.draw, s.width, s.fill, s.lo ? 1 : 0,
      s.color].join('|')).join(';');
    if (this.plot && signature === this.signature) {
      this.plot.setData(data);
    } else {
      this.signature = signature;
      this.build(data);
    }
    this.renderLegend();
    // Пока в «Шкале» что-то вводят, автообновление её не перерисовывает: ввод не пропадает
    if (!this.scalesBox.hidden && !this.scalesBox.contains(document.activeElement)) {
      this.renderScales();
    }
    this.drawLooksIfIdle();
  }

  // Шкала только из дискретных тегов: у неё всегда 0 и 1, масштабировать её незачем
  isBool(key) {
    return this.specs.filter((s) => s.scale === key).every((s) => s.bool);
  }

  build(data) {
    if (this.plot) this.plot.destroy();
    clear(this.body);
    const paths = { steps: uPlot.paths.stepped({ align: 1 }), line: uPlot.paths.linear() };
    const several = this.scaleKeys.length > 1;
    const scales = {
      x: { time: true, range: (_u, min, max) => (this.window ? [...this.window] : [min, max]) },
    };
    const axes = [{
      scale: 'x', stroke: AXIS, font: FONT, size: 30, space: 70, values: timeTicks,
      grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1, size: 4 },
    }];
    this.scaleKeys.forEach((key, i) => {
      const first = this.specs.find((s) => s.scale === key);
      // Дискретный тег: только 0 и 1, без делений 0,5
      const bool = this.isBool(key);
      scales[key] = {
        range: (_u, min, max) => (this.fixed[key] ? [...this.fixed[key]]
          : bool ? [-0.25, 1.25] : autoRange(min, max)),
      };
      const axis = {
        scale: key, side: i % 2 ? 1 : 3, font: FONT, values: valueTicks, size: axisSize,
        stroke: several ? first.color : AXIS,
        grid: { show: i === 0, stroke: GRID, width: 1 },
        ticks: { stroke: GRID, width: 1, size: 4 },
      };
      if (bool) {
        axis.splits = () => [0, 1];
        axis.values = (_u, splits) => splits.map(String);
      }
      axes.push(axis);
    });
    const series = [{}];
    const bands = [];
    this.index = [];
    for (const s of this.specs) {
      const idx = series.length;
      const show = !this.hidden.has(s.key);
      this.index.push(idx);
      if (s.draw === 'points') {
        series.push({ label: s.label, scale: s.scale, show, stroke: s.color, width: 1,
          paths: () => null,
          points: { show: true, size: 5 + s.width * 2, width: 1.6, stroke: s.color,
            fill: s.fill ? s.color : '#ffffff' } });
        continue;
      }
      series.push({ label: s.label, scale: s.scale, show, stroke: s.color, width: s.width,
        fill: s.fill ? rgba(s.color, 0.16) : undefined,
        spanGaps: false, paths: paths[s.draw], points: { show: false } });
      if (s.lo) {
        for (let k = 0; k < 2; k += 1) {
          series.push({ scale: s.scale, show, stroke: 'rgba(0,0,0,0)', width: 1, paths: paths[s.draw],
            points: { show: false } });
        }
        bands.push({ series: [idx + 1, idx + 2], fill: rgba(s.color, 0.13) });
      }
    }
    this.plot = new uPlot({
      width: this.width(),
      height: this.opts.height,
      // Если справа нет шкалы, оставляем место под последнюю подпись времени
      padding: [10, this.scaleKeys.length > 1 ? 6 : 22, 0, 2],
      legend: { show: false },
      scales,
      axes,
      series,
      bands,
      cursor: {
        sync: { key: this.opts.sync },
        drag: { x: true, y: true, uni: 16, setScale: false },
        points: { size: 6 },
        bind: { dblclick: () => () => { this.resetZoom(); return null; } },
      },
      hooks: {
        setSelect: [(u) => this.onSelect(u)],
        setCursor: [(u) => this.showValues(u.cursor.idx)],
        drawAxes: [(u) => this.drawMinor(u)],
        draw: [(u) => this.drawPens(u)],
      },
    }, data, this.body);
  }

  // --- масштаб --------------------------------------------------------------------
  onSelect(u) {
    const s = u.select;
    const w = u.over.clientWidth;
    const h = u.over.clientHeight;
    const xZoom = s.width > 3 && s.width < w - 1;
    const yZoom = s.height > 3 && s.height < h - 1;
    if (!xZoom && !yZoom) return;
    if (yZoom) {
      for (const key of this.scaleKeys) {
        if (this.isBool(key)) continue;
        const hi = u.posToVal(s.top, key);
        const lo = u.posToVal(s.top + s.height, key);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) this.fixed[key] = [lo, hi];
      }
    }
    const from = u.posToVal(s.left, 'x');
    const to = u.posToVal(s.left + s.width, 'x');
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (yZoom) this.scalesChanged();
    if (xZoom && this.opts.onTimeZoom) this.opts.onTimeZoom(from, to);
  }

  scalesChanged() {
    if (this.plot) this.plot.setData(this.plot.data, true);
    if (!this.scalesBox.hidden) this.renderScales();
    if (this.opts.onScales) this.opts.onScales({ ...this.fixed });
  }

  resetZoom() {
    this.fixed = {};
    this.scalesChanged();
    if (this.opts.onReset) this.opts.onReset();
  }

  toggleScales() {
    this.scalesBox.hidden = !this.scalesBox.hidden;
    this.scalesButton.setAttribute('aria-expanded', String(!this.scalesBox.hidden));
    if (!this.scalesBox.hidden) this.renderScales();
  }

  renderScales() {
    clear(this.scalesBox);
    if (!this.scaleKeys.length) {
      this.scalesBox.append(el('span', { class: 'muted' }, 'Добавьте теги, и здесь появятся их шкалы.'));
      return;
    }
    const parse = (text) => {
      const v = parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(v) ? v : null;
    };
    for (const key of this.scaleKeys) {
      const first = this.specs.find((s) => s.scale === key);
      const current = this.plot ? this.plot.scales[key] : {};
      const fixed = this.fixed[key];
      const name = first.unit || first.label;
      const lo = el('input', { inputmode: 'decimal', value: fixed ? num(fixed[0]) : '',
        placeholder: 'авто', 'aria-label': `${name}: от` });
      const hi = el('input', { inputmode: 'decimal', value: fixed ? num(fixed[1]) : '',
        placeholder: 'авто', 'aria-label': `${name}: до` });
      // Текущий автоматический диапазон пишем текстом: в подсказке поля его плохо видно
      const now = !fixed && !this.isBool(key) && current && Number.isFinite(current.min)
        && Number.isFinite(current.max)
        ? el('span', { class: 'muted' }, `сейчас ${num(current.min)} … ${num(current.max)}`) : null;
      const apply = () => {
        const a = parse(lo.value);
        const b = parse(hi.value);
        if (a === null && b === null) delete this.fixed[key];
        else if (a !== null && b !== null && b > a) this.fixed[key] = [a, b];
        else return;
        this.scalesChanged();
      };
      for (const input of [lo, hi]) {
        input.addEventListener('change', apply);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
      }
      this.scalesBox.append(el('div', { class: 'scale-row' },
        el('span', { class: 'scale-name', style: `--c:${first.color}` }, name),
        el('span', { class: 'muted' }, 'от'), lo, el('span', { class: 'muted' }, 'до'), hi, now));
    }
    this.scalesBox.append(
      el('button', { class: 'small', type: 'button', onclick: () => {
        this.fixed = {};
        this.scalesChanged();
      } }, 'Все шкалы автоматически'),
      el('span', { class: 'muted', style: 'flex-basis:100%' }, 'Пустые поля подбираются ' +
        'автоматически. Мышью тоже можно: протяните по графику вверх или вниз, чтобы задать ' +
        'шкалу значений, влево или вправо для времени, по диагонали для того и другого. Двойной ' +
        'щелчок возвращает как было.'));
  }

  // --- вид рядов ------------------------------------------------------------------
  toggleLooks() {
    this.looksBox.hidden = !this.looksBox.hidden;
    this.looksButton.setAttribute('aria-expanded', String(!this.looksBox.hidden));
    if (!this.looksBox.hidden) this.renderLooks();
  }

  // Пока в «Виде» открыт список, автообновление его не перерисовывает: список бы закрылся
  drawLooksIfIdle() {
    if (!this.looksBox.hidden && !this.looksBox.contains(document.activeElement)) this.renderLooks();
  }

  setLook(spec, patch) {
    saveLook(spec.look, patch);
    if (this.opts.onLook) this.opts.onLook();
    else this.update(this.raw, this.window, this.notes, this.metrics);
    keepFocus(this.looksBox, () => this.renderLooks());
  }

  setHeight(name) {
    this.opts.height = HEIGHTS[name] || HEIGHTS.normal;
    this.resize();
    if (this.opts.onHeight) this.opts.onHeight(name);
  }

  // Вид рядов для дашборда в Grafana. Цвет передаём, только если его выбрали: перья страницы
  // рассчитаны на белый фон, а у Grafana свои цвета под тёмную тему
  describeLooks() {
    return this.specs.map((s) => ({ name: s.label, draw: s.draw, width: s.width, fill: s.fill,
      bool: !!s.bool, color: s.colorSet ? s.color : null }));
  }

  renderLooks() {
    clear(this.looksBox);
    if (!this.specs.length) {
      this.looksBox.append(el('span', { class: 'muted' }, 'Добавьте теги, и здесь появится их вид.'));
      return;
    }
    const choice = (label, key, items, current, change) => {
      const node = el('select', { 'aria-label': label, dataset: { key },
        onchange: (e) => change(e.target.value) },
      items.map(([v, text]) => el('option', { value: String(v) }, text)));
      node.value = String(current);
      return node;
    };
    const flag = (text, key, on, change) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: on, dataset: { key },
        onchange: (e) => change(e.target.checked) }), text);
    for (const s of this.specs) {
      this.looksBox.append(el('div', { class: 'scale-row' },
        el('span', { class: 'scale-name look-name', style: `--c:${s.color}`, title: s.title || s.label },
          s.label),
        choice(`${s.label}: как рисовать`, `${s.key}:draw`, DRAWS, s.draw,
          (v) => this.setLook(s, { draw: v })),
        el('span', { class: 'muted' }, s.draw === 'points' ? 'размер' : 'линия'),
        choice(`${s.label}: толщина`, `${s.key}:width`, WIDTHS, s.width,
          (v) => this.setLook(s, { width: Number(v) })),
        el('span', { class: 'swatches', role: 'group', 'aria-label': `${s.label}: цвет` },
          PENS.map((c, k) => el('button', { class: `swatch${c === s.color ? ' on' : ''}`, type: 'button',
            style: `--c:${c}`, 'aria-label': `Цвет ${k + 1}`, 'aria-pressed': String(c === s.color),
            dataset: { key: `${s.key}:c${k}` }, onclick: () => this.setLook(s, { color: k }) }))),
        flag('заливка', `${s.key}:fill`, s.fill, (on) => this.setLook(s, { fill: on })),
        s.canBand && s.draw !== 'points'
          ? flag('полоса мин–макс', `${s.key}:band`, !!s.lo, (on) => this.setLook(s, { band: on }))
          : null));
    }
    this.looksBox.append(
      this.opts.onHeight ? el('label', { class: 'scale-row' }, el('span', { class: 'muted' }, 'Высота графика'),
        choice('Высота графика', 'height', [['low', 'низкий'], ['normal', 'обычный'], ['high', 'высокий']],
          Object.keys(HEIGHTS).find((k) => HEIGHTS[k] === this.opts.height) || 'normal',
          (v) => this.setHeight(v))) : null,
      el('button', { class: 'small', type: 'button', dataset: { key: 'reset' }, onclick: () => {
        for (const s of this.specs) saveLook(s.look, null);
        this.setLook({ look: '' }, null);
      } }, 'Вид по умолчанию'));
  }

  // --- легенда --------------------------------------------------------------------
  renderLegend() {
    clear(this.legend);
    this.items = [];
    this.specs.forEach((s, i) => {
      if (this.opts.mode === 'stat') return;
      const val = el('span', { class: 'lg-val' });
      const item = el('span', { class: `lg${this.hidden.has(s.key) ? ' off' : ''}`,
        style: `--c:${s.color}` },
      el('i', { class: `lg-mark${s.draw === 'points' ? ' dot' : ''}` }),
      el('button', { class: 'lg-name', type: 'button', 'aria-pressed': String(!this.hidden.has(s.key)),
        title: `${s.title || s.label}\nЩелчок скрывает или показывает ряд`,
        onclick: () => this.toggle(i) }, s.label),
      val,
      this.opts.onRemove && s.removable !== false
        ? el('button', { class: 'lg-remove', type: 'button', title: 'Убрать с графика',
          'aria-label': `Убрать ${s.label} с графика`, onclick: () => this.opts.onRemove(s) },
        icon('cross'))
        : null);
      this.items.push({ node: item, val });
      this.legend.append(item);
    });
    // Заметки: ошибки скриптов и т. п. Если у заметки есть item, её можно убрать, как ряд
    for (const note of this.notes) {
      const text = typeof note === 'string' ? note : note.text;
      this.legend.append(el('span', { class: `lg${note.plain ? '' : ' lg-err'}` }, text,
        note.item && this.opts.onRemove
          ? el('button', { class: 'lg-remove', type: 'button', title: 'Убрать с графика',
            'aria-label': 'Убрать с графика', onclick: () => this.opts.onRemove(note) },
          icon('cross'))
          : null));
    }
    this.showValues(null);
  }

  toggle(i) {
    const s = this.specs[i];
    const show = this.hidden.has(s.key);
    if (show) this.hidden.delete(s.key);
    else this.hidden.add(s.key);
    this.items[i].node.classList.toggle('off', !show);
    this.items[i].node.querySelector('.lg-name').setAttribute('aria-pressed', String(show));
    if (!this.plot) return;
    const idx = this.index[i];
    this.plot.setSeries(idx, { show });
    if (s.lo) {
      this.plot.setSeries(idx + 1, { show });
      this.plot.setSeries(idx + 2, { show });
    }
  }

  showValues(idx) {
    const u = this.plot;
    if (!u) {
      this.time.textContent = '';
      return;
    }
    const at = idx === null || idx === undefined ? null : idx;
    this.time.textContent = at !== null ? dateTime(u.data[0][at]) : '';
    this.specs.forEach((s, i) => {
      const item = this.items[i];
      if (!item) return;
      const col = u.data[this.index[i]];
      if (s.kind === 'events' && s.draw === 'points') {
        const v = at !== null ? col[at] : undefined;
        item.val.textContent = v !== undefined && v !== null ? value(v, s)
          : `${s.count ?? col.filter((x) => x !== undefined && x !== null).length} шт.`;
        return;
      }
      let j = at === null ? col.length - 1 : at;
      while (j >= 0 && col[j] === undefined) j -= 1;
      item.val.textContent = j < 0 || col[j] === null ? '—' : value(col[j], s);
    });
  }

  // --- сетка «самописца»: мелкие деления между крупными --------------------------
  drawMinor(u) {
    const ctx = u.ctx;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.strokeStyle = MINOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const lines = (axis, scale, vertical) => {
      const splits = axis && axis._splits;
      const sc = u.scales[scale];
      if (!splits || splits.length < 2 || !sc || sc.min === null || sc.max === null) return;
      const step = (splits[1] - splits[0]) / 5;
      if (!(step > 0)) return;
      const k0 = Math.ceil((sc.min - splits[0]) / step);
      const k1 = Math.floor((sc.max - splits[0]) / step);
      if (k1 - k0 > 600) return;
      for (let k = k0; k <= k1; k += 1) {
        if (k % 5 === 0) continue;
        const p = Math.round(u.valToPos(splits[0] + k * step, scale, true)) + 0.5;
        if (vertical) {
          ctx.moveTo(p, top);
          ctx.lineTo(p, top + height);
        } else {
          ctx.moveTo(left, p);
          ctx.lineTo(left + width, p);
        }
      }
    };
    lines(u.axes[0], 'x', true);
    if (this.scaleKeys.length) lines(u.axes[1], this.scaleKeys[0], false);
    ctx.stroke();
    ctx.restore();
  }

  // --- перья: на живой ленте у каждого ряда точка на последнем значении ------------
  drawPens(u) {
    if (!(this.opts.live && this.opts.live())) return;
    const ctx = u.ctx;
    const px = globalThis.devicePixelRatio || 1;
    const r = 3.5 * px;
    ctx.save();
    this.specs.forEach((s, i) => {
      if (s.draw === 'points' || this.hidden.has(s.key)) return;
      const col = u.data[this.index[i]];
      let j = col.length - 1;
      while (j >= 0 && col[j] === undefined) j -= 1;
      if (j < 0 || col[j] === null) return;
      const x = u.valToPos(u.data[0][j], 'x', true);
      const y = u.valToPos(col[j], s.scale, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * px;
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  // --- размеры и уборка -----------------------------------------------------------
  width() {
    return Math.max((this.body.clientWidth || 640) - 12, 280);
  }

  resize() {
    if (this.plot) this.plot.setSize({ width: this.width(), height: this.opts.height });
  }

  destroy() {
    this.observer.disconnect();
    if (this.plot) this.plot.destroy();
    this.plot = null;
    this.node.remove();
  }
}
