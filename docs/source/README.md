# Исходники документации

Руководства пишутся здесь один раз и собираются в несколько форматов:

| Исходник | Что получается |
|---|---|
| `install.js` | `docs/INSTALL.md` и `docs/Инструкция.docx` — развёртывание и работа |
| `scripts-guide.js` | `docs/SCRIPTS.md`, `docs/Скрипты.docx` и страница приложения `web/help/scripts.html` — скрипты для начинающих |

Текст — список блоков: `['h1', 'Заголовок']`, `['p', 'Абзац']`, `['code', [строки], 'python']`,
`['table', [заголовки], [строки], [ширины]]`, `['img', 'файл.png', 'подпись']` и т. п. Внутри строк:
`**жирный**`, `` `код` ``. Рисунки — в `docs/img`.

## Сборка

Нужны Node.js и Microsoft Word.

```powershell
cd docs\source
npm install docx@9.13.0          # один раз
node build.js                    # Markdown, Word и страница в приложении
powershell -ExecutionPolicy Bypass -File toc.ps1   # оглавления в Word
```

Номер версии на титульном листе берётся из `app/__init__.py`.
