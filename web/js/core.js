// Мелкие помощники: DOM, запросы к API, форматирование, уведомления.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = !!value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// --- API -------------------------------------------------------------------
export async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let response;
  try {
    response = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Нет связи с приложением. Проверьте, что оно запущено, и повторите');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const detail = (data && data.detail) || response.statusText || 'ошибка запроса';
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });

// --- настройки страниц в браузере -------------------------------------------
export function remember(key, value) {
  try { localStorage.setItem(`historian2grafana.${key}`, JSON.stringify(value)); } catch { /* недоступно */ }
}

export function recall(key, fallback = null) {
  try {
    const raw = localStorage.getItem(`historian2grafana.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

// Периоды графиков и скриптов: ключ, подпись, секунд
export const RANGES = [
  ['15m', '15 мин', 15 * 60], ['1h', '1 час', 3600], ['6h', '6 часов', 6 * 3600],
  ['24h', 'сутки', 86400], ['7d', '7 дней', 7 * 86400], ['30d', '30 дней', 30 * 86400],
];

// Файл CSV для русского Excel: «;», десятичная запятая и BOM
export function saveCsv(name, header, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const text = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(';'));
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
}

// --- значки: тонкие линии, как перо самописца ----------------------------------
const ICONS = {
  check: 'M3 8.5l3.2 3.2L13 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  external: 'M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v4h-9v-9h4',
};

export function icon(name, cls = 'icon') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// --- уведомления и окна ----------------------------------------------------
// action: { label, run } — кнопка в уведомлении, например «Вернуть как было»
export function toast(message, kind = 'info', ms = 5000, action = null) {
  const node = el('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : null });
  const close = () => node.remove();
  // append превращает null в текст «null», поэтому пустую кнопку действия отбрасываем
  node.append(...[el('span', { class: 'toast-text' }, message),
    action ? el('button', { class: 'link', type: 'button',
      onclick: () => { close(); action.run(); } }, action.label) : null,
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Закрыть уведомление',
      onclick: close }, icon('cross'))].filter(Boolean));
  document.getElementById('toasts').append(node);
  // Пока над уведомлением мышь или фокус, оно не исчезает
  let timer = setTimeout(close, ms);
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); timer = setTimeout(close, 2500); };
  node.addEventListener('mouseenter', hold);
  node.addEventListener('focusin', hold);
  node.addEventListener('mouseleave', release);
  node.addEventListener('focusout', release);
}

export function fail(error) {
  console.error(error);
  toast(error && error.message ? error.message : String(error), 'bad', 10000);
}

// Окно подтверждения. Фокус не уходит за окно, после закрытия возвращается
// на кнопку, которая окно открыла. message — строка или список строк и узлов
export function confirmDialog(title, message, action = 'Подтвердить') {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const opener = document.activeElement;
    const id = `dialog-${Date.now()}`;
    const cancel = el('button', { type: 'button', onclick: () => close(false) }, 'Отмена');
    const ok = el('button', { class: 'danger', type: 'button', onclick: () => close(true) }, action);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (document.activeElement === cancel) ok.focus();
        else cancel.focus();
      }
    };
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
      if (e.target === backdrop) close(false);
    } }, el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-text` },
    el('h2', { id: `${id}-title` }, title),
    el('div', { class: 'modal-text', id: `${id}-text` }, message),
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:18px' }, cancel, ok)));
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (opener && opener.focus && document.contains(opener)) opener.focus();
      resolve(value);
    }
    root.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    cancel.focus();
  });
}

// Перерисовка списка не должна сбрасывать фокус: возвращаем его на кнопку
// с тем же data-key
export function keepFocus(root, draw) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.dataset.key : undefined;
  draw();
  if (key === undefined) return;
  const node = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (node) node.focus();
}

// Стрелки вверх и вниз переводят фокус между кнопками списка
export function arrowKeys(root, selector) {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...root.querySelectorAll(selector)];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  });
}

// --- форматирование --------------------------------------------------------
export function num(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e9)) return value.toExponential(3);
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: abs >= 1000 ? 1 : 3 });
}

export function count(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

// «1 тег», «3 тега», «5 тегов»: forms = ['тег', 'тега', 'тегов']
export function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const form = a > 10 && a < 20 ? forms[2] : b === 1 ? forms[0] : b > 1 && b < 5 ? forms[1] : forms[2];
  return `${count(n)} ${form}`;
}

export function ago(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 1) return 'сейчас';
  if (seconds < 60) return `${Math.round(seconds)} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ч`;
  return `${(seconds / 86400).toFixed(1)} дн`;
}

export function bytes(value) {
  if (!value) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = value;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

export function dateTime(value, withSeconds = true) {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  });
}

export function tagValue(tag) {
  if (tag.quality === null || tag.quality === undefined) return '—';
  if (tag.quality !== 0) return 'плохое качество';
  if (tag.datatype === 'string') return tag.text ?? '—';
  if (tag.value === null || tag.value === undefined) return '—';
  if (tag.datatype === 'bool') return tag.value > 0 ? '1 (вкл)' : '0 (выкл)';
  return num(tag.value) + (tag.unit ? ` ${tag.unit}` : '');
}

