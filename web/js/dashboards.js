// Окно «Сохранить как дашборд»: раскладка страницы «Графики» становится дашбордом в Grafana.

import { clear, del, el, fail, get, grafanaBase, icon, post, shared, toast } from './core.js';

// Столько Grafana может подхватывать новый файл дашборда
const PICKUP_MS = 3500;

const boardUrl = (item) => `${grafanaBase(shared.info)}${item.path}`;

export async function dashboardDialog(layout) {
  let items = [];
  try {
    items = (await get('/dashboards')).items;
  } catch (error) {
    fail(error);
    return;
  }
  const root = document.getElementById('modal-root');
  const opener = document.activeElement;
  const input = el('input', { id: 'board-name', maxlength: '100', list: 'board-names',
    placeholder: 'Например: смеситель, смена' });
  const names = el('datalist', { id: 'board-names' });
  const problem = el('p', { class: 'period-error', role: 'alert', hidden: true });
  const cancel = el('button', { type: 'button', onclick: () => close() }, 'Отмена');
  const ok = el('button', { class: 'primary', type: 'button', onclick: () => save() }, 'Сохранить');
  const savedList = el('ul', { class: 'saved-boards' });
  const savedBox = el('div', { hidden: true },
    el('p', { class: 'side-title', style: 'margin:14px 0 0' }, 'Уже сохранены'), savedList);
  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'board-title' },
  el('h2', { id: 'board-title' }, 'Сохранить как дашборд'),
  el('label', { class: 'name-field', for: 'board-name' },
    el('span', { class: 'side-title' }, 'Название'), input), names, problem,
  el('div', { class: 'modal-text' }, el('p', {}, 'Дашборд появится в Grafana, в папке «Сохранённые»: ' +
    'те же графики, теги, скрипты, вид рядов и период. Под тем же названием он заменится.')),
  el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' }, cancel, ok),
  savedBox);
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) close();
  } }, dialog);

  function drawSaved() {
    clear(names);
    clear(savedList);
    savedBox.hidden = !items.length;
    for (const item of items) {
      names.append(el('option', { value: item.title }));
      savedList.append(el('li', {},
        el('a', { class: 'external', href: boardUrl(item), target: '_blank', rel: 'noopener' },
          item.title, icon('external')),
        el('button', { class: 'small', type: 'button', onclick: (e) => remove(item, e.currentTarget) },
          'Удалить')));
    }
  }

  // Удаление без отдельного окна: первый щелчок переспрашивает, второй удаляет
  async function remove(item, button) {
    if (!button.classList.contains('danger')) {
      button.classList.add('danger');
      button.textContent = 'Точно удалить?';
      return;
    }
    try {
      await del(`/dashboards/${item.uid}`);
      items = items.filter((x) => x.uid !== item.uid);
      drawSaved();
      (items.length ? savedList.querySelector('a') : input).focus();
      toast(`Дашборд «${item.title}» удалён`, 'ok');
    } catch (error) { fail(error); }
  }

  async function save() {
    const title = input.value.trim();
    problem.hidden = true;
    if (!title) {
      problem.textContent = 'Укажите название дашборда';
      problem.hidden = false;
      input.focus();
      return;
    }
    ok.disabled = true;
    ok.textContent = 'Сохраняю…';
    try {
      const result = await post('/dashboards', { title, ...layout() });
      await new Promise((resolve) => { setTimeout(resolve, PICKUP_MS); });
      close();
      toast(`Дашборд «${result.title}» ${result.replaced ? 'заменён' : 'сохранён'}.`, 'ok', 12000,
        { label: 'Открыть в Grafana', run: () => window.open(boardUrl(result), '_blank', 'noopener') });
    } catch (error) {
      problem.textContent = error.message;
      problem.hidden = false;
      ok.disabled = false;
      ok.textContent = 'Сохранить';
    }
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab') {
      // Фокус не выходит из окна
      const nodes = [...dialog.querySelectorAll('a, button:not(:disabled), input')];
      const i = nodes.indexOf(document.activeElement);
      const next = nodes[(i + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length];
      e.preventDefault();
      next.focus();
    }
  };

  function close() {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (opener && opener.focus && document.contains(opener)) opener.focus();
  }

  drawSaved();
  root.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  input.focus();
}
