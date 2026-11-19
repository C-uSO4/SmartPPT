const FONT = 'Microsoft YaHei';
const THEMES = {
  paper: {
    background: '#F3F1EB', ink: '#153B3C', muted: '#647472',
    accent: '#087F73', secondary: '#E76F51', card: '#FFFFFF', line: '#D5DEDA',
  },
  midnight: {
    background: '#101820', ink: '#F4F1E8', muted: '#A9B6BC',
    accent: '#56C7B7', secondary: '#FFB65C', card: '#182832', line: '#33444D',
  },
  azure: {
    background: '#F3F7FC', ink: '#142B4A', muted: '#60708A',
    accent: '#2563EB', secondary: '#E35D6A', card: '#FFFFFF', line: '#D5E1F0',
  },
};
let THEME = { ...THEMES.paper };

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function codePointLength(value) {
  return Array.from(String(value)).length;
}

function pyRound(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const WIDE_FULLWIDTH_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3040, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cd5], [0x1b000, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const AMBIGUOUS_RANGES = [
  [0x00a1, 0x00a1], [0x00a4, 0x00a4], [0x00a7, 0x00a8], [0x00aa, 0x00aa],
  [0x00ad, 0x00ae], [0x00b0, 0x00b4], [0x00b6, 0x00ba], [0x00bc, 0x00bf],
  [0x00c6, 0x00c6], [0x00d0, 0x00d0], [0x00d7, 0x00d8], [0x00de, 0x00e1],
  [0x00e6, 0x00e6], [0x00e8, 0x00ea], [0x00ec, 0x00ed], [0x00f0, 0x00f0],
  [0x00f2, 0x00f3], [0x00f7, 0x00fa], [0x00fc, 0x00fc], [0x00fe, 0x00fe],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011b, 0x011b],
  [0x0126, 0x0127], [0x0131, 0x0133], [0x0138, 0x0138], [0x013f, 0x0142],
  [0x0144, 0x0144], [0x0148, 0x014b], [0x014d, 0x014d], [0x0152, 0x0153],
  [0x0166, 0x0167], [0x016b, 0x016b], [0x01ce, 0x01ce], [0x01d0, 0x01d0],
  [0x01d2, 0x01d2], [0x01d4, 0x01d4], [0x01d6, 0x01d6], [0x01d8, 0x01d8],
  [0x01da, 0x01da], [0x01dc, 0x01dc], [0x0251, 0x0251], [0x0261, 0x0261],
  [0x02c4, 0x02c4], [0x02c7, 0x02c7], [0x02c9, 0x02cb], [0x02cd, 0x02cd],
  [0x02d0, 0x02d0], [0x02d8, 0x02db], [0x02dd, 0x02dd], [0x02df, 0x02df],
  [0x0300, 0x036f], [0x0391, 0x03a1], [0x03a3, 0x03a9], [0x03b1, 0x03c1],
  [0x03c3, 0x03c9], [0x0401, 0x0401], [0x0410, 0x044f], [0x0451, 0x0451],
  [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019], [0x201c, 0x201d],
  [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033],
  [0x2035, 0x2035], [0x203b, 0x203b], [0x203e, 0x203e], [0x2074, 0x2074],
  [0x207f, 0x207f], [0x2081, 0x2084], [0x20ac, 0x20ac], [0x2103, 0x2103],
  [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113], [0x2116, 0x2116],
  [0x2121, 0x2122], [0x2126, 0x2126], [0x212b, 0x212b], [0x2153, 0x2154],
  [0x215b, 0x215e], [0x2160, 0x216b], [0x2170, 0x2179], [0x2189, 0x2189],
  [0x2190, 0x2199], [0x21b8, 0x21b9], [0x21d2, 0x21d2], [0x21d4, 0x21d4],
  [0x21e7, 0x21e7], [0x2200, 0x2200], [0x2202, 0x2203], [0x2207, 0x2208],
  [0x220b, 0x220b], [0x220f, 0x220f], [0x2211, 0x2211], [0x2215, 0x2215],
  [0x221a, 0x221a], [0x221d, 0x2220], [0x2223, 0x2223], [0x2225, 0x2225],
  [0x2227, 0x222c], [0x222e, 0x222e], [0x2234, 0x2237], [0x223c, 0x223d],
  [0x2248, 0x2248], [0x224c, 0x224c], [0x2252, 0x2252], [0x2260, 0x2261],
  [0x2264, 0x2267], [0x226a, 0x226b], [0x226e, 0x226f], [0x2282, 0x2283],
  [0x2286, 0x2287], [0x2295, 0x2295], [0x2299, 0x2299], [0x22a5, 0x22a5],
  [0x22bf, 0x22bf], [0x2312, 0x2312], [0x2460, 0x24e9], [0x24eb, 0x254b],
  [0x2550, 0x2573], [0x2580, 0x2595], [0x25a0, 0x25a1], [0x25a3, 0x25a9],
  [0x25b2, 0x25b3], [0x25b6, 0x25b7], [0x25bc, 0x25bd], [0x25c0, 0x25c1],
  [0x25c6, 0x25c8], [0x25cb, 0x25cb], [0x25ce, 0x25d1], [0x25e2, 0x25e5],
  [0x25ef, 0x25ef], [0x2605, 0x2606], [0x2609, 0x2609], [0x260e, 0x260f],
  [0x261c, 0x261c], [0x261e, 0x261e], [0x2640, 0x2640], [0x2642, 0x2642],
  [0x2660, 0x2661], [0x2663, 0x2665], [0x2667, 0x266a], [0x266c, 0x266d],
  [0x266f, 0x266f], [0x269e, 0x269f], [0x26bf, 0x26bf], [0x26c6, 0x26cd],
  [0x26cf, 0x26d3], [0x26d5, 0x26e1], [0x26e3, 0x26e3], [0x26e8, 0x26e9],
  [0x26eb, 0x26f1], [0x26f4, 0x26f4], [0x26f6, 0x26f9], [0x26fb, 0x26fc],
  [0x26fe, 0x26ff], [0x273d, 0x273d], [0x2776, 0x277f], [0x2b56, 0x2b59],
  [0x3248, 0x324f], [0xe000, 0xf8ff], [0xfe00, 0xfe0f], [0xfffd, 0xfffd],
  [0x1f100, 0x1f10a], [0x1f110, 0x1f12d], [0x1f130, 0x1f169], [0x1f170, 0x1f18d],
  [0x1f18f, 0x1f190], [0x1f19b, 0x1f1ac], [0xe0100, 0xe01ef], [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
];

function inRanges(codePoint, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function textUnits(value) {
  let units = 0;
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    units += inRanges(codePoint, WIDE_FULLWIDTH_RANGES) || inRanges(codePoint, AMBIGUOUS_RANGES) ? 1 : 0.56;
  }
  return units;
}

function estimatedLines(value, width, sizePt) {
  const capacity = Math.max(1, width / (sizePt * 96 / 72));
  return String(value).split('\n').reduce((total, part) => {
    return total + Math.max(1, Math.floor((textUnits(part) + capacity - 1) / capacity));
  }, 0);
}

function fitFontSize(value, width, height, size, minimum = 10) {
  let candidate = size;
  while (candidate > minimum) {
    const lineHeight = candidate * 96 / 72 * 1.1;
    if (estimatedLines(value, width, candidate) * lineHeight <= height) break;
    candidate -= 0.5;
  }
  return Math.round(candidate * 10) / 10;
}

function text(x, y, w, h, value, size = 16, color = null, bold = false, align = 'left') {
  size = fitFontSize(value, w, h, size);
  const paragraphs = String(value).split('\n').map(part => ({
    align,
    lineSpacingPct: 110,
    spaceAfterPt: 0,
    bullet: false,
    runs: [{
      text: part,
      sizePt: size,
      bold,
      italic: false,
      color: color || THEME.ink,
      font: FONT,
    }],
  }));
  return { type: 'text', x, y, w, h, valign: 'top', paragraphs };
}

function shape(kind, x, y, w, h, fill, stroke = null) {
  const result = { type: 'shape', shape: kind, x, y, w, h, fill };
  if (stroke) result.stroke = { color: stroke, widthPt: 1 };
  return result;
}

function bodySize(value, widthChars = 28) {
  const lines = Math.max(1, Math.floor((codePointLength(value) + widthChars - 1) / widthChars));
  if (lines >= 5) return 12.5;
  if (lines >= 3) return 14;
  return 16;
}

function chooseLayout(section, index) {
  const items = section.items;
  const title = section.title;
  if (items.some(item => item.kind === 'image')) return items.length === 1 ? 'image' : 'gallery';
  if (items.length === 1 && items[0].kind === 'formula') return 'formula';
  if (!items.length || items.length === 1) return 'statement';
  if (items.length === 2) return /对比|比较|versus|\bvs\b|差异/i.test(title) ? 'compare' : 'editorial';
  if (items.some(item => codePointLength(item.text) > 120)) return 'editorial';
  if (/流程|步骤|路径|阶段|计划/.test(title)) return 'timeline';
  if (items.filter(item => item.numbers && item.numbers.length).length * 2 >= items.length) return 'data';
  if (items.length === 4) return 'grid';
  if (items.length === 3) return ['cards', 'editorial', 'focus'][index % 3];
  return 'editorial';
}

function splitItems(items) {
  if (!items.length) return [[]];
  const limit = items.some(item => codePointLength(item.text) > 120) ? 2 : 4;
  const chunks = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const itemLength = codePointLength(item.text);
    if (current.length && (current.length >= limit || length + itemLength > 330)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += itemLength;
  }
  if (current.length) chunks.push(current);
  if (chunks.length > 1 && chunks[chunks.length - 1].length === 1 && chunks[chunks.length - 2].length > 2) {
    chunks[chunks.length - 1].unshift(chunks[chunks.length - 2].pop());
  }
  return chunks;
}

function basePage(titleValue, pageNumber, sectionIndex, sectionCount, motion, fade) {
  const elements = [
    shape('rect', 0, 0, 1280, 720, THEME.background),
    text(170, 38, 400, 28, 'CONTENT / FORM', 10, THEME.accent, true),
    text(170, 76, 940, 66, titleValue, 30, THEME.ink, true),
    shape('line', 170, 156, 1010, 1, '#00000000', THEME.line),
    text(1080, 46, 100, 28, String(pageNumber).padStart(2, '0'), 12, THEME.muted, true, 'right'),
  ];
  fade.push(1, 2);
  if (sectionCount) {
    const top = 205;
    const gap = Math.min(66, 300 / Math.max(1, sectionCount - 1));
    for (let index = 0; index < sectionCount; index += 1) {
      const y = pyRound(top + index * gap);
      elements.push(text(82, y - 9, 42, 28, String(index + 1).padStart(2, '0'), 11,
        index === sectionIndex ? THEME.accent : THEME.muted, index === sectionIndex));
    }
    elements.push(shape('line', 56, top, 1, pyRound(gap * (sectionCount - 1)) || 1, '#00000000', THEME.line));
    const cursorY = pyRound(top + sectionIndex * gap - 6);
    motion.push({ element_index: elements.length, name: '!!section-cursor' });
    elements.push(shape('ellipse', 50, cursorY, 13, 13, THEME.secondary));
    const progressH = Math.max(1, pyRound(gap * sectionIndex));
    motion.push({ element_index: elements.length, name: '!!section-progress' });
    elements.push(shape('rect', 54, top, 5, progressH, THEME.accent));
  }
  return elements;
}

function image(asset, x, y, w, h, alt = '') {
  const sourceWidth = asset.width || 1600;
  const sourceHeight = asset.height || 900;
  const scale = Math.min(w / sourceWidth, h / sourceHeight);
  const width = Math.max(1, pyRound(sourceWidth * scale));
  const height = Math.max(1, pyRound(sourceHeight * scale));
  return {
    type: 'image',
    asset,
    alt,
    x: pyRound(x + (w - width) / 2),
    y: pyRound(y + (h - height) / 2),
    w: width,
    h: height,
  };
}

function renderItems(layout, items, elements, fade) {
  const start = elements.length;
  if (layout === 'formula') {
    const value = items[0].text;
    elements.push(shape('roundRect', 190, 220, 900, 280, THEME.card, THEME.line));
    const formulaText = text(240, 270, 800, 180, value, 30, THEME.ink, false, 'center');
    formulaText.paragraphs[0].runs[0].font = 'Cambria Math';
    elements.push(formulaText);
  } else if (layout === 'image') {
    const item = items[0];
    elements.push(image(item.asset, 190, 190, 900, 360, item.text));
    elements.push(text(190, 575, 900, 40, item.text, 14, THEME.muted, false, 'center'));
  } else if (layout === 'gallery') {
    items.forEach((item, index) => {
      const x = 175 + (index % 2) * 500;
      const y = 190 + Math.floor(index / 2) * 210;
      if (item.kind === 'image') {
        elements.push(image(item.asset, x, y, 455, 160, item.text));
        elements.push(text(x, y + 165, 455, 32, item.text, 12, THEME.muted, false, 'center'));
      } else {
        elements.push(shape('roundRect', x, y, 455, 185, THEME.card, THEME.line));
        elements.push(text(x + 24, y + 25, 407, 130, item.text, 17, THEME.ink));
      }
    });
  } else if (layout === 'statement') {
    const value = items.length ? items[0].text : '';
    elements.push(shape('rect', 180, 230, 7, 210, THEME.secondary));
    elements.push(text(235, 220, 830, 250, value, 28, THEME.ink, true));
  } else if (layout === 'compare') {
    items.forEach((item, index) => {
      const x = 175 + index * 505;
      elements.push(shape('roundRect', x, 220, 470, 320, THEME.card, THEME.line));
      elements.push(text(x + 30, 250, 90, 35, `0${index + 1}`, 16, THEME.secondary, true));
      elements.push(text(x + 30, 320, 410, 170, item.text, 21, THEME.ink, true));
    });
  } else if (layout === 'cards') {
    const gap = 22;
    const width = 316;
    items.forEach((item, index) => {
      const x = 170 + index * (width + gap);
      elements.push(shape('roundRect', x, 215, width, 350, THEME.card, THEME.line));
      elements.push(text(x + 24, 242, 100, 58, String(index + 1).padStart(2, '0'), 32, THEME.secondary, true));
      elements.push(text(x + 24, 340, width - 48, 170, item.text, bodySize(item.text, 15), THEME.ink, true));
    });
  } else if (layout === 'grid') {
    items.forEach((item, index) => {
      const x = 170 + (index % 2) * 510;
      const y = 200 + Math.floor(index / 2) * 205;
      elements.push(shape('roundRect', x, y, 486, 178, THEME.card, THEME.line));
      elements.push(text(x + 24, y + 22, 54, 40, String(index + 1).padStart(2, '0'), 22, THEME.secondary, true));
      elements.push(text(x + 92, y + 22, 360, 128, item.text, bodySize(item.text, 21), THEME.ink));
    });
  } else if (layout === 'timeline') {
    elements.push(shape('line', 205, 280, 860, 1, '#00000000', THEME.accent));
    const gap = items.length > 1 ? Math.floor(840 / Math.max(1, items.length - 1)) : 0;
    items.forEach((item, index) => {
      const x = items.length > 1 ? 190 + index * gap : 540;
      elements.push(shape('ellipse', x, 258, 44, 44, THEME.accent));
      elements.push(text(x + 5, 267, 34, 26, String(index + 1), 12, '#FFFFFF', true, 'center'));
      const boxX = Math.max(160, Math.min(1000, x - 95));
      elements.push(text(boxX, 350, 230, 180, item.text, bodySize(item.text, 14), THEME.ink, index === 0, 'center'));
    });
  } else if (layout === 'data') {
    items.forEach((item, index) => {
      const y = 195 + index * 102;
      const number = item.numbers && item.numbers.length ? item.numbers[0] : String(index + 1).padStart(2, '0');
      elements.push(text(180, y, 210, 74, number, 38, THEME.secondary, true));
      elements.push(text(430, y + 3, 700, 82, item.text, bodySize(item.text, 40), THEME.ink));
      if (index < items.length - 1) elements.push(shape('line', 430, y + 88, 700, 1, '#00000000', THEME.line));
    });
  } else if (layout === 'focus') {
    elements.push(shape('donut', 190, 230, 270, 270, THEME.accent));
    elements.push(text(232, 320, 185, 80, String(items.length).padStart(2, '0'), 48, THEME.ink, true, 'center'));
    items.forEach((item, index) => {
      const y = 205 + index * 125;
      elements.push(text(560, y, 50, 35, String(index + 1).padStart(2, '0'), 16, THEME.secondary, true));
      elements.push(text(630, y, 500, 102, item.text, bodySize(item.text, 28), THEME.ink, index === 0));
    });
  } else {
    items.forEach((item, index) => {
      const y = 194 + index * Math.floor(320 / Math.max(1, items.length));
      elements.push(text(180, y, 65, 40, String(index + 1).padStart(2, '0'), 18, THEME.secondary, true));
      elements.push(text(275, y, 850, 118, item.text, bodySize(item.text, 48), THEME.ink, items.length === 1));
      if (index < items.length - 1) elements.push(shape('line', 275, y + 102, 850, 1, '#00000000', THEME.line));
    });
  }
  for (let index = start; index < elements.length; index += 1) fade.push(index);
}

function coverPage(model) {
  const leadText = model.lead.filter(item => item.kind !== 'image');
  const coverImage = model.lead.find(item => item.kind === 'image') || null;
  const subtitle = leadText.length ? leadText.map(item => item.text).join('\n') : '内容解析 · 自动分页 · 原生可编辑';
  const subtitleSize = codePointLength(subtitle) > 110 ? 14 : 17;
  const visual = coverImage
    ? [image(coverImage.asset, 790, 105, 390, 450, coverImage.text)]
    : [shape('ellipse', 890, 90, 290, 290, THEME.accent), shape('donut', 830, 330, 330, 330, THEME.secondary)];
  const elements = [
    shape('rect', 0, 0, 1280, 720, THEME.background),
    ...visual,
    text(80, 64, 500, 30, 'INTELLIGENT PPT / 01', 11, THEME.accent, true),
    text(80, 175, 760, 190, model.title, 42, THEME.ink, true),
    text(84, 400, 650, 170, subtitle, subtitleSize, THEME.muted),
    shape('line', 84, 590, 1090, 1, '#00000000', THEME.line),
    text(84, 618, 450, 28, 'SOURCE → STRUCTURE → SLIDES', 10, THEME.muted, true),
    text(1070, 612, 100, 34, '01', 14, THEME.ink, true, 'right'),
  ];
  return [{ background: THEME.background, elements }, [3, 4, 5]];
}

function overviewPage(sections, offset = 0, total = null, title = '内容结构', countText = null) {
  const elements = [
    shape('rect', 0, 0, 1280, 720, THEME.background),
    text(80, 58, 300, 28, 'STRUCTURE', 11, THEME.accent, true),
    text(80, 104, 600, 70, title, 36, THEME.ink, true),
    text(970, 110, 190, 50, countText || `${String(total === null ? sections.length : total).padStart(2, '0')} 部分`, 18, THEME.secondary, true, 'right'),
  ];
  sections.forEach((section, index) => {
    const x = 80 + (index % 2) * 575;
    const y = 230 + Math.floor(index / 2) * 150;
    elements.push(text(x, y, 70, 48, String(offset + index + 1).padStart(2, '0'), 24, THEME.secondary, true));
    elements.push(text(x + 92, y, 440, 92, section.title, 20, THEME.ink, true));
    elements.push(shape('line', x + 92, y + 100, 420, 1, '#00000000', THEME.line));
  });
  return { background: THEME.background, elements };
}

function overviewTitleKey(value) {
  const normalized = clean(value).toLowerCase().replace(/^(?:第\s*)?\d{1,3}\s*(?:[章节]|[.、．:：-])?\s*/u, '');
  return normalized.replace(/[\s.、．:：-]+/gu, '');
}

function matchedSourceOverview(model) {
  if (model.sections.length < 3) return null;
  const source = model.sections[0];
  if (!/^(?:内容结构|目录|大纲|CONTENTS)$/i.test(source.title)) return null;
  const later = model.sections.slice(1);
  const sectionKeys = new Map();
  later.forEach((section, index) => sectionKeys.set(overviewTitleKey(section.title), index));
  const displayTitles = new Map();
  let countText = null;
  let matched = 0;
  for (const item of source.items) {
    const value = item.text;
    if (/^\d{1,3}$/.test(value)) continue;
    if (/^\d{1,3}\s*(?:个\s*)?(?:部分|章节|章|节|主题|sections?|parts?)$/i.test(value)) {
      if (countText !== null && countText !== value) return null;
      countText = value;
      continue;
    }
    const key = overviewTitleKey(value);
    if (!key || !sectionKeys.has(key)) return null;
    displayTitles.set(sectionKeys.get(key), value);
    matched += 1;
  }
  if (!matched) return null;
  const displaySections = later.map((section, index) => ({
    ...section,
    title: displayTitles.has(index) ? displayTitles.get(index) : section.title,
  }));
  return { source, sections: displaySections, count_text: countText };
}

export function planPages(model, style = 'paper') {
  if (!Object.prototype.hasOwnProperty.call(THEMES, style)) throw new Error(`未知主题：${style}`);
  THEME = { ...THEMES[style] };
  const coverSources = (model.title_id ? [model.title_id] : []).concat(model.lead.map(item => item.id));
  const plans = [{ kind: 'cover', title: model.title, layout: 'cover', source_ids: coverSources }];
  const sourceOverview = matchedSourceOverview(model);
  const sourceOverviewTitle = Boolean(model.sections.length && /^(?:内容结构|目录|大纲|CONTENTS)$/i.test(model.sections[0].title));
  const contentSections = sourceOverview ? model.sections.slice(1) : model.sections;
  const overviewSections = sourceOverview ? sourceOverview.sections : contentSections;
  if (sourceOverview || (contentSections.length >= 3 && !sourceOverviewTitle)) {
    const overviewTitle = sourceOverview ? sourceOverview.source.title : '内容结构';
    for (let start = 0; start < overviewSections.length; start += 6) {
      const chunk = overviewSections.slice(start, start + 6);
      const sourceIds = chunk.filter(section => section.heading_id).map(section => section.heading_id);
      if (sourceOverview && start === 0) {
        const source = sourceOverview.source;
        sourceIds.push(...(source.heading_id ? [source.heading_id] : []), ...source.items.map(item => item.id));
      }
      plans.push({
        kind: 'overview',
        title: start === 0 ? overviewTitle : `${overviewTitle}（续）`,
        layout: 'overview',
        overview_start: start,
        overview_sections: chunk,
        overview_title: start === 0 ? overviewTitle : `${overviewTitle}（续）`,
        overview_count: sourceOverview ? sourceOverview.count_text : null,
        source_ids: sourceIds,
      });
    }
  }
  contentSections.forEach((section, sectionIndex) => {
    const layout = chooseLayout(section, sectionIndex);
    const chunks = splitItems(section.items);
    chunks.forEach((chunk, chunkIndex) => {
      const suffix = chunkIndex ? '（续）' : '';
      const sourceIds = section.heading_id && chunkIndex === 0 ? [section.heading_id] : [];
      sourceIds.push(...chunk.map(item => item.id));
      plans.push({
        kind: 'content',
        title: section.title + suffix,
        layout,
        section_index: sectionIndex,
        section_count: contentSections.length,
        items: chunk.map(item => ({
          id: item.id,
          kind: item.kind,
          text: item.text,
          numbers: item.numbers,
          asset: item.asset === undefined ? null : item.asset,
        })),
        source_ids: sourceIds,
      });
    });
  });

  const pages = [];
  plans.forEach((plan, planIndex) => {
    const pageNumber = planIndex + 1;
    const motion = [];
    let fade = [];
    let page;
    if (plan.kind === 'cover') {
      [page, fade] = coverPage(model);
    } else if (plan.kind === 'overview') {
      page = overviewPage(plan.overview_sections, plan.overview_start, contentSections.length, plan.overview_title, plan.overview_count);
      fade = Array.from({ length: Math.max(0, page.elements.length - 1) }, (_, index) => index + 1);
    } else {
      const elements = basePage(plan.title, pageNumber, plan.section_index, plan.section_count, motion, fade);
      renderItems(plan.layout, plan.items, elements, fade);
      page = { background: THEME.background, elements };
    }
    pages.push({ number: pageNumber, plan, page, motion, fade });
  });
  return pages;
}
