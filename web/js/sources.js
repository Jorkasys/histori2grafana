import { el, hashParams } from './core.js';

export function sourceOf(items) {
  const id = hashParams().get('source') || 'main';
  return items.find((item) => item.id === id) || items[0];
}

export function sourceQuery(id) {
  return new URLSearchParams({ source: id }).toString();
}

export function sourcePicker(items, id, page) {
  const select = el('select', { 'aria-label': 'Источник Historian' }, items.map((item) =>
    el('option', { value: item.id }, [item.id === 'main' ? 'Основной' : item.id, item.server]
      .filter(Boolean).join(' · '))));
  select.value = id;
  select.addEventListener('change', () => {
    const next = select.value;
    select.value = id;
    location.hash = `#/${page}?${sourceQuery(next)}`;
  });
  return el('label', { class: 'source-picker' }, el('span', {}, 'Источник Historian'), select);
}
