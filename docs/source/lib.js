// Блоки Word для руководств (docs/source/build.js): заголовки, абзацы со
// **жирным** и `кодом`, списки, код, заметки, таблицы и рисунки с подписями.
// Нужен пакет docx: npm install docx@9.13.0 в этой папке.
const fs = require('fs');
const {
  Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType, ImageRun, PageBreak, LevelFormat,
} = require('docx');

const FONT = 'Calibri';
const CODE = 'Consolas';
const TEXT_W = 9638;          // ширина текста A4 при полях 2 см

// **жирный**, `код`, [текст](ссылка) → текст
function runs(text, base = {}) {
  const out = [];
  const clean = String(text).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  for (const part of clean.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**')) out.push(new TextRun({ ...base, text: part.slice(2, -2), bold: true }));
    else if (part.startsWith('`')) {
      out.push(new TextRun({ ...base, text: part.slice(1, -1), font: CODE, size: 20, color: '1F3864' }));
    } else out.push(new TextRun({ ...base, text: part }));
  }
  return out;
}

const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
const h3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(text)] });
const p = (text) => new Paragraph({ spacing: { after: 120 }, children: runs(text) });
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

let listNo = 0;
function list(items, numbered) {
  listNo += 1;
  const out = [];
  items.forEach((item, k) => {
    const [text, sub] = Array.isArray(item) ? item : [item, null];
    const last = k === items.length - 1;
    out.push(new Paragraph({ spacing: { after: last && !(sub && sub.length) ? 140 : 60 },
      children: runs(text),
      numbering: numbered ? { reference: 'numbers', level: 0, instance: listNo }
        : { reference: 'bullets', level: 0 } }));
    (sub || []).forEach((s, j) => {
      out.push(new Paragraph({ spacing: { after: last && j === sub.length - 1 ? 140 : 40 },
        children: runs(s), numbering: { reference: 'bullets', level: 1 } }));
    });
  });
  return out;
}
const ul = (items) => list(items, false);
const ol = (items) => list(items, true);

const numbering = {
  config: [
    { reference: 'bullets', levels: [
      { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 567, hanging: 283 } } } },
      { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 1134, hanging: 283 } } } },
    ] },
    { reference: 'numbers', levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 567, hanging: 340 } } } },
    ] },
  ],
};

function code(lines) {
  const shade = { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' };
  return lines.map((line, i) => new Paragraph({
    shading: shade, spacing: { before: i ? 0 : 80, after: i === lines.length - 1 ? 160 : 0, line: 252 },
    indent: { left: 170, right: 170 }, keepNext: i < lines.length - 1,
    children: [new TextRun({ text: line || ' ', font: CODE, size: 19 })],
  }));
}

function note(kind, text) {
  const look = {
    warn: ['Важно.', 'B45309', 'FEF6E7'],
    tip: ['Совет.', '2E7D32', 'EEF7EE'],
    info: ['Примечание.', '2E5597', 'EEF3FA'],
  }[kind];
  return new Paragraph({
    spacing: { before: 80, after: 160 }, indent: { left: 170, right: 170 },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: look[2] },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: look[1], space: 8 } },
    children: [new TextRun({ text: `${look[0]} `, bold: true, color: look[1] }), ...runs(text)],
  });
}

function table(header, rows, widths) {
  const n = header.length;
  const raw = widths && widths.length === n ? widths : Array(n).fill(1);
  const total = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => Math.round((x / total) * TEXT_W));
  const line = { style: BorderStyle.SINGLE, size: 4, color: 'C9CED6' };
  const cell = (text, head, i) => new TableCell({
    width: { size: w[i], type: WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF1F5' } : undefined,
    borders: { top: line, bottom: line, left: line, right: line },
    children: String(text).split('\n').map((t) => new Paragraph({ spacing: { after: 0 },
      children: runs(t, { size: 20, bold: head || undefined }) })),
  });
  return [
    new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: w,
      rows: [new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, true, i)) }),
        ...rows.map((r) => new TableRow({ cantSplit: true,
          children: r.map((c, i) => cell(c, false, i)) }))] }),
    new Paragraph({ spacing: { after: 120 }, children: [] }),
  ];
}

let figure = 0;
function img(file, caption, widthPx) {
  figure += 1;
  const data = fs.readFileSync(file);
  const w = data.readUInt32BE(16);
  const h = data.readUInt32BE(20);
  const width = Math.min(widthPx, w);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true,
      children: [new ImageRun({ type: 'png', data, transformation: { width, height: Math.round(width * h / w) },
        altText: { title: caption, description: caption, name: caption } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: `Рис. ${figure}. ${caption}`, italics: true, size: 20, color: '4B5563' })] }),
  ];
}

// Номера рисунков и нумерованных списков — заново для каждого документа
function reset() {
  figure = 0;
  listNo = 0;
}

module.exports = {
  FONT, runs, h1, h2, h3, p, ul, ol, code, note, table, img, pageBreak, numbering, reset,
};
