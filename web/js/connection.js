// Страница «Подключение»: адрес историка, вход, какие теги копировать.

import {
  clear, confirmDialog, count, dateTime, el, fail, get, icon, post, put, shared, toast,
} from './core.js';

const AUTH = [
  ['sql', 'Логин SQL Server',
    'Отдельный логин SQL Server с правом чтения базы Runtime. Его выдаёт администратор ' +
    'историка. Этот способ надёжнее всего.'],
  ['windows', 'Учётная запись Windows',
    'Доменная учётная запись, под которой вы входите в SSMS: логин в виде ДОМЕН\\логин ' +
    '(например CORP\\ivanov) и пароль от неё.'],
];

// Числовые поля и их пределы, как их проверяет приложение. Пустое поле значит
// «по умолчанию», у порта — стандартный 1433
const LIMITS = {
  port: [1, 65535], poll_s: [1, 3600], history_hours: [0, 8784], lag_s: [0, 3600],
  overlap_s: [0, 86400], resolution_ms: [100, 86400000],
};

const SAVED_PASSWORD = 'сохранён; оставьте пустым, чтобы не менять';

function select(options, value) {
  const node = el('select', {}, options.map(([v, text]) => el('option', { value: v }, text)));
  node.value = value;
  return node;
}

export async function connectionPage(view) {
  const [config, status] = await Promise.all([get('/settings'), get('/status')]);
  shared.settings = config;
  const running = status.copy.running;

  const f = {
    server: el('input', { value: config.server, placeholder: 'HISTSRV01 или 10.20.30.40' }),
    port: el('input', { value: config.port ?? '', placeholder: '1433', inputmode: 'numeric' }),
    database: el('input', { value: config.database }),
    user: el('input', { value: config.user, autocomplete: 'off' }),
    password: el('input', {
      type: 'password', autocomplete: 'new-password',
      placeholder: config.password_set ? SAVED_PASSWORD : '',
    }),
    include: el('textarea', { placeholder: 'пустое поле: все теги историка\nили маски: Line1_*, Mixer_*' }),
    exclude: el('input', { value: config.exclude }),
    strings: el('input', { type: 'checkbox', checked: config.strings }),
    poll_s: el('input', { value: config.poll_s, inputmode: 'decimal' }),
    history_hours: el('input', { value: config.history_hours, inputmode: 'decimal' }),
    driver: select([['auto', 'Автоматически (рекомендуется)'],
      ['odbc', 'Microsoft ODBC Driver 18'], ['freetds', 'FreeTDS']], config.driver),
    retrieval: select([['delta', 'Delta — каждое изменение'],
      ['cyclic', 'Cyclic — одно значение на шаг']], config.retrieval),
    resolution_ms: el('input', { value: config.resolution_ms, inputmode: 'numeric' }),
    time_zone: el('input', { value: config.time_zone, placeholder: 'пустое поле: UTC' }),
    linked_server: el('input', { value: config.linked_server, placeholder: 'обычно не нужен' }),
    lag_s: el('input', { value: config.lag_s, inputmode: 'decimal' }),
    overlap_s: el('input', { value: config.overlap_s, inputmode: 'decimal' }),
  };
  f.include.value = config.include;

  // --- поля с подписью, подсказкой и местом для ошибки -------------------------
  const errors = {};
  function field(key, label, help, wide = false) {
    const id = `f-${key}`;
    const input = f[key];
    input.id = id;
    errors[key] = el('span', { class: 'error', id: `${id}-error`, hidden: true });
    const helpNode = help ? el('span', { class: 'help', id: `${id}-help` }, help) : null;
    input.setAttribute('aria-describedby', [helpNode ? `${id}-help` : '', `${id}-error`]
      .filter(Boolean).join(' '));
    return el('div', { class: `field${wide ? ' wide' : ''}` },
      el('label', { for: id }, label), input, errors[key], helpNode);
  }

  function setError(key, text) {
    errors[key].textContent = text || '';
    errors[key].hidden = !text;
    if (text) f[key].setAttribute('aria-invalid', 'true');
    else f[key].removeAttribute('aria-invalid');
  }

  // Число из поля: запятая тоже годится. null — пусто, NaN — не число
  function number(key) {
    const text = f[key].value.trim().replace(/\s/g, '').replace(',', '.');
    return text === '' ? null : Number(text);
  }

  function checkField(key) {
    if (key === 'server') {
      setError('server', f.server.value.trim() ? '' : 'Укажите сервер историка');
      return !errors.server.textContent;
    }
    const value = number(key);
    const [lo, hi] = LIMITS[key];
    let text = '';
    if (Number.isNaN(value)) text = 'Нужно число';
    else if (value !== null && (value < lo || value > hi)) {
      text = `Допустимо от ${count(lo)} до ${count(hi)}`;
    } else if (value !== null && (key === 'port' || key === 'resolution_ms')
      && !Number.isInteger(value)) text = 'Нужно целое число';
    setError(key, text);
    return !text;
  }

  // Проверяет поля перед отправкой; при ошибке ставит фокус на первое неверное
  function valid(needServer) {
    const keys = [...(needServer ? ['server'] : []), ...Object.keys(LIMITS)];
    const bad = keys.filter((key) => !checkField(key));
    if (!bad.length) return true;
    if (bad.some((key) => advanced.contains(f[key]))) advanced.open = true;
    f[bad[0]].focus();
    return false;
  }

  for (const key of ['server', ...Object.keys(LIMITS)]) {
    f[key].addEventListener('blur', () => checkField(key));
    f[key].addEventListener('input', () => { if (!errors[key].hidden) checkField(key); });
  }

  // --- способ входа: две карточки на выбор ---------------------------------
  let auth = config.auth;
  const userLabel = el('label', { for: 'f-user' });
  const authHelp = el('span', { class: 'help', id: 'f-user-help' });
  const authBox = el('div', { class: 'choice', role: 'radiogroup', 'aria-label': 'Способ входа' });
  f.user.id = 'f-user';
  f.user.setAttribute('aria-describedby', 'f-user-help');
  const drawAuth = () => {
    clear(authBox);
    for (const [value, title, text] of AUTH) {
      const radio = el('input', { type: 'radio', name: 'auth', value, checked: auth === value,
        onchange: () => { auth = value; drawAuth(); radio.focus(); } });
      authBox.append(el('label', { class: auth === value ? 'on' : '' }, radio,
        el('div', {}, el('b', {}, title), el('span', {}, text))));
    }
    userLabel.textContent = auth === 'windows' ? 'Логин Windows (ДОМЕН\\логин)' : 'Логин SQL Server';
    f.user.placeholder = auth === 'windows' ? 'CORP\\ivanov' : 'historian_reader';
    authHelp.textContent = auth === 'windows'
      ? 'Пишите домен и логин через обратную косую черту, как при входе в Windows. ' +
        'Если приложение запущено без Docker (start.bat) под этой же учётной записью, ' +
        'логин и пароль можно оставить пустыми, и вход будет как в SSMS.'
      : '';
  };
  drawAuth();

  // Шаг для Cyclic нужен только в режиме Cyclic
  const drawRetrieval = () => {
    f.resolution_ms.disabled = f.retrieval.value !== 'cyclic';
    if (f.resolution_ms.disabled) setError('resolution_ms', '');
  };
  f.retrieval.addEventListener('change', drawRetrieval);

  const values = () => {
    const out = {
      server: f.server.value.trim(), database: f.database.value.trim(), auth,
      user: f.user.value.trim(), password: f.password.value,
      include: f.include.value, exclude: f.exclude.value, strings: f.strings.checked,
      driver: f.driver.value, retrieval: f.retrieval.value, time_zone: f.time_zone.value.trim(),
      linked_server: f.linked_server.value.trim(),
    };
    for (const key of Object.keys(LIMITS)) {
      out[key] = f[key].value.trim().replace(/\s/g, '').replace(',', '.');
    }
    return out;
  };

  // Несохранённые правки: сравниваем с тем, что было при открытии или сохранении
  let savedValues = JSON.stringify(values());
  const changed = () => JSON.stringify(values()) !== savedValues || f.password.value !== '';
  const markSaved = () => { savedValues = JSON.stringify(values()); };

  // --- кнопки ---------------------------------------------------------------
  const result = el('div', { 'aria-live': 'polite' });
  const btnTest = el('button', { type: 'button', onclick: () => test() }, 'Проверить подключение');
  const btnStart = el('button', { class: 'primary', type: 'button', onclick: () => startCopy() },
    running ? 'Сохранить и перезапустить копирование' : 'Сохранить и начать копирование');
  const btnSave = el('button', { class: 'link', type: 'button', onclick: () => save(),
    hidden: running }, 'Сохранить, не запуская');

  async function busy(button, text, fn) {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = text;
    try { return await fn(); } finally { button.disabled = false; button.textContent = old; }
  }

  async function test() {
    if (!valid(true)) return;
    clear(result).append(el('div', { class: 'protocol' },
      el('div', { class: 'row' }, el('span', { class: 'spinner' }),
        'Проверяю: подключение, список тегов, чтение значений за 10 минут… ' +
        'Если сервер не отвечает, это займёт до 15 секунд.')));
    try {
      const report = await busy(btnTest, 'Проверяю…', () => post('/test', values()));
      clear(result).append(el('section', { class: 'protocol', 'aria-label': 'Протокол проверки' },
        el('div', { class: 'protocol-head' },
          el('h2', {}, report.ok ? 'Подключение работает' : 'Подключение не удалось'),
          el('time', {}, `проверено ${dateTime(Date.now() / 1000)}`)),
        el('p', { class: 'hint' }, report.ok
          ? 'Можно начинать копирование. Проверка ничего не сохраняет.'
          : 'Ниже — на каком шаге и почему. После исправления проверьте ещё раз.'),
        el('ol', { class: 'steps' }, report.steps.map((s) => el('li', { class: s.ok ? 'ok' : 'bad' },
          el('div', { class: 'title' }, icon(s.ok ? 'check' : 'cross', 'icon step-mark'),
            el('span', { class: 'sr-only' }, s.ok ? 'выполнено: ' : 'ошибка: '), s.title),
          s.detail ? el('div', { class: 'detail' }, s.detail) : null,
          s.items.length ? el('ul', {}, s.items.map((i) => el('li', {}, i))) : null)))));
      result.firstChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      clear(result);
      fail(error);
    }
  }

  async function save() {
    if (!valid(false)) return;
    try {
      shared.settings = await busy(btnSave, 'Сохраняю…', () => put('/settings', values()));
      f.password.value = '';
      f.password.placeholder = shared.settings.password_set ? SAVED_PASSWORD : '';
      markSaved();
      toast('Настройки сохранены. Копирование не запущено', 'ok');
    } catch (error) { fail(error); }
  }

  async function startCopy() {
    if (!valid(true)) return;
    try {
      await busy(btnStart, running ? 'Перезапускаю…' : 'Запускаю…',
        () => post('/copy/start', values()));
      shared.settings = await get('/settings');
      f.password.value = '';
      markSaved();
      toast(running ? 'Сохранено, копирование перезапущено' : 'Копирование запущено', 'ok');
      location.hash = '#/loading';
    } catch (error) { fail(error); }
  }

  // --- страница -------------------------------------------------------------
  const advanced = el('details', { class: 'card' },
    el('summary', {}, 'Дополнительно (менять, только если что-то не работает)'),
    el('div', { class: 'fields' },
      field('driver', 'Драйвер', 'По умолчанию для логина SQL Server берётся Microsoft ODBC, ' +
        'а для учётной записи Windows FreeTDS. Если с одним драйвером подключиться не ' +
        'удаётся, попробуйте другой.'),
      field('retrieval', 'Режим выборки', 'Delta даёт точную копию того, что записал историк. ' +
        'Cyclic даёт одно значение на каждый шаг и меньше строк, если теги меняются очень ' +
        'часто.'),
      field('resolution_ms', 'Шаг для Cyclic, мс', 'Только для режима Cyclic, от 100 мс.'),
      field('time_zone', 'Часовой пояс ответа', 'Оставьте пустым, и историк отдаст время ' +
        'сразу в UTC, так лучше всего. Если историк не принимает wwTimeZone, укажите пояс ' +
        'сервера, например Europe/Moscow.'),
      field('linked_server', 'Связанный сервер', 'Только если подключаетесь не к самому ' +
        'историку, а к другому SQL Server, где историк подключён связанным сервером ' +
        '(обычно INSQL).'),
      field('lag_s', 'Не брать последние, с', 'Самые свежие секунды историк может ещё ' +
        'дописывать. Обычно 3.'),
      field('overlap_s', 'Перекрытие, с', 'При каждом опросе немного перечитывать уже ' +
        'скопированное, чтобы подхватить значения, пришедшие с опозданием. Обычно 30.')));

  view.append(
    el('h1', {}, 'Подключение к AVEVA Historian'),
    el('p', { class: 'lead' }, 'Заполните три раздела, проверьте подключение и запустите ' +
      'копирование. Приложение только читает историк и ничего в него не записывает.'),

    el('section', { class: 'card' },
      el('h2', {}, '1. Сервер'),
      el('p', { class: 'hint' }, 'Те же данные, что вы вводите в SSMS при подключении к историку.'),
      el('div', { class: 'fields' },
        field('server', 'Сервер историка *', 'Имя компьютера, как в SSMS в поле «Server name». ' +
          'Из Docker надёжнее полное имя с доменом (HISTSRV01.домен.local) или IP-адрес. ' +
          'Именованный экземпляр пишется как СЕРВЕР\\ЭКЗЕМПЛЯР.'),
        field('port', 'Порт', 'Если оставить пустым, будет стандартный 1433.'),
        field('database', 'База', 'У AVEVA Historian это Runtime.'))),

    el('section', { class: 'card' },
      el('h2', {}, '2. Вход'),
      el('p', { class: 'hint' }, 'Учётной записи достаточно права только на чтение базы Runtime.'),
      authBox,
      el('div', { class: 'fields', style: 'margin-top:12px' },
        el('div', { class: 'field' }, userLabel, f.user, authHelp),
        field('password', 'Пароль', 'Хранится в базе приложения и в интерфейсе не показывается.'))),

    el('section', { class: 'card' },
      el('h2', {}, '3. Что копировать'),
      el('p', { class: 'hint' }, 'Теги выбираются по именам из таблицы Runtime.dbo.Tag. ' +
        'Новые теги, подходящие под маски, подхватываются сами в течение 10 минут.'),
      el('div', { class: 'fields' },
        field('include', 'Какие теги копировать', 'Маски через запятую или с новой строки. ' +
          'Звёздочка заменяет любые символы, знак вопроса один символ. Пустое поле значит все ' +
          'теги историка.', true),
        field('exclude', 'Кроме тегов', 'Sys* означает служебные теги самого историка, их ' +
          'копировать не нужно. Пустое поле значит без исключений.'),
        field('poll_s', 'Забирать новые значения раз в, с', 'Обычно 5 секунд.'),
        field('history_hours', 'Загрузить историю за последние, ч', 'Сколько прошлого ' +
          'скопировать при первом запуске: 24 часа это сутки, 168 неделя, 0 только новые ' +
          'значения.'),
        el('label', { class: 'check wide' }, f.strings,
          'Копировать и строковые теги (имя рецепта, номер партии)'))),

    advanced,

    el('div', { class: 'actions' }, btnTest, btnStart, btnSave,
      running ? el('span', { class: 'muted' }, 'Копирование идёт. Остановить его можно на ',
        el('a', { href: '#/loading' }, 'странице «Копирование»'), '.') : null),
    result,
  );
  drawRetrieval();

  // Правки после проверки: протокол больше не про эти настройки
  const outdated = () => {
    const protocol = result.querySelector('.protocol');
    if (!protocol || protocol.classList.contains('stale')) return;
    protocol.classList.add('stale');
    protocol.prepend(el('p', { class: 'note warn' }, 'Настройки изменены после проверки. ' +
      'Проверьте подключение ещё раз.'));
  };
  const onEdit = (e) => { if (!result.contains(e.target)) outdated(); };
  view.addEventListener('input', onEdit);
  view.addEventListener('change', onEdit);
  // Закрытие вкладки или перезагрузка с несохранёнными правками: браузер переспросит
  const beforeUnload = (e) => {
    if (changed()) e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);

  return {
    destroy() {
      // view общий для всех страниц: снимаем то, что повесили на него и на окно
      view.removeEventListener('input', onEdit);
      view.removeEventListener('change', onEdit);
      window.removeEventListener('beforeunload', beforeUnload);
    },
    async leave() {
      return !changed() || confirmDialog('Настройки не сохранены',
        'Вы изменили настройки подключения, но не сохранили их. Если уйти со страницы, ' +
        'изменения пропадут.', 'Уйти без сохранения');
    },
  };
}
