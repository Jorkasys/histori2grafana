// Сборка документации: node docs/source/build.js
//
// Каждое руководство пишется один раз — списком блоков в install.js или
// scripts-guide.js — и собирается в Markdown (для GitHub) и Word. Руководство по
// скриптам ещё и страницей самого приложения: web/help/scripts.html, чтобы оно
// открывалось и на компьютере без интернета.
//
// Оглавление в Word заполняет сам Word: после сборки запустите toc.ps1.
const fs = require('fs');
const path = require('path');
const TEXT_ONLY = process.argv.includes('--text-only');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, TableOfContents, Footer, PageNumber,
} = TEXT_ONLY ? {} : require('docx');
const L = TEXT_ONLY ? null : require('./lib.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const IMG = path.join(DOCS, 'img');
const VERSION = (fs.readFileSync(path.join(ROOT, 'app', '__init__.py'), 'utf8')
  .match(/__version__ = "([^"]+)"/) || [])[1] || '';
const MONTH = new Date().toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
  .replace(/\s*г\.?$/, '');

const GUIDES = [
  { content: './install.js', md: 'INSTALL.md', docx: 'Инструкция.docx', footer: 'инструкция' },
  { content: './scripts-guide.js', md: 'SCRIPTS.md', docx: 'Скрипты.docx', footer: 'скрипты',
    html: path.join(ROOT, 'web', 'help', 'scripts.html') },
];

// ------------------------------------------------------------------ Markdown
function slug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}

function mdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function markdown(content) {
  const out = [];
  let figure = 0;
  const h1s = content.filter((b) => b[0] === 'h1').map((b) => b[1]);
  for (const block of content) {
    const [kind, ...a] = block;
    if (kind === 'title') {
      out.push(`# ${a[0]} — ${a[1].charAt(0).toLowerCase()}${a[1].slice(1)}`, '');
    } else if (kind === 'toc') {
      out.push('**Содержание**', '');
      for (const h of h1s) out.push(`- [${h}](#${slug(h)})`);
      out.push('');
    } else if (kind === 'h1') {
      out.push(`## ${a[0]}`, '');
    } else if (kind === 'h2') {
      out.push(`### ${a[0]}`, '');
    } else if (kind === 'h3') {
      out.push(`#### ${a[0]}`, '');
    } else if (kind === 'p') {
      out.push(a[0], '');
    } else if (kind === 'ul' || kind === 'ol') {
      a[0].forEach((item, i) => {
        const [text, sub] = Array.isArray(item) ? item : [item, null];
        out.push(`${kind === 'ul' ? '-' : `${i + 1}.`} ${text}`);
        for (const s of sub || []) out.push(`   - ${s}`);
      });
      out.push('');
    } else if (kind === 'code') {
      out.push('```' + (a[1] || ''), ...a[0], '```', '');
    } else if (kind === 'note') {
      const label = { warn: 'Важно.', tip: 'Совет.', info: 'Примечание.' }[a[0]];
      out.push(`> **${label}** ${a[1]}`, '');
    } else if (kind === 'table') {
      const [header, rows] = a;
      out.push(`| ${header.map(mdCell).join(' | ')} |`);
      out.push(`|${header.map(() => '---').join('|')}|`);
      for (const r of rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
      out.push('');
    } else if (kind === 'img') {
      figure += 1;
      out.push(`![${a[1]}](img/${a[0]})`, '', `*Рис. ${figure}. ${a[1]}*`, '');
    } else if (kind === 'qa') {
      out.push(`**${a[0]}**  `, a[1], '');
    } else if (kind === 'pagebreak') {
      // только для Word
    } else {
      throw new Error(`неизвестный блок ${kind}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------- Word
function docxBlocks(content) {
  const out = [];
  for (const block of content) {
    const [kind, ...a] = block;
    if (kind === 'title') {
      out.push(
        new Paragraph({ spacing: { before: 2800, after: 240 }, alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: a[0], bold: true, size: 64, color: '1F3864' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 },
          children: [new TextRun({ text: a[1], size: 34, color: '1F3864' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 },
          children: [new TextRun({ text: a[2] || '', size: 24, color: '374151' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 1600, after: 1600 },
          children: [new TextRun({ text: `Версия ${VERSION}, ${MONTH}`, size: 22, color: '6B7280' })] }),
      );
    } else if (kind === 'toc') {
      // Вступление остаётся на титульной странице, оглавление — со следующей
      out.push(
        L.pageBreak(),
        new Paragraph({ spacing: { after: 200 },
          children: [new TextRun({ text: 'Содержание', bold: true, size: 32, color: '1F3864' })] }),
        new TableOfContents('Содержание', { hyperlink: true, headingStyleRange: '1-2' }),
        L.pageBreak(),
      );
    } else if (kind === 'pagebreak') out.push(L.pageBreak());
    else if (kind === 'h1') out.push(L.h1(a[0]));
    else if (kind === 'h2') out.push(L.h2(a[0]));
    else if (kind === 'h3') out.push(L.h3(a[0]));
    else if (kind === 'p') out.push(L.p(a[0]));
    else if (kind === 'ul') out.push(...L.ul(a[0]));
    else if (kind === 'ol') out.push(...L.ol(a[0]));
    else if (kind === 'code') out.push(...L.code(a[0]));
    else if (kind === 'note') out.push(L.note(a[0], a[1]));
    else if (kind === 'table') out.push(...L.table(a[0], a[1], a[2]));
    else if (kind === 'img') out.push(...L.img(path.join(IMG, a[0]), a[1], 560));
    else if (kind === 'qa') {
      out.push(new Paragraph({ spacing: { before: 120, after: 40 }, keepNext: true,
        children: L.runs(`**${a[0]}**`) }), L.p(a[1]));
    } else throw new Error(`неизвестный блок ${kind}`);
  }
  return out;
}

function word(content, guide) {
  L.reset();
  const title = content.find((b) => b[0] === 'title');
  return new Document({
    creator: 'historian2grafana',
    lastModifiedBy: 'historian2grafana',
    title: `${title[1]} — ${title[2]}`,
    styles: {
      default: { document: { run: { font: L.FONT, size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, color: '1F3864', font: L.FONT },
          paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: '2E5597', font: L.FONT },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1, keepNext: true } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 23, bold: true, color: '374151', font: L.FONT },
          paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2, keepNext: true } },
      ],
    },
    numbering: L.numbering,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 },
        margin: { top: 1134, bottom: 1134, left: 1134, right: 1134, footer: 567 } },
      titlePage: true },
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: [`historian2grafana, ${guide.footer}, стр. `,
            PageNumber.CURRENT], size: 18, color: '6B7280' })] })] }),
        first: new Footer({ children: [new Paragraph({ children: [] })] }),
      },
      children: docxBlocks(content),
    }],
  });
}

// ------------------------------------------------------- страница приложения
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  return esc(text).split(/(`[^`]+`)/).map((part) => (part.startsWith('`')
    ? `<code>${part.slice(1, -1)}</code>`
    : part.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'))).join('');
}

function html(content, images) {
  const out = [];
  let figure = 0;
  const title = content.find((b) => b[0] === 'title');
  const heading = `${title[1]}: ${title[2].charAt(0).toLowerCase()}${title[2].slice(1)}`;
  const h1s = content.filter((b) => b[0] === 'h1').map((b) => b[1]);
  for (const block of content) {
    const [kind, ...a] = block;
    if (kind === 'title') {
      out.push(`<h1>${esc(heading)}</h1>`);
    } else if (kind === 'toc') {
      out.push('<nav class="guide-toc"><p class="side-title">Содержание</p><ol>',
        ...h1s.map((h) => `<li><a href="#${slug(h)}">${esc(h.replace(/^\d+\.\s*/, ''))}</a></li>`),
        '</ol></nav>');
    } else if (kind === 'h1') {
      out.push(`<h2 id="${slug(a[0])}">${esc(a[0])}</h2>`);
    } else if (kind === 'h2') {
      out.push(`<h3>${esc(a[0])}</h3>`);
    } else if (kind === 'h3') {
      out.push(`<h4>${esc(a[0])}</h4>`);
    } else if (kind === 'p') {
      out.push(`<p>${inline(a[0])}</p>`);
    } else if (kind === 'ul' || kind === 'ol') {
      out.push(`<${kind}>`);
      for (const item of a[0]) {
        const [text, sub] = Array.isArray(item) ? item : [item, null];
        out.push(`<li>${inline(text)}${sub ? `<ul>${sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>` : ''}</li>`);
      }
      out.push(`</${kind}>`);
    } else if (kind === 'code') {
      out.push(`<pre class="output">${esc(a[0].join('\n'))}</pre>`);
    } else if (kind === 'note') {
      const [label, cls] = { warn: ['Важно.', 'warn'], tip: ['Совет.', 'ok'], info: ['Примечание.', ''] }[a[0]];
      out.push(`<div class="note ${cls}"><b>${label}</b> ${inline(a[1])}</div>`);
    } else if (kind === 'table') {
      const [header, rows] = a;
      out.push('<div class="table-wrap"><table><thead><tr>',
        ...header.map((h) => `<th>${inline(h)}</th>`), '</tr></thead><tbody>',
        ...rows.map((r) => `<tr>${r.map((c) => `<td>${String(c).split('\n').map(inline).join('<br>')}</td>`).join('')}</tr>`),
        '</tbody></table></div>');
    } else if (kind === 'img') {
      figure += 1;
      images.add(a[0]);
      out.push(`<figure><img src="img/${esc(a[0])}" alt="${esc(a[1])}" loading="lazy">` +
        `<figcaption>Рис. ${figure}. ${esc(a[1])}</figcaption></figure>`);
    } else if (kind === 'qa') {
      out.push(`<p><b>${inline(a[0])}</b><br>${inline(a[1])}</p>`);
    }
  }
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(heading)}</title>
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="guide.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="../#/scripts">
      <svg viewBox="0 0 24 24" class="brand-mark" aria-hidden="true">
        <path d="M2 15h3l2-7 3 11 3-14 3 10 2-4h4" fill="none" stroke="currentColor"
              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      historian2grafana
    </a>
    <nav class="nav"><a href="../#/scripts">Вернуться к скриптам</a></nav>
  </header>
  <main class="guide">
${out.join('\n')}
  </main>
  <footer class="footer">historian2grafana ${esc(VERSION)}</footer>
</body>
</html>
`;
}

// ------------------------------------------------------------------- сборка
async function main() {
  for (const guide of GUIDES) {
    if (process.argv.includes('--scripts-only') && guide.content !== './scripts-guide.js') continue;
    delete require.cache[require.resolve(guide.content)];
    const content = require(guide.content);
    fs.writeFileSync(path.join(DOCS, guide.md), markdown(content), 'utf8');
    if (!TEXT_ONLY) {
      fs.writeFileSync(path.join(DOCS, guide.docx), await Packer.toBuffer(word(content, guide)));
    }
    console.log('ok', guide.md, TEXT_ONLY ? '(без Word)' : guide.docx);
    if (guide.html) {
      const images = new Set();
      fs.writeFileSync(guide.html, html(content, images), 'utf8');
      const dir = path.join(path.dirname(guide.html), 'img');
      fs.mkdirSync(dir, { recursive: true });
      for (const name of images) fs.copyFileSync(path.join(IMG, name), path.join(dir, name));
      console.log('ok', path.relative(ROOT, guide.html), `(${images.size} рисунков)`);
    }
  }
}

main();
