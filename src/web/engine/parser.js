import { readZip } from './zip.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function codePointLength(value) {
  return Array.from(String(value)).length;
}

function block(kind, text, source, level = 0) {
  return { kind, text: clean(text), level, source };
}

function explicitNote(text) {
  const match = String(text).match(/^(?:备注|讲稿|演讲备注|注释|notes?)\s*[:：]\s*(.+)$/i);
  return match ? match[1] : null;
}

function childElements(node) {
  if (!node) return [];
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child);
  }
  return result;
}

function* walk(node) {
  if (!node) return;
  if (node.nodeType === 1) yield node;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) yield* walk(child);
  }
}

function matches(element, namespace, localName) {
  return element.localName === localName && element.namespaceURI === namespace;
}

function descendants(node, namespace, localName) {
  const result = [];
  for (const element of walk(node)) {
    if (element !== node && matches(element, namespace, localName)) result.push(element);
  }
  return result;
}

function firstDescendant(node, namespace, localName) {
  for (const element of walk(node)) {
    if (element !== node && matches(element, namespace, localName)) return element;
  }
  return null;
}

function findPath(node, path) {
  let current = node;
  for (const [namespace, localName] of path) {
    current = childElements(current).find(element => matches(element, namespace, localName));
    if (!current) return null;
  }
  return current || null;
}

function namespacedAttribute(node, namespace, name, fallback = '') {
  if (!node) return fallback;
  const value = node.getAttributeNS(namespace, name);
  return value === null ? fallback : value;
}

function parseXml(source) {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const root = document.documentElement;
  const parserError = (root && root.localName === 'parsererror')
    ? root
    : Array.from(document.getElementsByTagName('*')).find(element => element.localName === 'parsererror');
  if (parserError || !root) {
    const detail = clean(parserError ? parserError.textContent : '文档为空');
    throw new Error(`XML 解析失败${detail ? `：${detail}` : ''}`);
  }
  return root;
}

function officeParagraphText(paragraph) {
  const parts = [];
  for (const node of walk(paragraph)) {
    const namespace = node.namespaceURI;
    if ((namespace === W || namespace === A || namespace === M) && node.localName === 't') {
      parts.push(node.textContent || '');
    } else if ((namespace === W || namespace === A) && node.localName === 'tab') {
      parts.push(' ');
    } else if ((namespace === W || namespace === A) && node.localName === 'br') {
      parts.push('\n');
    }
  }
  return clean(parts.join(''));
}

function joinWrapped(parts) {
  let value = '';
  for (const original of parts) {
    const part = clean(original);
    if (!part) continue;
    const separator = /[A-Za-z0-9]$/.test(value) && /^[A-Za-z0-9]/.test(part) ? ' ' : '';
    value += separator + part;
  }
  return clean(value);
}

function splitLines(value) {
  if (!value) return [];
  const lines = value.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function imageExtension(data) {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 8 && png.every((value, index) => data[index] === value)) return '.png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  throw new Error('图片仅支持有效的 PNG 或 JPEG 文件');
}

function imageDimensions(data) {
  if (data.length >= 24 && imageExtension(data) === '.png') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const length = (data[offset + 2] << 8) | data[offset + 3];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [
          (data[offset + 7] << 8) | data[offset + 8],
          (data[offset + 5] << 8) | data[offset + 6],
        ];
      }
      offset += 2 + Math.max(1, length);
    }
  }
  return [1600, 900];
}

function makeAsset(name, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  imageExtension(data);
  const [width, height] = imageDimensions(data);
  return { name, bytes: data, width, height };
}

function decodeBase64(value, line) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`第 ${line} 行图片 Base64 数据无效`);
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error(`第 ${line} 行图片 Base64 数据无效`);
  }
}

function normalizePath(value) {
  const source = String(value).replace(/\\/g, '/');
  const rooted = source.startsWith('/');
  const parts = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!rooted) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  const joined = parts.join('/');
  return rooted ? `/${joined}` : joined || '.';
}

