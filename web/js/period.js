// Переключатель периода, общий для «Графиков» и «Скриптов»: готовые периоды и «свой»
// с полями «с … по». Сам период хранит страница, здесь только разметка и ввод.

import { RANGES, clear, el, keepFocus, recall, remember } from './core.js';

const SESSION = 'historian2grafana.period';

function localInput(seconds) {
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Начало и конец периода { range, from, to } в секундах
export function spanOf(p) {
  if (p.range === 'custom') return [p.from, p.to];
  const seconds = (RANGES.find((r) => r[0] === p.range) || RANGES[1])[2];
  const now = Date.now() / 1000;
  return [now - seconds, now];
}

// Период один на обе страницы: скрипт считается за то же окно, что и график. Готовый
// период запоминается насовсем, свой — до закрытия вкладки, чтобы назавтра не открылся
// вчерашний участок
export function loadPeriod(fallback = '1h') {
  try {
    const p = JSON.parse(sessionStorage.getItem(SESSION));
    if (p && (p.range !== 'custom' || (p.from && p.to && p.from < p.to))) return p;
  } catch { /* недоступно */ }
  const range = recall('period', fallback);
  return { range: RANGES.some((r) => r[0] === range) ? range : '1h', from: null, to: null };
}

export function savePeriod(p) {
  try { sessionStorage.setItem(SESSION, JSON.stringify(p)); } catch { /* недоступно */ }
  if (p.range !== 'custom') remember('period', p.range);
}

// get() — текущий период страницы; onPreset(key) — выбран готовый период;
// onCustom(from, to) — свой, в секундах; tail — что поставить после кнопки «Показать»
export function periodPicker({ get, onPreset, onCustom, tail = null }) {
  const segs = el('div', { class: 'segs', role: 'group', 'aria-label': 'Период' });
  const from = el('input', { type: 'datetime-local', 'aria-label': 'Начало периода' });
  const to = el('input', { type: 'datetime-local', 'aria-label': 'Конец периода' });
  // Ошибку пишем у полей, а не всплывающим уведомлением
  const error = el('span', { class: 'period-error', role: 'alert', hidden: true });
  const box = el('span', { class: 'row custom-range', style: 'gap:6px' },
    el('span', { class: 'muted' }, 'с'), from, el('span', { class: 'muted' }, 'по'), to,
    el('button', { class: 'small', type: 'button', onclick: () => apply() }, 'Показать'),
    tail, error);
  let editing = false;          // нажата «свой», но период ещё не применён

  function apply() {
    const a = from.value ? new Date(from.value).getTime() / 1000 : null;
    const b = to.value ? new Date(to.value).getTime() / 1000 : Date.now() / 1000;
    if (!a || a >= b) {
      error.textContent = 'Начало периода должно быть раньше конца';
      error.hidden = false;
      from.setAttribute('aria-invalid', 'true');
      from.focus();
      return;
    }
    editing = false;
    onCustom(a, b);
  }

  function draw() {
    const p = get();
    keepFocus(segs, () => {
      clear(segs);
      for (const [key, label] of RANGES) {
        const on = p.range === key && !editing;
        segs.append(el('button', { class: `seg small${on ? ' on' : ''}`, type: 'button',
          dataset: { key }, 'aria-pressed': String(on),
          onclick: () => { editing = false; onPreset(key); } }, label));
      }
      const own = p.range === 'custom' || editing;
      segs.append(el('button', { class: `seg small${own ? ' on' : ''}`, type: 'button',
        dataset: { key: 'custom' }, 'aria-pressed': String(own), 'aria-expanded': String(own),
        title: 'Задать начало и конец периода',
        onclick: () => { editing = true; draw(); from.focus(); } }, 'свой'));
    });
    box.hidden = !(p.range === 'custom' || editing);
    const [a, b] = spanOf(p);
    from.value = localInput(a);
    to.value = localInput(b);
    error.hidden = true;
    from.removeAttribute('aria-invalid');
  }

  return { segs, box, draw, reset() { editing = false; } };
}