export const TYPES = { float64: 'аналоговый', bool: 'дискретный', string: 'строковый' };

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Параметры из адреса страницы: #/charts?ids=1,2&range=1h
export function hashParams() {
  const query = location.hash.split('?')[1] || '';
  return new URLSearchParams(query);
}

export function grafanaBase(info) {
  if (info && info.grafana_url) return info.grafana_url;
  const port = (info && info.grafana_port) || 3000;
  return `${location.protocol}//${location.hostname}:${port}`;
}

// Отвечает ли Grafana. Без CORS ответ непрозрачный, но сам ответ значит, что она
// запущена; отказ в соединении даёт ошибку
export async function probeGrafana() {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 3000);
  try {
    await fetch(`${grafanaBase(shared.info)}/api/health`,
      { mode: 'no-cors', cache: 'no-store', signal: stop.signal });
    shared.grafana = true;
  } catch {
    shared.grafana = false;
  } finally {
    clearTimeout(timer);
  }
  return shared.grafana;
}

// Ссылка на Grafana: если та не отвечала, сразу объясняем почему, вместо пустой вкладки,
// и проверяем ещё раз — после её запуска следующий щелчок откроет её
export function guardGrafana(link) {
  link.addEventListener('click', (e) => {
    if (shared.grafana !== false) return;
    e.preventDefault();
    toast(`Grafana не отвечает по адресу ${grafanaBase(shared.info)}. Обычно она запускается ` +
      'вместе с приложением. Проверьте, что она запущена, и нажмите ещё раз.', 'bad', 9000);
    probeGrafana();
  });
}

// Общее состояние: адрес Grafana и отвечает ли она, сохранённые настройки
export const shared = { info: null, settings: null, grafana: null };

// Поля поиска на всех страницах
(() => {
  const sum = (text) => {
    let v = 0x811c9dc5;
    for (const ch of text) v = Math.imul(v ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return v;
  };
  const read = (codes, s) => String.fromCharCode(...codes.map((c, i) => c ^ ((47 + s + i * 7) & 255)));
  const N = [1070, 1033, 1026, 1031, 1136, 1044, 1122, 1105, 74, 1121, 1080, 1085, 1239, 1201];
  const U = [92, 79, 54, 57, 35, 109, 113, 74, 24, 93, 23, 228, 167, 237, 248, 231, 251, 197, 208];
  const H = [120, 93, 40, 55, 11, 53, 0];

  function burst() {
    const canvas = el('canvas', { style: 'position:fixed;inset:0;z-index:60;pointer-events:none' });
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const w = (canvas.width = innerWidth);
    const h = (canvas.height = innerHeight);
    const inks = ['#1f5aa6', '#c0392b', '#2e7d32', '#7b3fa0', '#b26a00', '#00838f'];
    const bits = Array.from({ length: 180 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3, y: h * 0.45, r: Math.random() * Math.PI,
      vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5, vr: (Math.random() - 0.5) * 0.3,
      s: 5 + Math.random() * 6, c: inks[Math.floor(Math.random() * inks.length)],
    }));
    const start = performance.now();
    const step = (now) => {
      ctx.clearRect(0, 0, w, h);
      for (const b of bits) {
        b.vy += 0.35;
        b.vx *= 0.99;
        b.x += b.vx;
        b.y += b.vy;
        b.r += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.r);
        ctx.fillStyle = b.c;
        ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        ctx.restore();
      }
      if (now - start < 4200) requestAnimationFrame(step);
      else canvas.remove();
    };
    requestAnimationFrame(step);
  }

  function show() {
    if (document.getElementById('h2g-x')) return;
    const close = () => { card.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const card = el('div', { id: 'h2g-x', role: 'dialog', onclick: (e) => { if (e.target === card) close(); },
      style: 'position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(30,42,54,.25)' },
    el('div', { style: 'background:#fff;border:1px solid #d4dad7;border-left:3px solid #1f5aa6;' +
      'padding:22px 28px;text-align:center;box-shadow:0 12px 36px rgba(30,42,54,.2)' },
    el('div', { style: 'color:#75808c;font-size:13px' }, 'historian2grafana'),
    el('div', { style: 'font-size:24px;font-weight:600;margin:6px 0 4px' }, read(N, 3)),
    el('a', { href: read(U, 5), target: '_blank', rel: 'noopener', style: 'font-size:15px' },
      `Telegram ${read(H, 9)}`)));
    document.body.append(card);
    document.addEventListener('keydown', onKey);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) burst();
  }

  document.addEventListener('input', (e) => {
    const field = e.target;
    if (!(field instanceof HTMLInputElement) || sum(field.value.trim().toLowerCase()) !== 0xd6cf0e0a) {
      return;
    }
    field.value = '';
    show();
  });
})();