function pathDirname(value) {
  const normalized = String(value).replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

function pathBasename(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function pathStem(value) {
  const base = pathBasename(value);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(0, dot) : base;
}

function pathJoin(left, right) {
  if (right.startsWith('/')) return normalizePath(right);
  return normalizePath(left ? `${left}/${right}` : right);
}

function resolveImage(filename, reference, line, assets) {
  const cleanedReference = reference.trim().replace(/^<+|>+$/g, '');
  if (cleanedReference.startsWith('data:image/')) {
    const match = cleanedReference.match(/^data:image\/(?:png|jpeg);base64,([\s\S]+)$/i);
    if (!match) throw new Error(`第 ${line} 行图片不是受支持的 Base64 PNG/JPEG`);
    const data = decodeBase64(match[1], line);
    const extension = imageExtension(data);
    return makeAsset(`image-${line}${extension}`, data);
  }
  if (/^https?:\/\//i.test(cleanedReference)) {
    throw new Error(`第 ${line} 行图片需要随文件上传，不会自动下载外部图片`);
  }
  const candidate = pathJoin(pathDirname(filename), cleanedReference);
  const normalizedReference = normalizePath(cleanedReference);
  const uploaded = assets.map(asset => ({ ...asset, normalizedName: normalizePath(asset.filename) }));
  let selected = uploaded.find(asset => asset.normalizedName === candidate);
  if (!selected) selected = uploaded.find(asset => asset.normalizedName === normalizedReference);
  if (!selected) {
    const base = pathBasename(candidate);
    selected = uploaded.find(asset => pathBasename(asset.normalizedName) === base);
  }
  if (!selected) {
    throw new Error(`第 ${line} 行图片不存在，请随大纲上传同名 PNG/JPEG：${reference}`);
  }
  return makeAsset(selected.filename, selected.bytes);
}

function expandTabs(value, size = 4) {
  let column = 0;
  let result = '';
  for (const character of value) {
    if (character === '\t') {
      const count = size - (column % size);
      result += ' '.repeat(count);
      column += count;
    } else {
      result += character;
      column += 1;
    }
  }
  return result;
}

function parseMarkdown(filename, bytes, assets) {
  const lines = splitLines(decodeText(bytes));
  const blocks = [];
  let paragraphParts = [];
  let paragraphStart = 1;
  let inCode = false;
  let inNotes = false;
  let inFormula = false;
  let formulaLines = [];
  let formulaStart = 0;

  function flushParagraph() {
    if (paragraphParts.length) {
      blocks.push(block('paragraph', joinWrapped(paragraphParts), { line: paragraphStart }));
      paragraphParts = [];
    }
  }

  let index = 0;
  while (index < lines.length) {
    const number = index + 1;
    const raw = lines[index];
    let text = raw.trim();
    if (inFormula) {
      if (text === '$$') {
        blocks.push(block('formula', formulaLines.join(' '), { line: formulaStart }));
        inFormula = false;
        formulaLines = [];
      } else {
        formulaLines.push(text);
      }
      index += 1;
      continue;
    }
    if (text.startsWith('```')) {
      flushParagraph();
      inCode = !inCode;
      index += 1;
      continue;
    }
    if (inCode) {
      if (text) blocks.push(block('paragraph', text, { line: number }));
      index += 1;
      continue;
    }
    if (['::: notes', '::: note', '::: 备注'].includes(text.toLowerCase())) {
      flushParagraph();
      inNotes = true;
      index += 1;
      continue;
    }
    if (inNotes) {
      if (text === ':::') inNotes = false;
      else if (text) blocks.push(block('note', text, { line: number }));
      index += 1;
      continue;
    }
    if (!text) {
      flushParagraph();
      index += 1;
      continue;
    }
    const source = { line: number };
    const comment = text.match(/^<!--\s*(.*?)\s*-->$/);
    if (comment) {
      flushParagraph();
      if (comment[1]) blocks.push(block('note', comment[1], source));
      index += 1;
      continue;
    }
    const quoted = text.match(/^>\s*(.+)$/);
    if (quoted) text = quoted[1];
    const note = explicitNote(text);
    if (note !== null) {
      flushParagraph();
      blocks.push(block('note', note, source));
      index += 1;
      continue;
    }
    const nextText = index + 1 < lines.length ? lines[index + 1].trim() : '';
    if (/^(?:=+|-+)$/.test(nextText) && !/^(?:#{1,6}|[-*+]|\d+[.)、])/.test(text)) {
      flushParagraph();
      blocks.push(block('heading', text, source, nextText.startsWith('=') ? 1 : 2));
      index += 2;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
      flushParagraph();
      index += 1;
      continue;
    }
    if (text === '$$') {
      flushParagraph();
      inFormula = true;
      formulaStart = number;
      index += 1;
      continue;
    }
    const formula = text.match(/^\$\$(.+?)\$\$$|^\$([^$]+)\$$/);
    if (formula) {
      flushParagraph();
      blocks.push(block('formula', formula[1] || formula[2], source));
      index += 1;
      continue;
    }
    const image = text.match(/^!\[([^\]]*)\]\((.+)\)$/);
    if (image) {
      flushParagraph();
      const reference = image[2].trim();
      const fallback = reference.startsWith('data:image/') ? '图片' : pathStem(reference);
      const item = block('image', image[1] || fallback || '图片', source);
      item.asset = resolveImage(filename, reference, number, assets);
      blocks.push(item);
      index += 1;
      continue;
    }
    const heading = text.match(/^(#{1,6})(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
    const listItem = raw.match(/^(\s*)(?:[-*+]|\d{1,9}[.)、])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push(block('heading', heading[2], source, heading[1].length));
    } else if (listItem) {
      flushParagraph();
      const indent = codePointLength(expandTabs(listItem[1]));
      blocks.push(block('bullet', listItem[2], source, Math.min(6, 1 + Math.floor(indent / 2))));
    } else {
      if (!paragraphParts.length) paragraphStart = number;
      paragraphParts.push(text);
    }
    index += 1;
  }
  flushParagraph();
  if (inFormula) throw new Error(`第 ${formulaStart} 行公式缺少结束标记 $$`);
  return blocks;
}

function textHeadingLevel(text, numericSections = false) {
  if (/^第.{1,8}(?:章|篇|部分)(?:\s+.+)?$/u.test(text)) return 2;
  if (/^第.{1,8}节(?:\s+.+)?$/u.test(text)) return 3;
  if (/^(?:[一二三四五六七八九十]+、|\d{1,2}、)\S+/u.test(text)) return 2;
  if (/^[（(][一二三四五六七八九十]+[）)]\s*\S+/u.test(text)) return 3;
  if (numericSections && /^\d{1,2}[.]\s*\S+/u.test(text)) return 2;
  return null;
}

function parseText(bytes) {
  const lines = splitLines(decodeText(bytes));
  const nonempty = [];
  lines.forEach((raw, index) => {
    if (raw.trim()) nonempty.push([index, raw.trim()]);
  });
  const numericIndexes = nonempty.filter(([, text]) => /^\d{1,2}[.]\s*\S+/u.test(text)).map(([index]) => index);
  const hasNamedSections = nonempty.some(([, text]) => Boolean(textHeadingLevel(text)));
  let numericSections = false;
  if (!hasNamedSections && numericIndexes.length >= 2) {
    let separated = 0;
    numericIndexes.forEach((lineIndex, position) => {
      const nextIndex = position + 1 < numericIndexes.length ? numericIndexes[position + 1] : lines.length;
      for (let item = lineIndex + 1; item < nextIndex; item += 1) {
        const value = lines[item].trim();
        if (value && !/^\d{1,2}[.]\s*\S+/u.test(value)) {
          separated += 1;
          break;
        }
      }
    });
    numericSections = separated >= Math.max(1, Math.floor(numericIndexes.length / 2));
  }
  const hasSections = hasNamedSections || numericSections;
  const blocks = [];
  let paragraphParts = [];
  let paragraphStart = 1;
  function flushParagraph() {
    if (paragraphParts.length) {
      blocks.push(block('paragraph', joinWrapped(paragraphParts), { line: paragraphStart }));
      paragraphParts = [];
    }
  }
  const firstContentIndex = nonempty.length ? nonempty[0][0] : -1;
  lines.forEach((raw, index) => {
    const number = index + 1;
    const text = raw.trim();
    if (!text) {
      flushParagraph();
      return;
    }
    const source = { line: number };
    const note = explicitNote(text);
    if (note !== null) {
      flushParagraph();
      blocks.push(block('note', note, source));
      return;
    }
    const level = textHeadingLevel(text, numericSections);
    if (level) {
      flushParagraph();
      blocks.push(block('heading', text, source, level));
      return;
    }
    if (index === firstContentIndex && hasSections && codePointLength(text) <= 60 && !/[。！？；.!?;]$/.test(text)) {
      flushParagraph();
      blocks.push(block('heading', text, source, 1));
      return;
    }
    const listItem = raw.match(/^(\s*)(?:[-*•]|\d{1,9}[.)]|[（(]\d+[）)])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
    if (listItem) {
      flushParagraph();
      const indent = codePointLength(expandTabs(listItem[1]));
      blocks.push(block('bullet', listItem[2], source, Math.min(6, 1 + Math.floor(indent / 2))));
      return;
    }
    if (!paragraphParts.length) paragraphStart = number;
    paragraphParts.push(text);
  });
  flushParagraph();
  return blocks;
}

function integerValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

async function parseDocx(bytes) {
  const archive = await readZip(bytes);
  const root = parseXml(await archive.text('word/document.xml'));
  const styleNames = new Map();
  if (archive.has('word/styles.xml')) {
    const styles = parseXml(await archive.text('word/styles.xml'));
    for (const style of childElements(styles).filter(element => matches(element, W, 'style'))) {
      const name = findPath(style, [[W, 'name']]);
      if (name) styleNames.set(namespacedAttribute(style, W, 'styleId'), namespacedAttribute(name, W, 'val'));
    }
  }
  const blocks = [];
  const paragraphs = [];
  for (const body of descendants(root, W, 'body')) paragraphs.push(...descendants(body, W, 'p'));
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const number = paragraphIndex + 1;
    const text = officeParagraphText(paragraph);
    const isFormula = Boolean(firstDescendant(paragraph, M, 'oMath') || firstDescendant(paragraph, M, 'oMathPara'));
    if (!text) return;
    const style = findPath(paragraph, [[W, 'pPr'], [W, 'pStyle']]);
    const styleId = style ? namespacedAttribute(style, W, 'val') : '';
    const styleName = (styleNames.get(styleId) ?? styleId).toLowerCase();
    const heading = styleName.match(/(?:heading|标题)\s*([1-6])/);
    const outline = findPath(paragraph, [[W, 'pPr'], [W, 'outlineLvl']]);
    const outlineLevel = outline ? integerValue(namespacedAttribute(outline, W, 'val')) + 1 : null;
    const source = { paragraph: number, style: styleId };
    const note = explicitNote(text);
    if (note !== null || /备注|讲稿|comment|notes?/i.test(styleName)) {
      blocks.push(block('note', note !== null ? note : text, source));
    } else if (isFormula) {
      blocks.push(block('formula', text, source));
    } else if (['title', '标题'].includes(styleName)) {
      blocks.push(block('heading', text, source, 1));
    } else if (heading || outlineLevel !== null) {
      blocks.push(block('heading', text, source, heading ? Number(heading[1]) : outlineLevel));
    } else if (['subtitle', '副标题'].includes(styleName)) {
      blocks.push(block('subtitle', text, source));
    } else if (findPath(paragraph, [[W, 'pPr'], [W, 'numPr']])) {
      const level = findPath(paragraph, [[W, 'pPr'], [W, 'numPr'], [W, 'ilvl']]);
      const indent = level ? integerValue(namespacedAttribute(level, W, 'val')) + 1 : 1;
      blocks.push(block('bullet', text, source, indent));
    } else {
      blocks.push(block('paragraph', text, source));
    }
  });
  return blocks;
}

function slideNumber(name) {
  return Number(name.match(/(\d+)\.xml$/)[1]);
}

function shapeText(shape) {
  const paragraphs = [];
  for (const paragraph of descendants(shape, A, 'p')) {
    const value = officeParagraphText(paragraph);
    if (value) paragraphs.push(value);
  }
  return paragraphs;
}

function shapeFontSize(shape) {
  const sizes = [];
  for (const node of walk(shape)) {
    if (node.namespaceURI === A && ['rPr', 'defRPr', 'endParaRPr'].includes(node.localName) && node.hasAttribute('sz')) {
      sizes.push(integerValue(node.getAttribute('sz')) / 100);
    }
  }
  return sizes.length ? Math.max(...sizes) : 0;
}

function shapeXfrm(shape) {
  for (const path of [
    [[P, 'spPr'], [A, 'xfrm']],
    [[P, 'xfrm']],
    [[P, 'grpSpPr'], [A, 'xfrm']],
  ]) {
    const transform = findPath(shape, path);
    if (transform) return transform;
  }
  return null;
}

function shapePosition(shape, parents = null) {
  const transform = shapeXfrm(shape);
  const offset = transform ? findPath(transform, [[A, 'off']]) : null;
  const x = integerValue(offset ? offset.getAttribute('x') : null) / 9525;
  const y = integerValue(offset ? offset.getAttribute('y') : null) / 9525;
  const parent = parents ? parents.get(shape) : null;
  if (!parent || !matches(parent, P, 'grpSp')) return [x, y];
  const [parentX, parentY] = shapePosition(parent, parents);
  const group = shapeXfrm(parent);
  const childOffset = group ? findPath(group, [[A, 'chOff']]) : null;
  const extent = group ? findPath(group, [[A, 'ext']]) : null;
  const childExtent = group ? findPath(group, [[A, 'chExt']]) : null;
  const childX = integerValue(childOffset ? childOffset.getAttribute('x') : null) / 9525;
  const childY = integerValue(childOffset ? childOffset.getAttribute('y') : null) / 9525;
  const scaleX = extent && childExtent
    ? integerValue(extent.getAttribute('cx'), 1) / Math.max(1, integerValue(childExtent.getAttribute('cx'), 1))
    : 1;
  const scaleY = extent && childExtent
    ? integerValue(extent.getAttribute('cy'), 1) / Math.max(1, integerValue(childExtent.getAttribute('cy'), 1))
    : 1;
  return [parentX + (x - childX) * scaleX, parentY + (y - childY) * scaleY];
}

function shapeTop(shape, parents = null) {
  return shapePosition(shape, parents)[1];
}

function shapeLeft(shape, parents = null) {
  return shapePosition(shape, parents)[0];
}

function placeholderType(shape) {
  const placeholder = findPath(shape, [[P, 'nvSpPr'], [P, 'nvPr'], [P, 'ph']]);
  return placeholder ? placeholder.getAttribute('type') || '' : '';
}

async function relationshipTargets(archive, part) {
  const name = `${pathDirname(part)}/_rels/${pathBasename(part)}.rels`.replace(/^\//, '');
  if (!archive.has(name)) return {};
  const root = parseXml(await archive.text(name));
  const result = {};
  for (const relation of childElements(root)) {
    const target = relation.getAttribute('Target') || '';
    if (relation.getAttribute('TargetMode') === 'External' || !target) continue;
    result[relation.getAttribute('Id') || ''] = {
      type: relation.getAttribute('Type') || '',
      target: pathJoin(pathDirname(part), target),
    };
  }
  return result;
}

async function presentationSlides(archive) {
  const available = archive.names().filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  try {
    const root = parseXml(await archive.text('ppt/presentation.xml'));
    const relationships = await relationshipTargets(archive, 'ppt/presentation.xml');
    const ordered = [];
    for (const identifier of descendants(root, P, 'sldId')) {
      const relation = relationships[namespacedAttribute(identifier, R, 'id')] || {};
      const target = relation.target;
      if (available.includes(target) && !ordered.includes(target)) ordered.push(target);
    }
    const remaining = available.filter(name => !ordered.includes(name)).sort((left, right) => slideNumber(left) - slideNumber(right));
    return ordered.concat(remaining);
  } catch {
    return available.sort((left, right) => slideNumber(left) - slideNumber(right));
  }
}

function smallPageNumber(value) {
  return /^\d{1,2}(?:\s*\/\s*\d{1,2})?$/.test(value);
}

function microBrandLabel(item) {
  if (['heading', 'subtitle'].includes(item.kind) || !(item.top <= 90 || item.top >= 590)) return false;
  if (!(item.font_size > 0 && item.font_size <= 12)) return false;
  const value = item.text;
  if (!/^[A-Z0-9][A-Z0-9 ./_|·:—→-]*$/u.test(value)) return false;
  if (/\b(?:SOURCE|REFERENCES?|DATA)\s*:/.test(value)) return false;
  return /\s\/\s*\d{1,2}$/.test(value) || value.includes('→')
    || ['STRUCTURE', 'CONTENTS', 'CONTENT / FORM'].includes(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function parsePptx(bytes) {
  const blocks = [];
  const notes = [];
  const archive = await readZip(bytes);
  const slides = await presentationSlides(archive);
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const index = slideIndex + 1;
    const root = parseXml(await archive.text(slides[slideIndex]));
    const parents = new Map();
    for (const parent of walk(root)) {
      for (const child of childElements(parent)) parents.set(child, parent);
    }
    const relationships = await relationshipTargets(archive, slides[slideIndex]);
    const elements = Array.from(walk(root)).filter(element => element.namespaceURI === P && ['sp', 'graphicFrame'].includes(element.localName));
    const shapes = elements.filter(shape => shapeText(shape).length);
    let titleShape = shapes.find(shape => ['title', 'ctrTitle'].includes(placeholderType(shape))) || null;
    if (!titleShape && shapes.length) {
      const ordinary = shapes.filter(shape => matches(shape, P, 'sp'));
      const pool = ordinary.length ? ordinary : shapes;
      const titleZone = index === 1 ? 400 : 220;
      let candidates = [];
      for (const shape of pool) {
        const value = shapeText(shape).join(' ');
        if (shapeTop(shape, parents) <= titleZone && codePointLength(value) <= 160
          && !/^[-+]?\d+(?:\.\d+)?%?$/.test(value) && !smallPageNumber(value) && shapeFontSize(shape) >= 16) {
          candidates.push(shape);
        }
      }
      if (!candidates.length) {
        candidates = pool.filter(shape => shapeTop(shape, parents) <= titleZone && !smallPageNumber(shapeText(shape).join(' ')));
      }
      if (candidates.length) {
        const topmost = Math.min(...candidates.map(shape => shapeTop(shape, parents)));
        const nearest = candidates.filter(shape => shapeTop(shape, parents) <= topmost + 90);
        titleShape = nearest.reduce((best, shape) => shapeFontSize(shape) > shapeFontSize(best) ? shape : best, nearest[0]);
      } else {
        titleShape = pool.reduce((best, shape) => {
          const topDifference = shapeTop(shape, parents) - shapeTop(best, parents);
          if (topDifference < 0) return shape;
          if (topDifference === 0 && shapeLeft(shape, parents) < shapeLeft(best, parents)) return shape;
          return best;
        }, pool[0]);
      }
    }
    const titleSize = titleShape ? shapeFontSize(titleShape) : 0;
    const titleTop = titleShape ? shapeTop(titleShape, parents) : 0;
    let subtitleShape = shapes.find(shape => placeholderType(shape) === 'subTitle') || null;
    if (titleShape && !subtitleShape) {
      const subtitleCandidates = [];
      for (const shape of shapes) {
        if (shape === titleShape || !matches(shape, P, 'sp')) continue;
        const delta = shapeTop(shape, parents) - titleTop;
        const size = shapeFontSize(shape);
        const value = shapeText(shape).join(' ');
        if (delta >= 24 && delta <= (index === 1 ? 300 : 90) && size >= 12 && size < titleSize && !smallPageNumber(value)) {
          subtitleCandidates.push(shape);
        }
      }
      if (subtitleCandidates.length) {
        subtitleShape = subtitleCandidates.reduce((best, shape) => shapeTop(shape, parents) < shapeTop(best, parents) ? shape : best, subtitleCandidates[0]);
      }
    }
    let titleUsed = false;
    const orderedShapes = shapes.map((shape, order) => ({ shape, order })).sort((left, right) => {
      return shapeTop(left.shape, parents) - shapeTop(right.shape, parents)
        || shapeLeft(left.shape, parents) - shapeLeft(right.shape, parents)
        || left.order - right.order;
    }).map(entry => entry.shape);
    orderedShapes.forEach((shape, orderedIndex) => {
      const paragraphNodes = descendants(shape, A, 'p').filter(paragraph => officeParagraphText(paragraph));
      const paragraphs = shapeText(shape);
      const hasBullets = paragraphNodes.some(paragraph => findPath(paragraph, [[A, 'pPr'], [A, 'buChar']])
        || findPath(paragraph, [[A, 'pPr'], [A, 'buAutoNum']]));
      paragraphs.forEach((value, paragraphIndex) => {
        const source = { slide: index, shape: orderedIndex + 1, paragraph: paragraphIndex + 1 };
        let item;
        if (shape === titleShape && !titleUsed) {
          item = block('heading', value, source, index === 1 ? 1 : 2);
          titleUsed = true;
        } else if (shape === subtitleShape || (shape === titleShape && index === 1)) {
          item = block('subtitle', value, source);
        } else if (paragraphs.length > 1 || hasBullets) {
          item = block('bullet', value, source);
        } else {
          item = block('paragraph', value, source);
        }
        item.font_size = shapeFontSize(shape);
        item.top = shapeTop(shape, parents);
        item.left = shapeLeft(shape, parents);
        blocks.push(item);
      });
    });
    for (const frame of elements) {
      if (!matches(frame, P, 'graphicFrame') || shapeText(frame).length) continue;
      const diagramIds = [];
      for (const node of walk(frame)) {
        const id = node.getAttributeNS(R, 'dm');
        if (id) diagramIds.push(id);
      }
      for (const relationId of diagramIds.slice(0, 1)) {
        const relation = relationships[relationId] || {};
        const target = relation.target;
        if (!(relation.type || '').endsWith('/diagramData') || !archive.has(target)) continue;
        const diagram = parseXml(await archive.text(target));
        shapeText(diagram).forEach((value, paragraphIndex) => {
          const item = block('bullet', value, { slide: index, shape: 0, paragraph: paragraphIndex + 1 });
          Object.assign(item, { font_size: 0, top: 200, left: 0, from_diagram: true });
          blocks.push(item);
        });
      }
    }
    for (const relation of Object.values(relationships)) {
      if (!(relation.type || '').endsWith('/notesSlide') || !archive.has(relation.target)) continue;
      const notesRoot = parseXml(await archive.text(relation.target));
      for (const shape of descendants(notesRoot, P, 'sp')) {
        if (placeholderType(shape) !== 'body') continue;
        for (const value of shapeText(shape)) notes.push(block('note', value, { slide: index }));
      }
    }
  }

  const repeatedSlides = new Map();
  const ordinalsBySlide = new Map();
  for (const item of blocks) {
    if (!repeatedSlides.has(item.text)) repeatedSlides.set(item.text, new Set());
    repeatedSlides.get(item.text).add(item.source.slide);
    if (/^0\d$/.test(item.text) && !['heading', 'subtitle'].includes(item.kind)) {
      if (!ordinalsBySlide.has(item.source.slide)) ordinalsBySlide.set(item.source.slide, []);
      ordinalsBySlide.get(item.source.slide).push(item);
    }
  }
  const decorations = [];
  const content = [];
  for (const item of blocks) {
    const headerFooter = item.top <= 90 || item.top >= 590;
    const repeated = !item.from_diagram && repeatedSlides.get(item.text).size >= 3
      && !['heading', 'subtitle'].includes(item.kind)
      && ((item.font_size > 0 && item.font_size <= 14) || headerFooter);
    const smallNumber = smallPageNumber(item.text) && item.font_size > 0 && item.font_size <= 14
      && !['heading', 'subtitle'].includes(item.kind);
    const peers = ordinalsBySlide.get(item.source.slide) || [];
    const ordinal = peers.includes(item) && (peers.length >= 2
      || peers.filter(peer => peer.text === item.text).length >= 2
      || blocks.some(other => other !== item && other.source.slide === item.source.slide
        && new RegExp(`^${escapeRegExp(item.text)}\\s+\\S`).test(other.text)));
    const microBrand = microBrandLabel(item);
    if (repeated || smallNumber || ordinal || microBrand) {
      const reasons = [];
      if (repeated) reasons.push('跨页重复页眉页脚');
      if (smallNumber || ordinal) reasons.push('页码或卡片序号');
      if (microBrand) reasons.push('小号品牌或导航标签');
      item.decoration_reason = reasons.join('、');
      decorations.push(item);
    } else {
      content.push(item);
    }
  }
  return [content, decorations, notes];
}

function extensionOf(filename) {
  const base = pathBasename(filename);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export async function parseDocument(filename, fileBytes, assets = []) {
  const extension = extensionOf(filename);
  let blocks;
  let decorations = [];
  let notes = [];
  if (['md', 'markdown'].includes(extension)) {
    blocks = parseMarkdown(filename, fileBytes, assets);
  } else if (extension === 'txt') {
    blocks = parseText(fileBytes);
  } else if (extension === 'docx') {
    blocks = await parseDocx(fileBytes);
  } else if (extension === 'pptx') {
    [blocks, decorations, notes] = await parsePptx(fileBytes);
  } else {
    throw new Error('仅支持 .docx、.md、.markdown、.txt、.pptx');
  }
  notes.push(...blocks.filter(item => item.kind === 'note'));
  blocks = blocks.filter(item => item.kind !== 'note');
  if (!blocks.length) throw new Error('输入中没有可识别的正文');
  blocks.forEach((item, index) => {
    item.id = `b${String(index + 1).padStart(4, '0')}`;
    item.numbers = item.text.match(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?/g) || [];
  });
  notes.forEach((item, index) => {
    item.id = `n${String(index + 1).padStart(4, '0')}`;
  });
  return { blocks, decorations, notes };
}

export function makeModel(filename, blocks, decorations = [], notes = []) {
  const headings = blocks.filter(item => item.kind === 'heading');
  const title = headings.length ? headings[0].text : pathStem(filename);
  const titleId = headings.length ? headings[0].id : null;
  const sections = [];
  const lead = [];
  let current = null;
  const titleItem = headings.length ? headings[0] : null;
  const remainingLevels = headings.filter(item => item !== titleItem).map(item => item.level);
  const sectionLevel = remainingLevels.length ? Math.min(...remainingLevels) : 2;
  for (const item of blocks) {
    if (item === titleItem) continue;
    if (item.kind === 'heading' && item.level <= sectionLevel) {
      current = { title: item.text, heading_id: item.id, items: [] };
      sections.push(current);
    } else if (!current) {
      lead.push(item);
    } else {
      current.items.push(item);
    }
  }
  if (!sections.length) {
    sections.push({ title, heading_id: titleId, items: blocks.filter(item => item.id !== titleId) });
    lead.length = 0;
  }
  return {
    source: { filename, format: extensionOf(filename) },
    title,
    title_id: titleId,
    lead,
    sections,
    blocks,
    decorations: decorations || [],
    notes: notes || [],
  };
}
