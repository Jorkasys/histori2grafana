// Оболочка: навигация по страницам и индикатор копирования в шапке.

import { clear, el, get, grafanaBase, guardGrafana, probeGrafana, shared } from './js/core.js';
import { connectionPage } from './js/connection.js';
import { loadingPage } from './js/loading.js';
import { chartsPage } from './js/charts.js';
import { scriptsPage } from './js/scripts.js';

const PAGES = {
  connection: connectionPage, loading: loadingPage, charts: chartsPage, scripts: scriptsPage,
};
const STATES = {
  stopped: ['Копирование остановлено', ''],
  starting: ['Подключение к историку…', 'warn'],
  backfill: ['Загрузка истории', 'warn'],
  live: ['Копирование идёт', 'ok'],
  error: ['Ошибка копирования', 'bad'],
};

let current = null;

async function route() {
  const name = (location.hash.replace(/^#\//, '').split('?')[0]) || '';
  if (!name) {
    // При первом запуске открываем подключение, потом сразу копирование
    location.hash = shared.settings && shared.settings.server ? '#/loading' : '#/connection';
    return;
  }
  const page = PAGES[name] || connectionPage;
  if (current && current.name === name && current.reuse && current.reuse()) return;
  if (current && current.leave && !(await current.leave())) {
    // Остаёмся: на странице несохранённые изменения
    history.replaceState(null, '', current.hash);
    return;
  }
  if (current && current.destroy) current.destroy();
  for (const a of document.querySelectorAll('#nav a[data-page]')) {
    const on = a.dataset.page === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const view = clear(document.getElementById('view'));
  try {
    current = { name, hash: location.hash, ...(await page(view)) };
  } catch (error) {
    // Страница не загрузилась (чаще всего нет связи с приложением): не оставляем её пустой
    console.error(error);
    current = { name, hash: location.hash };
    clear(view).append(el('div', { class: 'note bad' },
      el('b', {}, 'Страница не открылась. '), error.message, ' ',
      el('button', { class: 'small', type: 'button', onclick: () => {
        current = null;
        route();
      } }, 'Повторить')));
  }
}

async function pill() {
  const node = document.getElementById('status-pill');
  try {
    const status = await get('/status');
    const [text, kind] = STATES[status.copy.state] || [status.copy.state, ''];
    node.textContent = text;
    node.className = `status ${kind}`;
  } catch {
    node.textContent = 'Нет связи с приложением';
    node.className = 'status bad';
  }
}

async function start() {
  try {
    [shared.info, shared.settings] = await Promise.all([get('/info'), get('/settings')]);
  } catch {
    shared.info = {};
  }
  const grafana = document.getElementById('grafana-link');
  grafana.href = grafanaBase(shared.info);
  guardGrafana(grafana);
  if (shared.info && shared.info.version) {
    document.getElementById('footer').textContent = `historian2grafana ${shared.info.version}`;
  }
  document.getElementById('status-pill').addEventListener('click', () => {
    location.hash = '#/loading';
  });
  window.addEventListener('hashchange', route);
  await route();
  pill();
  setInterval(pill, 3000);
  probeGrafana();
  setInterval(probeGrafana, 60000);
}

start();
