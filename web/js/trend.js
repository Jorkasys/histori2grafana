// Панель-«самописец» на uPlot: несколько рядов на одной сетке, у каждой единицы
// измерения — своя шкала. Мышью: протянуть по горизонтали — выбрать время
// (страница загрузит этот период подробнее), по вертикали — диапазон значений,
// рамкой — и то и другое. Двойной щелчок возвращает масштаб.

import { clear, dateTime, el, num } from './core.js';

export const PENS = ['#1f5aa6', '#c0392b', '#2e7d32', '#7b3fa0', '#b26a00', '#00838f',
  '#6d4c41', '#546e7a'];
const AXIS = '#75808c';
const GRID = '#d6e0dc';
const MINOR = '#edf2f0';
const FONT = '12px Bahnschrift, "Segoe UI", Arial, sans-serif';

// Подписи оси времени по-русски, 24 часа: секунды — на коротких периодах,
// дата — на длинных
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
  // Знаков после запятой — сколько нужно, чтобы шаг делений записался точно (2,5 → 1)
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

// Общая ось времени для рядов с разными моментами. undefined — у ряда в этот
// момент точки нет (линия идёт дальше), null — разрыв в самих данных
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

function value(v, spec) {
  if (spec.bool) return v > 0 ? '1' : '0';
  return spec.unit ? `${num(v)} ${spec.unit}` : num(v);
}

