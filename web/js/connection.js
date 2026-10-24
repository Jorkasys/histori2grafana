// Страница «Подключение»: адрес историка, вход, какие теги копировать.

import { clear, el, fail, get, post, put, shared, toast } from './core.js';

const AUTH = [
  ['sql', 'Логин SQL Server',
    'Отдельный логин SQL Server с правом чтения базы Runtime. Его выдаёт администратор ' +
    'историка. Этот способ надёжнее всего.'],
  ['windows', 'Учётная запись Windows',
    'Доменная учётная запись, под которой вы входите в SSMS: логин в виде ДОМЕН\\логин ' +
    '(например CORP\\ivanov) и пароль от неё.'],
];

function field(label, input, help, wide = false) {
  return el('label', { class: `field${wide ? ' wide' : ''}` }, label, input,
    help ? el('span', { class: 'help' }, help) : null);
}

function select(options, value) {
  const node = el('select', {}, options.map(([v, text]) => el('option', { value: v }, text)));
  node.value = value;
  return node;
}

export async function connectionPage(view) {
  const [config, status] = await Promise.all([get('/settings'), get('/status')]);
  shared.settings = config;
  let running = status.copy.running;

  const f = {
    server: el('input', { value: config.server, placeholder: 'HISTSRV01 или 10.20.30.40' }),
    port: el('input', { value: config.port ?? '', placeholder: '1433', inputmode: 'numeric' }),
    database: el('input', { value: config.database }),
    user: el('input', { value: config.user, autocomplete: 'off' }),
    password: el('input', {
      type: 'password', autocomplete: 'new-password',
      placeholder: config.password_set ? 'сохранён; пустое поле его не меняет' : '',
    }),
    include: el('textarea', { placeholder: 'пустое поле: все теги историка\nили маски: Line1_*, Mixer_*' }),
    exclude: el('input', { value: config.exclude }),
    strings: el('input', { type: 'checkbox', checked: config.strings }),
    poll_s: el('input', { value: config.poll_s, inputmode: 'numeric' }),
    history_hours: el('input', { value: config.history_hours, inputmode: 'numeric' }),
    driver: select([['auto', 'Автоматически (рекомендуется)'],
      ['odbc', 'Microsoft ODBC Driver 18 for SQL Server'], ['freetds', 'FreeTDS']], config.driver),
    retrieval: select([['delta', 'Delta: каждое изменение, как записал историк'],
      ['cyclic', 'Cyclic: одно значение на каждый шаг']], config.retrieval),
    resolution_ms: el('input', { value: config.resolution_ms, inputmode: 'numeric' }),
    time_zone: el('input', { value: config.time_zone, placeholder: 'пустое поле: UTC' }),
    linked_server: el('input', { value: config.linked_server, placeholder: 'обычно не нужен' }),
    lag_s: el('input', { value: config.lag_s, inputmode: 'numeric' }),
    overlap_s: el('input', { value: config.overlap_s, inputmode: 'numeric' }),
  };
  f.include.value = config.include;

  // --- способ входа: две карточки на выбор ---------------------------------
  let auth = config.auth;
  const userLabel = el('span', {});
  const authHelp = el('span', { class: 'help' });
  const authBox = el('div', { class: 'choice' });
  const drawAuth = () => {
    clear(authBox);
    for (const [value, title, text] of AUTH) {
      const radio = el('input', { type: 'radio', name: 'auth', value, checked: auth === value,
        onchange: () => { auth = value; drawAuth(); } });
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

  const values = () => ({
    server: f.server.value.trim(),
    port: f.port.value.trim(),
    database: f.database.value.trim(),
    auth,
    user: f.user.value.trim(),
    password: f.password.value,
    include: f.include.value,
    exclude: f.exclude.value,
    strings: f.strings.checked,
    poll_s: f.poll_s.value.trim(),
    history_hours: f.history_hours.value.trim(),
    driver: f.driver.value,
    retrieval: f.retrieval.value,
    resolution_ms: f.resolution_ms.value.trim(),
    time_zone: f.time_zone.value.trim(),
    linked_server: f.linked_server.value.trim(),
    lag_s: f.lag_s.value.trim(),
    overlap_s: f.overlap_s.value.trim(),
  });

  // --- кнопки ---------------------------------------------------------------
  const result = el('div', {});
  const btnTest = el('button', { onclick: () => test() }, 'Проверить подключение');
  const btnSave = el('button', { onclick: () => save() }, 'Сохранить');
  const btnStart = el('button', { class: 'primary', onclick: () => startCopy() });
  const btnStop = el('button', { class: 'danger', onclick: () => stopCopy() },
    'Остановить копирование');
  const drawButtons = () => {
    btnStart.textContent = running ? 'Сохранить и перезапустить копирование'
      : 'Сохранить и начать копирование';
    btnStop.style.display = running ? '' : 'none';
  };
  drawButtons();

  async function busy(button, text, fn) {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = text;
    try { return await fn(); } finally { button.disabled = false; button.textContent = old; }
  }

  async function test() {
    clear(result).append(el('div', { class: 'card' },
      el('div', { class: 'row' }, el('span', { class: 'spinner' }),
        'Проверяю: подключение, список тегов, чтение значений за 10 минут… ' +
        'Если сервер не отвечает, это займёт до 15 секунд.')));
    try {
      const report = await busy(btnTest, 'Проверяю…', () => post('/test', values()));
      clear(result).append(el('div', { class: 'card' },
        el('h2', {}, report.ok ? 'Подключение работает' : 'Подключение не удалось'),
        el('p', { class: 'hint' }, report.ok
          ? 'Можно начинать копирование.'
          : 'Ниже — на каком шаге и почему. После исправления проверьте ещё раз.'),
        el('ul', { class: 'steps' }, report.steps.map((s) => el('li', { class: s.ok ? 'ok' : 'bad' },
          el('div', { class: 'title' }, s.title),
          s.detail ? el('div', { class: 'detail' }, s.detail) : null,
          s.items.length ? el('ul', {}, s.items.map((i) => el('li', {}, i))) : null)))));
      result.firstChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      clear(result);
      fail(error);
    }
  }

  async function save() {
    try {
      shared.settings = await busy(btnSave, 'Сохраняю…', () => put('/settings', values()));
      f.password.value = '';
      f.password.placeholder = shared.settings.password_set
        ? 'сохранён — оставьте пустым, чтобы не менять' : '';
      toast(running ? 'Сохранено, копирование перезапущено' : 'Сохранено', 'ok');
    } catch (error) { fail(error); }
  }

  async function startCopy() {
    try {
      await busy(btnStart, 'Запускаю…', () => post('/copy/start', values()));
      shared.settings = await get('/settings');
      toast('Копирование запущено', 'ok');
      location.hash = '#/loading';
    } catch (error) { fail(error); }
  }

  async function stopCopy() {
    try {
      await busy(btnStop, 'Останавливаю…', () => post('/copy/stop'));
      running = false;
      drawButtons();
      toast('Копирование остановлено', 'ok');
    } catch (error) { fail(error); }
  }

  // --- страница -------------------------------------------------------------
  view.append(
    el('h1', {}, 'Подключение к AVEVA Historian'),
    el('p', { class: 'lead' }, 'Укажите сервер историка и учётную запись, проверьте подключение ' +
      'и запустите копирование. Приложение только читает историк и ничего в него не записывает.'),

    el('div', { class: 'card' },
      el('h2', {}, 'Сервер'),
      el('p', { class: 'hint' }, 'Те же данные, что вы вводите в SSMS при подключении к историку.'),
      el('div', { class: 'fields' },
        field('Сервер историка *', f.server, 'Имя компьютера, как в SSMS в поле «Server name». ' +
          'Из Docker надёжнее полное имя с доменом (HISTSRV01.домен.local) или IP-адрес. ' +
          'Именованный экземпляр пишется как СЕРВЕР\\ЭКЗЕМПЛЯР.'),
        field('Порт', f.port, 'Если оставить пустым, будет стандартный 1433.'),
        field('База', f.database, 'У AVEVA Historian это Runtime.'))),

    el('div', { class: 'card' },
      el('h2', {}, 'Вход'),
      el('p', { class: 'hint' }, 'Учётной записи достаточно права только на чтение базы Runtime.'),
      authBox,
      el('div', { class: 'fields', style: 'margin-top:12px' },
        el('label', { class: 'field' }, userLabel, f.user, authHelp),
        field('Пароль', f.password, 'Хранится в базе приложения и в интерфейсе не показывается.'))),

    el('div', { class: 'card' },
      el('h2', {}, 'Что копировать'),
      el('p', { class: 'hint' }, 'Теги выбираются по именам из таблицы Runtime.dbo.Tag. ' +
        'Новые теги, подходящие под маски, подхватываются сами в течение 10 минут.'),
      el('div', { class: 'fields' },
        field('Какие теги копировать', f.include, 'Маски через запятую или с новой строки. ' +
          'Звёздочка заменяет любые символы, знак вопроса один символ. Пустое поле значит все ' +
          'теги историка.', true),
        field('Кроме тегов', f.exclude, 'Sys* означает служебные теги самого историка, их ' +
          'копировать не нужно. Пустое поле значит без исключений.'),
        field('Забирать новые значения раз в, с', f.poll_s, 'Обычно 5 секунд.'),
        field('Загрузить историю за последние, ч', f.history_hours, 'Сколько прошлого ' +
          'скопировать при первом запуске: 24 часа это сутки, 168 неделя, 0 только новые ' +
          'значения.'),
        el('label', { class: 'check wide' }, f.strings,
          'Копировать и строковые теги (имя рецепта, номер партии)'))),

    el('details', { class: 'card' },
      el('summary', {}, 'Дополнительно (менять, только если что-то не работает)'),
      el('div', { class: 'fields' },
        field('Драйвер', f.driver, 'По умолчанию для логина SQL Server берётся Microsoft ODBC, ' +
          'а для учётной записи Windows FreeTDS. Если с одним драйвером подключиться не ' +
          'удаётся, попробуйте другой.'),
        field('Режим выборки', f.retrieval, 'Delta даёт точную копию того, что записал историк. ' +
          'Cyclic даёт меньше строк, если теги меняются очень часто.'),
        field('Шаг для Cyclic, мс', f.resolution_ms, 'Только для режима Cyclic.'),
        field('Часовой пояс ответа', f.time_zone, 'Оставьте пустым, и историк отдаст время ' +
          'сразу в UTC, так лучше всего. Если историк не принимает wwTimeZone, укажите пояс ' +
          'сервера, например Europe/Moscow.'),
        field('Связанный сервер', f.linked_server, 'Только если подключаетесь не к самому ' +
          'историку, а к другому SQL Server, где историк подключён связанным сервером ' +
          '(обычно INSQL).'),
        field('Не брать последние, с', f.lag_s, 'Самые свежие секунды историк может ещё ' +
          'дописывать. Обычно 3.'),
        field('Перекрытие, с', f.overlap_s, 'При каждом обмене немного перечитывать уже ' +
          'скопированное, чтобы подхватить значения, пришедшие с опозданием. Обычно 30.'))),

    el('div', { class: 'actions' }, btnTest, btnSave, btnStart, btnStop),
    result,
  );
  return {};
}
