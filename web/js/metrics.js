// Числовые результаты скриптов: общий вид в редакторе и на дашборде приложения.
import { el, num } from './core.js';

export function metricCards(metrics, onRemove = null) {
  return el('div', { class: 'metric-grid', role: 'group', 'aria-label': 'Показатели за период' },
    metrics.map((m) => el('div', { class: 'metric-card' },
      el('div', { class: 'metric-label' }, m.name,
        onRemove && m.item ? el('button', { type: 'button', class: 'link quiet',
          'aria-label': `Убрать ${m.name}`, onclick: () => onRemove(m) }, '×') : null),
      el('div', { class: 'metric-value' },
        m.value === null || m.value === undefined ? 'Нет данных' : num(m.value),
        m.unit ? el('span', { class: 'metric-unit' }, ` ${m.unit}`) : null))));
}