export class Trend {
  /**
   * opts: { title, height, sync, empty, fixed,
   *         onTimeZoom(from, to), onReset(), onRemove(spec), onScales(fixed), onActivate() }
   *
   * Ряды (update): { key, label, title, color, unit, scale, kind: 'line' | 'events',
   *                  bool, t: [...], v: [...], lo?, hi? (полоса мин–макс), count? }
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
      title: 'Сделать график выделенным: новые теги добавляются на него',
      onclick: () => this.opts.onActivate && this.opts.onActivate() }, opts.title || '');
    this.time = el('span', { class: 'trend-time' });
    this.tools = el('span', { class: 'trend-tools' },
      el('button', { class: 'link', type: 'button', onclick: () => this.toggleScales() }, 'Шкала'));
    this.legend = el('div', { class: 'legend' });
    this.scalesBox = el('div', { class: 'scales', hidden: true });
    this.body = el('div', { class: 'trend-body' });
    this.extra = el('div', { class: 'texts' });
    this.node = el('section', { class: 'trend' },
      el('div', { class: 'trend-head' }, this.title, this.time, this.tools),
      this.legend, this.scalesBox, this.body, this.extra);
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

  // --- данные -------------------------------------------------------------------
  update(specs, window, notes = []) {
    this.window = window;
    this.specs = specs;
    this.notes = notes;
    this.scaleKeys = [];
    for (const s of specs) if (!this.scaleKeys.includes(s.scale)) this.scaleKeys.push(s.scale);
    if (!specs.length) {
      if (this.plot) this.plot.destroy();
      this.plot = null;
      this.signature = '';
      clear(this.body).append(el('div', { class: 'trend-empty' }, this.opts.empty));
      this.renderLegend();
      return;
    }
    const data = align(specs);
    const signature = specs.map((s) => [s.key, s.scale, s.kind, s.lo ? 1 : 0, s.color].join('|'))
      .join(';');
    if (this.plot && signature === this.signature) {
      this.plot.setData(data);
    } else {
      this.signature = signature;
      this.build(data);
    }
    this.renderLegend();
    if (!this.scalesBox.hidden) this.renderScales();
  }

  build(data) {
    if (this.plot) this.plot.destroy();
    clear(this.body);
    const stepped = uPlot.paths.stepped({ align: 1 });
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
      scales[key] = {
        range: (_u, min, max) => (this.fixed[key] ? [...this.fixed[key]] : autoRange(min, max)),
      };
      axes.push({
        scale: key, side: i % 2 ? 1 : 3, font: FONT, values: valueTicks, size: axisSize,
        stroke: several ? first.color : AXIS,
        grid: { show: i === 0, stroke: GRID, width: 1 },
        ticks: { stroke: GRID, width: 1, size: 4 },
      });
    });
    const series = [{}];
    const bands = [];
    this.index = [];
    for (const s of this.specs) {
      const idx = series.length;
      const show = !this.hidden.has(s.key);
      this.index.push(idx);
      if (s.kind === 'events') {
        series.push({ label: s.label, scale: s.scale, show, stroke: s.color, width: 1,
          paths: () => null,
          points: { show: true, size: 8, width: 1.6, stroke: s.color, fill: '#ffffff' } });
        continue;
      }
      series.push({ label: s.label, scale: s.scale, show, stroke: s.color, width: 1.6,
        spanGaps: false, paths: stepped, points: { show: false } });
      if (s.lo) {
        for (let k = 0; k < 2; k += 1) {
          series.push({ scale: s.scale, show, stroke: 'rgba(0,0,0,0)', width: 1, paths: stepped,
            points: { show: false } });
        }
        bands.push({ series: [idx + 1, idx + 2], fill: rgba(s.color, 0.13) });
      }
    }
    this.plot = new uPlot({
      width: this.width(),
      height: this.opts.height,
      // Справа без шкалы — место под последнюю подпись времени
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
    if (!this.scalesBox.hidden) this.renderScales();
  }

  renderScales() {
    clear(this.scalesBox);
    if (!this.scaleKeys.length) {
      this.scalesBox.append(el('span', { class: 'muted' }, 'Добавьте теги — появятся их шкалы.'));
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
      const lo = el('input', { inputmode: 'decimal', value: fixed ? num(fixed[0]) : '',
        placeholder: current && current.min !== undefined ? num(current.min) : 'авто' });
      const hi = el('input', { inputmode: 'decimal', value: fixed ? num(fixed[1]) : '',
        placeholder: current && current.max !== undefined ? num(current.max) : 'авто' });
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
      this.scalesBox.append(el('label', { style: `color:${first.color}` },
        first.unit || first.label, el('span', { class: 'muted' }, 'от'), lo,
        el('span', { class: 'muted' }, 'до'), hi));
    }
    this.scalesBox.append(
      el('button', { class: 'small', type: 'button', onclick: () => {
        this.fixed = {};
        this.scalesChanged();
      } }, 'Все шкалы автоматически'),
      el('span', { class: 'muted', style: 'flex-basis:100%' }, 'Пустые поля — автоматически. ' +
        'Мышью: протяните по графику вверх или вниз — шкала значений, влево или вправо — время, ' +
        'по диагонали — и то и другое. Двойной щелчок — вернуть.'));
  }

  // --- легенда --------------------------------------------------------------------
  renderLegend() {
    clear(this.legend);
    this.items = [];
    this.specs.forEach((s, i) => {
      const val = el('span', { class: 'lg-val' });
      const item = el('span', { class: `lg${this.hidden.has(s.key) ? ' off' : ''}`,
        style: `--c:${s.color}` },
      el('i', { class: `lg-mark${s.kind === 'events' ? ' dot' : ''}` }),
      el('span', { class: 'lg-name', title: `${s.title || s.label}\nЩелчок — скрыть или показать`,
        onclick: () => this.toggle(i) }, s.label),
      val,
      this.opts.onRemove && s.removable !== false
        ? el('button', { class: 'link quiet', type: 'button', title: 'Убрать с графика',
          'aria-label': `Убрать ${s.label}`, onclick: () => this.opts.onRemove(s) }, '×')
        : null);
      this.items.push({ node: item, val });
      this.legend.append(item);
    });
    // Заметки — ошибки скриптов и т. п.; с item их можно убрать, как ряд
    for (const note of this.notes) {
      const text = typeof note === 'string' ? note : note.text;
      this.legend.append(el('span', { class: `lg${note.plain ? '' : ' lg-err'}` }, text,
        note.item && this.opts.onRemove
          ? el('button', { class: 'link quiet', type: 'button', title: 'Убрать с графика',
            onclick: () => this.opts.onRemove(note) }, '×')
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
      if (s.kind === 'events') {
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
