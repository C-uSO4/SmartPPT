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

function markdownLinkEnd(value, start) {
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === ')') return index;
  }
  return -1;
}

export function markdownInlineText(value) {
  const source = String(value ?? '');
  let output = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\' && index + 1 < source.length && /[!-\/:-@\[-`{-~]/.test(source[index + 1])) {
      output += source[index + 1];
      index += 2;
      continue;
    }
    if (character === '`') {
      let count = 1;
      while (source[index + count] === '`') count += 1;
      const fence = '`'.repeat(count);
      const end = source.indexOf(fence, index + count);
      if (end >= 0) {
        let code = source.slice(index + count, end).replace(/\s+/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        output += code;
        index = end + count;
        continue;
      }
    }
    if (character === '[' || (character === '!' && source[index + 1] === '[')) {
      const labelStart = index + (character === '!' ? 2 : 1);
      const labelEnd = source.indexOf(']', labelStart);
      if (labelEnd >= 0 && source[labelEnd + 1] === '(') {
        const destinationEnd = markdownLinkEnd(source, labelEnd + 2);
        if (destinationEnd >= 0) {
          output += markdownInlineText(source.slice(labelStart, labelEnd));
          index = destinationEnd + 1;
          continue;
        }
      }
    }
    if (character === '<') {
      const end = source.indexOf('>', index + 1);
      if (end > index) {
        const inside = source.slice(index + 1, end);
        if (/^(?:https?:\/\/|mailto:)\S+$/i.test(inside)) {
          output += inside.replace(/^mailto:/i, '');
          index = end + 1;
          continue;
        }
        if (/^\/?(?:strong|em|b|i|u|s|del|span|code|br)(?:\s[^>]*)?$/i.test(inside)) {
          if (/^br\b/i.test(inside)) output += ' ';
          index = end + 1;
          continue;
        }
      }
    }
    if (['*', '_', '~'].includes(character)) {
      let count = 1;
      while (source[index + count] === character) count += 1;
      const previous = index ? source[index - 1] : '';
      const next = source[index + count] || '';
      const intrawordUnderscore = character === '_' && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
      const multiplication = character === '*' && count === 1 && /\d/.test(previous) && /\d/.test(next);
      const spacedAsterisk = character === '*' && count === 1 && (!previous || /\s/.test(previous)) && (!next || /\s/.test(next));
      const singleTilde = character === '~' && count < 2;
      if (intrawordUnderscore || multiplication || spacedAsterisk || singleTilde) output += character.repeat(count);
      index += count;
      continue;
    }
    output += character;
    index += 1;
  }
  return clean(output);
}

const DIRECTIVE_KINDS = new Set(['note', 'instruction', 'image_prompt']);

function explicitDirective(text) {
  const match = String(text).match(/^(备注|讲稿|演讲备注|注释|notes?|制作要求|页面要求|排版要求|设计要求|PPT\s*要求|模板要求|动画要求|instructions?|配图|配图要求|配图提示|图片要求|图片提示|插图要求|背景图要求|视觉建议|image[_ -]?prompts?)\s*[:：]\s*(.*)$/i);
  if (!match) return null;
  const label = match[1].toLowerCase().replace(/\s+/g, '');
  const kind = /^(?:备注|讲稿|演讲备注|注释|note|notes)$/.test(label) ? 'note'
    : /^(?:配图|配图要求|配图提示|图片要求|图片提示|插图要求|背景图要求|视觉建议|image_prompt|image-prompt|imageprompt|image_prompts|image-prompts|imageprompts)$/.test(label) ? 'image_prompt'
      : 'instruction';
  return { kind, text: match[2] };
}

function implicitDirective(text) {
  const value = clean(String(text).replace(/^>\s*/, ''));
  if (!value || /[。！？；!?;]$/.test(value)) return null;
  const commanded = /^(?:请|建议|需要|应当|应该|本页|此页|该页|这一页|下一页|页面|幻灯片|ppt)/i.test(value);
  if (!commanded) return null;
  const imageRequest = /(?:配图|插图|背景图|封面图|图片|图像|画面|绘图)/i.test(value)
    && /(?:生成|绘制|创作|补充|添加|插入|使用|采用|需要|建议|配图|插图)/.test(value);
  if (imageRequest) return { kind: 'image_prompt', text: value };
  const layoutRequest = /(?:排版|版式|布局|字体|字号|字色|颜色|对齐|行距|段距|模板|动画|切换|入场|美化|设计成|制作成)/.test(value);
  return layoutRequest ? { kind: 'instruction', text: value } : null;
}

function directive(text) {
  return explicitDirective(text) || implicitDirective(text);
}

function directiveFenceKind(value) {
  const label = String(value).toLowerCase().replace(/\s+/g, '');
  if (/^(?:note|notes|备注)$/.test(label)) return 'note';
  if (/^(?:配图|配图提示|图片提示|image_prompt|image-prompt|imageprompt|image_prompts|image-prompts|imageprompts)$/.test(label)) return 'image_prompt';
  return 'instruction';
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
  if (/<!DOCTYPE/i.test(source)) throw new Error('XML 包含不支持的 DOCTYPE');
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
  if (data.length >= 88 && data[0] === 1 && data[1] === 0 && data[2] === 0 && data[3] === 0
    && data[40] === 0x20 && data[41] === 0x45 && data[42] === 0x4d && data[43] === 0x46) return '.emf';
  throw new Error('图片仅支持有效的 PNG、JPEG 或 EMF 文件');
}

function imageDimensions(data) {
  const extension = imageExtension(data);
  if (data.length >= 24 && extension === '.png') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (extension === '.jpg') {
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
  if (extension === '.emf') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = view.getInt32(32, true) - view.getInt32(24, true);
    const height = view.getInt32(36, true) - view.getInt32(28, true);
    if (width > 0 && height > 0) return [1600, Math.max(1, Math.round(1600 * height / width))];
  }
  return [1600, 900];
}

function makeAsset(name, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const extension = imageExtension(data);
  const [width, height] = imageDimensions(data);
  return { name, bytes: data, width, height, extension, previewable: extension !== '.emf' };
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
  let noteKind = 'note';
  let noteStart = 0;
  let inComment = false;
  let commentKind = 'note';
  let commentStart = 0;
  let explicitKind = null;
  let inFormula = false;
  let formulaLines = [];
  let formulaStart = 0;

  function flushParagraph() {
    if (paragraphParts.length) {
      const value = markdownInlineText(joinWrapped(paragraphParts));
      if (value) blocks.push(block('paragraph', value, { line: paragraphStart }));
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
    if (inNotes) {
      if (text === ':::') {
        inNotes = false;
      } else if (text) {
        const value = markdownInlineText(text.replace(/^>\s*/, ''));
        if (value) blocks.push(block(noteKind, value, { line: number }));
      }
      index += 1;
      continue;
    }
    if (inComment) {
      const end = text.indexOf('-->');
      const value = markdownInlineText(end >= 0 ? text.slice(0, end) : text);
      if (value) blocks.push(block(commentKind, value, { line: number }));
      if (end >= 0) inComment = false;
      index += 1;
      continue;
    }
    if (explicitKind) {
      if (!text) {
        explicitKind = null;
        index += 1;
        continue;
      }
      if (!/^(?:#{1,6})(?:\s+|(?=[\u4e00-\u9fff]))/u.test(text)) {
        const value = markdownInlineText(text.replace(/^>\s*/, ''));
        if (value) blocks.push(block(explicitKind, value, { line: number }));
        index += 1;
        continue;
      }
      explicitKind = null;
    }
    const directiveFence = text.match(/^:::\s*(notes?|备注|instructions?|制作要求|页面要求|排版要求|设计要求|模板要求|动画要求|配图|配图提示|图片提示|image[_ -]?prompts?)\s*$/i);
    if (directiveFence) {
      flushParagraph();
      inNotes = true;
      noteKind = directiveFenceKind(directiveFence[1]);
      noteStart = number;
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
      const value = markdownInlineText(comment[1]);
      const classified = directive(value);
      if (value) blocks.push(block(classified?.kind || 'note', classified?.text || value, source));
      index += 1;
      continue;
    }
    if (text.startsWith('<!--')) {
      flushParagraph();
      inComment = true;
      commentStart = number;
      const value = markdownInlineText(text.slice(4));
      const classified = directive(value);
      commentKind = classified?.kind || 'note';
      if (value) blocks.push(block(commentKind, classified?.text || value, source));
      index += 1;
      continue;
    }
    const quoted = text.match(/^>\s*(.*)$/);
    if (quoted) text = quoted[1];
    const classified = directive(text);
    if (classified) {
      flushParagraph();
      const value = markdownInlineText(classified.text);
      if (value) blocks.push(block(classified.kind, value, source));
      explicitKind = explicitDirective(text) ? classified.kind : null;
      index += 1;
      continue;
    }
    const nextText = index + 1 < lines.length ? lines[index + 1].trim() : '';
    if (/^(?:=+|-+)$/.test(nextText) && !/^(?:#{1,6}|[-*+]|\d+[.)、])/.test(text)) {
      flushParagraph();
      const value = markdownInlineText(text);
      if (value) blocks.push(block('heading', value, source, nextText.startsWith('=') ? 1 : 2));
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
      const item = block('image', markdownInlineText(image[1]) || fallback || '图片', source);
      item.asset = resolveImage(filename, reference, number, assets);
      blocks.push(item);
      index += 1;
      continue;
    }
    const heading = text.match(/^(#{1,6})(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
    const listItem = raw.match(/^(\s*)(?:[-*+]|\d{1,9}[.)、])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
    if (heading) {
      flushParagraph();
      const value = markdownInlineText(heading[2].replace(/\s+#+\s*$/, ''));
      if (value) blocks.push(block('heading', value, source, heading[1].length));
    } else if (listItem) {
      flushParagraph();
      const indent = codePointLength(expandTabs(listItem[1]));
      const value = markdownInlineText(listItem[2].replace(/^\[[ xX]\]\s+/, ''));
      if (value) blocks.push(block('bullet', value, source, Math.min(6, 1 + Math.floor(indent / 2))));
    } else {
      if (!paragraphParts.length) paragraphStart = number;
      paragraphParts.push(text);
    }
    index += 1;
  }
  flushParagraph();
  if (inFormula) throw new Error(`第 ${formulaStart} 行公式缺少结束标记 $$`);
  if (inNotes) throw new Error(`第 ${noteStart} 行${noteKind === 'note' ? '备注' : '指令'}块缺少结束标记 :::`);
  if (inComment) throw new Error(`第 ${commentStart} 行注释块缺少结束标记 -->`);
  return blocks;
}

function textHeadingLevel(text, numericSections = false) {
  const value = clean(text);
  if (!value || codePointLength(value) > 80 || /[。！？；!?;]$/.test(value)) return null;
  if (/^第.{1,8}(?:章|篇|部分)(?:\s+.+)?$/u.test(value)) return 2;
  if (/^第.{1,8}节(?:\s+.+)?$/u.test(value)) return 3;
  if (/^[一二三四五六七八九十]+、\S+/u.test(value)) return 2;
  if (/^[（(][一二三四五六七八九十]+[）)]\s*\S+/u.test(value)) return 3;
  if (numericSections && /^\d{1,2}[.、]\s*\S+/u.test(value)) return 2;
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
    const classified = directive(text);
    if (classified) {
      flushParagraph();
      if (classified.text) blocks.push(block(classified.kind, classified.text, source));
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
    const listItem = raw.match(/^(\s*)(?:[-*•]|\d{1,9}[.)、]|[（(]\d+[）)])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$/u);
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
    const classified = directive(text);
    if (classified || /备注|讲稿|comment|notes?/i.test(styleName)) {
      const kind = /备注|讲稿|comment|notes?/i.test(styleName) ? 'note' : classified.kind;
      blocks.push(block(kind, classified?.text || text, source));
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

function shapeBounds(shape, parents = null) {
  const [x, y] = shapePosition(shape, parents);
  const transform = shapeXfrm(shape);
  const extent = transform ? findPath(transform, [[A, 'ext']]) : null;
  let width = integerValue(extent ? extent.getAttribute('cx') : null) / 9525;
  let height = integerValue(extent ? extent.getAttribute('cy') : null) / 9525;
  const parent = parents ? parents.get(shape) : null;
  if (parent && matches(parent, P, 'grpSp')) {
    const group = shapeXfrm(parent);
    const groupExtent = group ? findPath(group, [[A, 'ext']]) : null;
    const childExtent = group ? findPath(group, [[A, 'chExt']]) : null;
    if (groupExtent && childExtent) {
      width *= integerValue(groupExtent.getAttribute('cx'), 1) / Math.max(1, integerValue(childExtent.getAttribute('cx'), 1));
      height *= integerValue(groupExtent.getAttribute('cy'), 1) / Math.max(1, integerValue(childExtent.getAttribute('cy'), 1));
    }
  }
  return { left: x, top: y, width, height };
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

function inferredTitleEligible(shape, cover) {
  const value = clean(shapeText(shape).join(' '));
  if (!value || codePointLength(value) > 80 || /[。！？；!?;]/.test(value)) return false;
  if (smallPageNumber(value) || /^[-+]?\d+(?:\.\d+)?%?$/.test(value)) return false;
  return cover || !/\n/.test(shapeText(shape).join('\n').trim());
}

async function parsePptx(bytes) {
  const blocks = [];
  const notes = [];
  const archive = await readZip(bytes);
  const slides = await presentationSlides(archive);
  const mediaAssets = new Map();
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const index = slideIndex + 1;
    const root = parseXml(await archive.text(slides[slideIndex]));
    const parents = new Map();
    for (const parent of walk(root)) {
      for (const child of childElements(parent)) parents.set(child, parent);
    }
    const relationships = await relationshipTargets(archive, slides[slideIndex]);
    const elements = Array.from(walk(root)).filter(element => element.namespaceURI === P && ['sp', 'pic', 'graphicFrame'].includes(element.localName));
    const shapes = elements.filter(shape => matches(shape, P, 'sp') && shapeText(shape).length);
    let titleShape = shapes.find(shape => ['title', 'ctrTitle'].includes(placeholderType(shape))) || null;
    if (!titleShape && shapes.length) {
      const pool = shapes.filter(shape => matches(shape, P, 'sp'));
      const titleZone = index === 1 ? 360 : 180;
      const candidates = pool.filter(shape => {
        if (shapeTop(shape, parents) > titleZone || !inferredTitleEligible(shape, index === 1)) return false;
        const size = shapeFontSize(shape);
        const largestPeer = Math.max(0, ...pool.filter(peer => peer !== shape).map(peer => shapeFontSize(peer)));
        return size >= (index === 1 ? 22 : 18) && (index === 1 || size >= largestPeer + 2);
      });
      if (candidates.length) {
        const topmost = Math.min(...candidates.map(shape => shapeTop(shape, parents)));
        const nearest = candidates.filter(shape => shapeTop(shape, parents) <= topmost + 60);
        titleShape = nearest.reduce((best, shape) => shapeFontSize(shape) > shapeFontSize(best) ? shape : best, nearest[0]);
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
        if (index === 1 && delta >= 24 && delta <= 300 && size >= 12 && size < titleSize
          && codePointLength(value) <= 100 && !/[。！？；!?;]/.test(value) && !smallPageNumber(value)) {
          subtitleCandidates.push(shape);
        }
      }
      if (subtitleCandidates.length) {
        subtitleShape = subtitleCandidates.reduce((best, shape) => shapeTop(shape, parents) < shapeTop(best, parents) ? shape : best, subtitleCandidates[0]);
      }
    }
    const orderedShapes = shapes.map((shape, order) => ({ shape, order })).sort((left, right) => {
      return shapeTop(left.shape, parents) - shapeTop(right.shape, parents)
        || shapeLeft(left.shape, parents) - shapeLeft(right.shape, parents)
        || left.order - right.order;
    }).map(entry => entry.shape);
    orderedShapes.forEach((shape, orderedIndex) => {
      const paragraphNodes = descendants(shape, A, 'p').filter(paragraph => officeParagraphText(paragraph));
      const paragraphs = shapeText(shape);
      const bulletParagraphs = paragraphNodes.map(paragraph => Boolean(findPath(paragraph, [[A, 'pPr'], [A, 'buChar']])
        || findPath(paragraph, [[A, 'pPr'], [A, 'buAutoNum']])));
      const hasBullets = bulletParagraphs.some(Boolean);
      const source = { slide: index, shape: orderedIndex + 1, paragraph: 1 };
      let item;
      if (shape === titleShape) {
        item = block('heading', paragraphs.join('\n'), source, index === 1 ? 1 : 2);
      } else if (shape === subtitleShape) {
        item = block('subtitle', paragraphs.join('\n'), source);
      } else {
        const values = paragraphs.map((value, paragraphIndex) => bulletParagraphs[paragraphIndex] ? `• ${value}` : value);
        item = block(hasBullets ? 'bullet' : 'paragraph', values.join('\n'), source);
      }
      Object.assign(item, shapeBounds(shape, parents), { font_size: shapeFontSize(shape) });
      blocks.push(item);
    });
    for (const frame of elements) {
      if (!matches(frame, P, 'graphicFrame')) continue;
      const table = firstDescendant(frame, A, 'tbl');
      if (table) {
        const rows = descendants(table, A, 'tr').map(row => descendants(row, A, 'tc').map(cell => shapeText(cell).join('\n')));
        const item = block('table', rows.flat().join('\n'), { slide: index, shape: 0, paragraph: 1 });
        Object.assign(item, shapeBounds(frame, parents), { font_size: shapeFontSize(frame), rows });
        blocks.push(item);
        continue;
      }
      if (shapeText(frame).length) continue;
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
    for (const picture of elements) {
      if (!matches(picture, P, 'pic')) continue;
      const blip = firstDescendant(picture, A, 'blip');
      const relation = relationships[namespacedAttribute(blip, R, 'embed')] || {};
      if (!(relation.type || '').endsWith('/image') || !archive.has(relation.target)) continue;
      let asset = mediaAssets.get(relation.target);
      if (!asset) {
        asset = makeAsset(pathBasename(relation.target), await archive.bytes(relation.target));
        mediaAssets.set(relation.target, asset);
      }
      const properties = firstDescendant(picture, P, 'cNvPr');
      const alt = clean(properties ? properties.getAttribute('descr') : '') || '原稿图片';
      const item = block('image', alt, { slide: index, shape: 0, paragraph: 1 });
      Object.assign(item, shapeBounds(picture, parents), {
        font_size: 0, asset, audit: false, previewable: asset.previewable,
      });
      blocks.push(item);
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
    const repeatable = !['heading', 'subtitle', 'image', 'table'].includes(item.kind);
    const repeated = repeatable && !item.from_diagram && repeatedSlides.get(item.text).size >= 3
      && ((item.font_size > 0 && item.font_size <= 14) || headerFooter);
    const smallNumber = repeatable && smallPageNumber(item.text) && item.font_size > 0 && item.font_size <= 14;
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

function colorChannels(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value || '')) return null;
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
}

function hexColor(channels) {
  return `#${channels.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function transformedColor(value, node) {
  const channels = colorChannels(value);
  if (!channels) return null;
  for (const modifier of childElements(node)) {
    if (modifier.namespaceURI !== A) continue;
    const amount = Number(modifier.getAttribute('val')) / 100000;
    if (!Number.isFinite(amount)) continue;
    if (modifier.localName === 'tint') {
      for (let index = 0; index < 3; index += 1) channels[index] = channels[index] * amount + 255 * (1 - amount);
    } else if (modifier.localName === 'shade') {
      for (let index = 0; index < 3; index += 1) channels[index] *= amount;
    } else if (modifier.localName === 'lumMod') {
      for (let index = 0; index < 3; index += 1) channels[index] *= amount;
    } else if (modifier.localName === 'lumOff') {
      for (let index = 0; index < 3; index += 1) channels[index] += 255 * amount;
    }
  }
  return hexColor(channels);
}

function colorFromNode(node, themeColors, colorMap) {
  if (!node) return null;
  const colorNode = childElements(node).find(element => element.namespaceURI === A
    && ['srgbClr', 'schemeClr', 'sysClr'].includes(element.localName));
  if (!colorNode) return null;
  let value = null;
  if (colorNode.localName === 'srgbClr') {
    const rgb = colorNode.getAttribute('val') || '';
    value = /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.toUpperCase()}` : null;
  } else if (colorNode.localName === 'sysClr') {
    const rgb = colorNode.getAttribute('lastClr') || '';
    value = /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.toUpperCase()}` : null;
  } else {
    const name = colorNode.getAttribute('val') || '';
    value = themeColors[colorMap[name] || name] || null;
  }
  return value ? transformedColor(value, colorNode) : null;
}

function safeTypeface(value) {
  const font = String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return font && !font.startsWith('+') ? font.slice(0, 120) : null;
}

function themeDetails(root) {
  const colors = {};
  const fonts = { title: null, body: null };
  if (!root) return { colors, fonts };
  const scheme = firstDescendant(root, A, 'clrScheme');
  for (const entry of childElements(scheme)) {
    const value = colorFromNode(entry, colors, {});
    if (value) colors[entry.localName] = value;
  }
  for (const [name, key] of [['majorFont', 'title'], ['minorFont', 'body']]) {
    const schemeFont = firstDescendant(root, A, name);
    const eastAsian = firstDescendant(schemeFont, A, 'ea');
    const latin = firstDescendant(schemeFont, A, 'latin');
    fonts[key] = safeTypeface(eastAsian?.getAttribute('typeface'))
      || safeTypeface(latin?.getAttribute('typeface'));
  }
  return { colors, fonts };
}

function masterColorMap(root) {
  const result = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
  const map = childElements(root).find(element => matches(element, P, 'clrMap'));
  for (const name of Object.keys(result)) {
    const value = map?.getAttribute(name);
    if (value) result[name] = value;
  }
  return result;
}

async function imageLuminance(asset) {
  if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(new Blob([asset.bytes]));
    let canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(32, 18);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 18;
    } else {
      return null;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, 32, 18);
    const pixels = context.getImageData(0, 0, 32, 18).data;
    let total = 0;
    let weight = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      total += (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255 * alpha;
      weight += alpha;
    }
    return weight ? total / weight : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function templatePartBackground(archive, entry, pageSize, colors, colorMap, loadImage, warn) {
  if (!entry) return { color: null, image: null };
  const background = findPath(entry.root, [[P, 'cSld'], [P, 'bg']]);
  const properties = findPath(background, [[P, 'bgPr']]);
  let color = colorFromNode(findPath(properties, [[A, 'solidFill']]), colors, colorMap);
  if (!color) color = colorFromNode(findPath(background, [[P, 'bgRef']]), colors, colorMap);
  let image = null;
  const backgroundBlip = firstDescendant(properties, A, 'blip');
  if (backgroundBlip) image = await loadImage(entry, backgroundBlip);
  if (findPath(properties, [[A, 'gradFill']]) || findPath(properties, [[A, 'pattFill']])) {
    warn('模板的渐变或图案背景暂未支持，已回退为可用的纯色背景。');
  }
  if (!image) {
    const pageWidth = pageSize.width / 9525;
    const pageHeight = pageSize.height / 9525;
    for (const picture of descendants(entry.root, P, 'pic')) {
      const bounds = shapeBounds(picture);
      const fullPage = bounds.left <= pageWidth * 0.03 && bounds.top <= pageHeight * 0.03
        && bounds.left + bounds.width >= pageWidth * 0.97
        && bounds.top + bounds.height >= pageHeight * 0.97;
      if (!fullPage) continue;
      const blip = firstDescendant(picture, A, 'blip');
      if (blip) image = await loadImage(entry, blip);
      if (image) break;
    }
  }
  return { color, image };
}

function templateTextDetails(shape, colors, colorMap) {
  const runProperties = descendants(shape, A, 'rPr')[0]
    || descendants(shape, A, 'defRPr')[0]
    || descendants(shape, A, 'endParaRPr')[0]
    || null;
  const color = colorFromNode(findPath(runProperties, [[A, 'solidFill']]), colors, colorMap);
  const eastAsian = firstDescendant(runProperties, A, 'ea');
  const latin = firstDescendant(runProperties, A, 'latin');
  const font = safeTypeface(eastAsian?.getAttribute('typeface')) || safeTypeface(latin?.getAttribute('typeface'));
  const paragraph = findPath(shape, [[P, 'txBody'], [A, 'p']]);
  const paragraphProperties = findPath(paragraph, [[A, 'pPr']]);
  const alignments = { ctr: 'center', r: 'right', l: 'left' };
  const bodyProperties = findPath(shape, [[P, 'txBody'], [A, 'bodyPr']]);
  const anchors = { ctr: 'mid', b: 'bottom' };
  return {
    text: shapeText(shape).join('\n'),
    fontSize: integerValue(runProperties?.getAttribute('sz')) / 100 || shapeFontSize(shape),
    color,
    bold: runProperties?.hasAttribute('b') ? runProperties.getAttribute('b') === '1' : null,
    align: alignments[paragraphProperties?.getAttribute('algn')] || null,
    valign: anchors[bodyProperties?.getAttribute('anchor')] || null,
    font,
  };
}

function inheritedTemplateTextDetails(shape, chain, colors, colorMap) {
  const direct = templateTextDetails(shape, colors, colorMap);
  const placeholder = findPath(shape, [[P, 'nvSpPr'], [P, 'nvPr'], [P, 'ph']]);
  if (!placeholder) return direct;
  const type = placeholder.getAttribute('type') || 'body';
  const index = placeholder.getAttribute('idx');
  const inherited = [];
  for (const entry of chain.slice(1)) {
    if (!entry) continue;
    const match = descendants(entry.root, P, 'sp').find(candidate => {
      const ph = findPath(candidate, [[P, 'nvSpPr'], [P, 'nvPr'], [P, 'ph']]);
      if (!ph || (ph.getAttribute('type') || 'body') !== type) return false;
      return index === null || ph.getAttribute('idx') === index;
    });
    if (match) inherited.push(templateTextDetails(match, colors, colorMap));
  }
  const merged = { ...direct };
  for (const key of ['fontSize', 'color', 'bold', 'align', 'valign', 'font']) {
    if (merged[key] !== null && merged[key] !== 0 && merged[key] !== undefined) continue;
    const source = inherited.find(details => details[key] !== null && details[key] !== 0 && details[key] !== undefined);
    if (source) merged[key] = source[key];
  }
  return merged;
}

function templateShapeStyle(shape, colors, colorMap) {
  const properties = findPath(shape, [[P, 'spPr']]);
  const geometry = findPath(properties, [[A, 'prstGeom']])?.getAttribute('prst') || 'rect';
  const supported = ['rect', 'roundRect', 'ellipse', 'donut', 'line'];
  let fill = '#00000000';
  const solidFill = findPath(properties, [[A, 'solidFill']]);
  const fillReference = findPath(shape, [[P, 'style'], [A, 'fillRef']]);
  if (solidFill) {
    fill = colorFromNode(solidFill, colors, colorMap) || fill;
  } else if (!findPath(properties, [[A, 'noFill']]) && integerValue(fillReference?.getAttribute('idx')) > 0) {
    fill = colorFromNode(fillReference, colors, colorMap) || fill;
  }
  const line = findPath(properties, [[A, 'ln']]);
  const lineFill = findPath(line, [[A, 'solidFill']]);
  const lineReference = findPath(shape, [[P, 'style'], [A, 'lnRef']]);
  const lineColor = colorFromNode(lineFill || lineReference, colors, colorMap);
  const stroke = lineColor && !findPath(line, [[A, 'noFill']])
    ? { color: lineColor, widthPt: Math.max(0.25, integerValue(line?.getAttribute('w'), 12700) / 12700) }
    : null;
  return { shape: supported.includes(geometry) ? geometry : 'rect', fill, stroke };
}

export async function parseVisualTemplate(templateBytes) {
  const archive = await readZip(templateBytes);
  const slides = await presentationSlides(archive);
  if (!slides.length) throw new Error('模板中没有可读取的幻灯片');
  const warnings = [];
  const warningSet = new Set();
  const warn = message => {
    if (warningSet.has(message)) return;
    warningSet.add(message);
    warnings.push(message);
  };
  const partCache = new Map();
  const imageCache = new Map();
  const themeCache = new Map();

  async function loadPart(name) {
    if (!name || !archive.has(name)) return null;
    if (!partCache.has(name)) {
      partCache.set(name, (async () => ({
        part: name,
        root: parseXml(await archive.text(name)),
        relationships: await relationshipTargets(archive, name),
      }))());
    }
    return partCache.get(name);
  }

  async function relatedPart(entry, relationshipName) {
    if (!entry) return null;
    const relation = Object.values(entry.relationships).find(item => item.type.endsWith(`/${relationshipName}`));
    return relation ? loadPart(relation.target) : null;
  }

  async function loadTheme(entry) {
    const relation = entry
      ? Object.values(entry.relationships).find(item => item.type.endsWith('/theme'))
      : null;
    if (!relation || !archive.has(relation.target)) return { colors: {}, fonts: { title: null, body: null } };
    if (!themeCache.has(relation.target)) {
      themeCache.set(relation.target, (async () => themeDetails(parseXml(await archive.text(relation.target))))());
    }
    return themeCache.get(relation.target);
  }

  async function loadImage(entry, blip) {
    const relation = entry.relationships[namespacedAttribute(blip, R, 'embed')];
    if (!relation || !relation.type.endsWith('/image') || !archive.has(relation.target)) return null;
    if (!imageCache.has(relation.target)) {
      imageCache.set(relation.target, (async () => {
        try {
          const asset = makeAsset(pathBasename(relation.target), await archive.bytes(relation.target));
          if (!['.png', '.jpg'].includes(asset.extension)) {
            warn('网页预览仅支持 PNG/JPEG 模板图片；其他格式仍保留在下载稿中。');
            return null;
          }
          return { asset, luminance: await imageLuminance(asset) };
        } catch {
          warn('模板中有无法读取的图片，已从网页预览跳过；下载稿不受影响。');
          return null;
        }
      })());
    }
    return imageCache.get(relation.target);
  }

  const presentation = parseXml(await archive.text('ppt/presentation.xml'));
  const size = findPath(presentation, [[P, 'sldSz']]);
  const pageSize = {
    width: integerValue(size?.getAttribute('cx'), 12192000),
    height: integerValue(size?.getAttribute('cy'), 6858000),
  };
  if (Math.abs(pageSize.width / pageSize.height - 16 / 9) > 0.02) {
    warn('模板不是 16:9；下载稿保留模板原始页面尺寸，网页预览仅作近似展示。');
  }

  async function resolveReference(slidePart) {
    const slide = await loadPart(slidePart);
    const layout = await relatedPart(slide, 'slideLayout');
    const master = await relatedPart(layout, 'slideMaster');
    const theme = await loadTheme(master);
    if (!master) warn('未找到模板母版或主题，缺失的样式将回退到当前视觉风格。');
    const colorMap = masterColorMap(master?.root);
    const chain = [slide, layout, master];
    const backgrounds = [];
    for (const entry of chain) {
      backgrounds.push(await templatePartBackground(
        archive, entry, pageSize, theme.colors, colorMap, loadImage, warn,
      ));
    }
    const selectedIndex = backgrounds.findIndex(item => item.color || item.image);
    const selected = selectedIndex >= 0 ? backgrounds[selectedIndex] : { color: null, image: null };
    const inherited = selectedIndex >= 0
      ? backgrounds.slice(selectedIndex).find(item => item.color)?.color
      : null;
    const themeBackground = theme.colors[colorMap.bg1] || theme.colors.lt1 || null;
    return {
      reference: {
        background: selected.color || inherited || themeBackground,
        image: selected.image?.asset || null,
        imageLuminance: selected.image?.luminance ?? null,
        colors: theme.colors,
        fonts: theme.fonts,
      },
      chain,
      colorMap,
    };
  }

  async function collectDecorations(entry, inherited, contentIds, reference, colorMap) {
    if (!entry) return [];
    const elements = [];
    const parents = new Map();
    for (const parent of walk(entry.root)) {
      for (const child of childElements(parent)) parents.set(child, parent);
    }
    for (const shape of walk(entry.root)) {
      if (!matches(shape, P, 'sp') && !matches(shape, P, 'pic') && !matches(shape, P, 'cxnSp')) continue;
      const properties = firstDescendant(shape, P, 'cNvPr');
      if (!properties || properties.getAttribute('hidden') === '1') continue;
      if (inherited && firstDescendant(shape, P, 'ph')) continue;
      const id = properties.getAttribute('id') || '';
      const contentShape = !inherited && contentIds.has(id);
      if (contentShape && !matches(shape, P, 'sp')) continue;
      const bounds = shapeBounds(shape, parents);
      if (bounds.width < 0 || bounds.height < 0 || (bounds.width === 0 && bounds.height === 0)) continue;
      const base = { templateShapeId: id, templateSource: inherited ? 'inherited' : 'slide' };
      if (matches(shape, P, 'pic')) {
        if (bounds.width <= 0 || bounds.height <= 0) continue;
        const loaded = await loadImage(entry, firstDescendant(shape, A, 'blip'));
        if (!loaded) continue;
        const pageWidth = pageSize.width / 9525;
        const pageHeight = pageSize.height / 9525;
        const fullPage = bounds.left <= pageWidth * 0.03 && bounds.top <= pageHeight * 0.03
          && bounds.left + bounds.width >= pageWidth * 0.97
          && bounds.top + bounds.height >= pageHeight * 0.97;
        if (fullPage && loaded.asset === reference.image) continue;
        elements.push({
          ...base, type: 'image', asset: loaded.asset,
          alt: properties.getAttribute('descr') || properties.getAttribute('name') || '模板图片',
          x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height,
          fit: 'fill', templateDecoration: true,
        });
        continue;
      }
      const style = templateShapeStyle(shape, reference.colors, colorMap);
      if (style.fill !== '#00000000' || style.stroke) {
        elements.push({
          ...base, type: 'shape', shape: style.shape,
          x: bounds.left, y: bounds.top, w: Math.max(1, bounds.width), h: Math.max(1, bounds.height),
          fill: style.fill, ...(style.stroke ? { stroke: style.stroke } : {}),
          templateDecoration: true,
        });
      }
      const blipFill = findPath(shape, [[P, 'spPr'], [A, 'blipFill']]);
      if (blipFill) {
        const loaded = await loadImage(entry, firstDescendant(blipFill, A, 'blip'));
        if (loaded) {
          elements.push({
            ...base, type: 'image', asset: loaded.asset, alt: '模板形状图片',
            x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height,
            fit: 'fill', templateDecoration: true,
          });
        }
      }
      if (contentShape) continue;
      const details = templateTextDetails(shape, reference.colors, colorMap);
      if (!details.text) continue;
      elements.push({
        ...base, type: 'text', x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height,
        valign: details.valign || 'top',
        paragraphs: details.text.split('\n').map(value => ({
          align: details.align || 'left', lineSpacingPct: 110, spaceAfterPt: 0, bullet: false,
          runs: [{
            text: value, sizePt: details.fontSize || 16, bold: details.bold || false, italic: false,
            color: details.color || reference.colors[colorMap.tx1] || reference.colors.dk1 || '#142B33',
            font: details.font || reference.fonts.body || 'Microsoft YaHei',
          }],
        })),
        templateDecoration: true,
      });
    }
    return elements;
  }

  const candidates = [];
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const entry = await loadPart(slides[slideIndex]);
    const resolved = await resolveReference(slides[slideIndex]);
    const parents = new Map();
    for (const parent of walk(entry.root)) {
      for (const child of childElements(parent)) parents.set(child, parent);
    }
    const makeSlot = (shape, kind) => {
      const properties = firstDescendant(shape, P, 'cNvPr');
      const id = properties?.getAttribute('id') || '';
      if (!id) return null;
      const bounds = shapeBounds(shape, parents);
      const details = ['title', 'body'].includes(kind)
        ? inheritedTemplateTextDetails(shape, resolved.chain, resolved.reference.colors, resolved.colorMap)
        : null;
      const fontSize = details?.fontSize || (kind === 'title' ? 32 : 18);
      const lineCapacity = Math.max(1, Math.floor(bounds.height / Math.max(18, fontSize * 96 / 72 * 1.3)));
      const characterCapacity = Math.max(4, Math.floor(bounds.width / Math.max(8, fontSize * 96 / 72)));
      const text = clean(shapeText(shape).join(' '));
      const placeholder = placeholderType(shape);
      const textRole = kind === 'body' && !placeholder && text && codePointLength(text) <= 40
        && (fontSize >= 22 || bounds.height <= 72) ? 'label' : kind;
      return {
        id, kind, ...bounds, fontSize, text, textRole,
        color: details?.color || null,
        bold: details?.bold ?? null,
        align: details?.align || null,
        valign: details?.valign || null,
        font: details?.font || null,
        capacity: Math.max(8, lineCapacity * characterCapacity),
      };
    };
    const textShapes = descendants(entry.root, P, 'sp').filter(shape => findPath(shape, [[P, 'txBody']]));
    const titledShapes = textShapes.filter(shape => shapeText(shape).length);
    let titleShape = textShapes.find(shape => ['title', 'ctrTitle'].includes(placeholderType(shape))) || null;
    if (!titleShape) {
      const titleCandidates = titledShapes.filter(shape => inferredTitleEligible(shape, slideIndex === 0)
        && shapeTop(shape, parents) <= pageSize.height / 9525 * 0.45 && shapeFontSize(shape) >= 18);
      if (titleCandidates.length) {
        titleShape = titleCandidates.reduce((best, shape) => shapeFontSize(shape) > shapeFontSize(best) ? shape : best, titleCandidates[0]);
      }
    }
    const bodySlots = [];
    const contentTextIds = [];
    for (const shape of textShapes) {
      if (shape === titleShape) continue;
      const slot = makeSlot(shape, 'body');
      if (!slot || slot.width < 80 || slot.height < 24) continue;
      const placeholder = placeholderType(shape);
      if (!slot.text && !placeholder) continue;
      const decorative = !placeholder && slot.text && (smallPageNumber(slot.text)
        || (slot.fontSize <= 14 && (slot.top <= 90 || slot.top + slot.height >= pageSize.height / 9525 - 80)));
      if (decorative) continue;
      bodySlots.push(slot);
      contentTextIds.push(slot.id);
    }
    bodySlots.sort((left, right) => left.top - right.top || left.left - right.left);
    const pictureSlots = descendants(entry.root, P, 'pic').map(shape => makeSlot(shape, 'picture')).filter(Boolean)
      .filter(slot => slot.width * slot.height >= 10000
        && slot.width * slot.height < pageSize.width / 9525 * pageSize.height / 9525 * 0.8)
      .sort((left, right) => right.width * right.height - left.width * left.height);
    const tableSlots = descendants(entry.root, P, 'graphicFrame')
      .filter(frame => firstDescendant(frame, A, 'tbl'))
      .map(frame => makeSlot(frame, 'table')).filter(Boolean);
    contentTextIds.push(...tableSlots.map(slot => slot.id));
    const title = titleShape ? makeSlot(titleShape, 'title') : null;
    const contentIds = new Set([...(title ? [title.id] : []), ...contentTextIds]);
    const decorations = [];
    for (const [chainIndex, part] of [[2, resolved.chain[2]], [1, resolved.chain[1]], [0, resolved.chain[0]]]) {
      decorations.push(...await collectDecorations(
        part, chainIndex !== 0, contentIds, resolved.reference, resolved.colorMap,
      ));
    }
    candidates.push({
      slidePart: slides[slideIndex],
      slideNumber: slideIndex + 1,
      title,
      bodySlots,
      pictureSlots,
      tableSlots,
      contentTextIds,
      visual: { ...resolved.reference, decorations },
    });
  }

  const cover = candidates[0].visual;
  const content = candidates[1]?.visual || cover;
  return {
    cover,
    content,
    colors: cover.colors,
    fonts: {
      title: cover.fonts.title || content.fonts.title,
      body: cover.fonts.body || content.fonts.body,
    },
    pageSize,
    candidates,
    warnings,
  };
}

function extensionOf(filename) {
  const base = pathBasename(filename);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function partitionBlockRoles(roleBlocks) {
  const blocks = [];
  const notes = [];
  const instructions = [];
  const imagePrompts = [];
  for (const item of roleBlocks) {
    if (item.kind === 'note') notes.push(item);
    else if (item.kind === 'instruction') instructions.push(item);
    else if (item.kind === 'image_prompt') imagePrompts.push(item);
    else blocks.push(item);
  }
  return { blocks, notes, instructions, imagePrompts };
}

export function createImageAsset(name, bytes) {
  return makeAsset(name, bytes);
}

export async function parseDocument(filename, fileBytes, assets = []) {
  const extension = extensionOf(filename);
  let content;
  let decorations = [];
  let speakerNotes = [];
  if (['md', 'markdown'].includes(extension)) {
    content = parseMarkdown(filename, fileBytes, assets);
  } else if (extension === 'txt') {
    content = parseText(fileBytes);
  } else if (extension === 'docx') {
    content = await parseDocx(fileBytes);
  } else if (extension === 'pptx') {
    [content, decorations, speakerNotes] = await parsePptx(fileBytes);
  } else {
    throw new Error('仅支持 .docx、.md、.markdown、.txt、.pptx');
  }
  const roleBlocks = content.concat(speakerNotes);
  roleBlocks.forEach((item, index) => {
    item.id = `b${String(index + 1).padStart(4, '0')}`;
    item.numbers = item.text.match(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?/g) || [];
  });
  const partitioned = partitionBlockRoles(roleBlocks);
  if (!partitioned.blocks.length) throw new Error('输入中没有可识别的正文');
  return { ...partitioned, decorations, roleBlocks };
}

function pptxChapters(sections) {
  const overview = sections.find(section => /^(?:内容结构|目录|大纲|CONTENTS)$/i.test(section.title));
  const chapters = [];
  if (overview) {
    const items = overview.items.slice().sort((left, right) => left.top - right.top || left.left - right.left);
    items.forEach((item, index) => {
      if (!/^\d{1,2}$/.test(item.text)) return;
      const titleItem = items.slice(index + 1).find(candidate => !/^\d{1,2}$/.test(candidate.text));
      if (!titleItem) return;
      chapters.push({ title: titleItem.text, number: Number(item.text), heading_id: titleItem.id, items: [] });
    });
  }
  const contentSections = sections.filter(section => section !== overview);
  contentSections.forEach(section => {
    const match = section.title.match(/^\s*(\d{1,2})(?=[.\s、．]|$)/u);
    if (match && !chapters.length) {
      chapters.push({ title: section.title.replace(/^\s*\d{1,2}(?:\.\d+)*[.\s、．-]*/u, ''), number: Number(match[1]), heading_id: section.heading_id, items: [] });
    }
    const number = match ? Number(match[1]) : null;
    let chapterIndex = number === null ? chapters.length - 1 : chapters.findIndex(chapter => chapter.number === number);
    if (chapterIndex < 0 && number !== null) {
      chapters.push({ title: section.title, number, heading_id: section.heading_id, items: [] });
      chapterIndex = chapters.length - 1;
    }
    section.chapter_index = Math.max(0, chapterIndex);
    section.chapter_title = chapters[section.chapter_index] ? chapters[section.chapter_index].title : section.title;
    if (section.source_slide === null && section.items.length) section.source_slide = section.items[0].source.slide ?? null;
  });
  return chapters;
}

export function makeModel(filename, blocks, decorations = [], notes = [], instructions = [], imagePrompts = []) {
  const format = extensionOf(filename);
  const headings = blocks.filter(item => item.kind === 'heading');
  const sections = [];
  const lead = [];
  let titleItem = null;
  let titleId = null;
  let title = pathStem(filename);

  if (format === 'pptx') {
    titleItem = blocks.find(item => item.kind === 'heading' && item.source.slide === 1) || null;
    if (titleItem) {
      title = titleItem.text;
      titleId = titleItem.id;
    }
    lead.push(...blocks.filter(item => item.source.slide === 1 && item !== titleItem));
    const slideNumbers = [...new Set(blocks.map(item => item.source.slide).filter(slide => slide > 1))]
      .sort((left, right) => left - right);
    for (const slide of slideNumbers) {
      const slideBlocks = blocks.filter(item => item.source.slide === slide);
      const heading = slideBlocks.find(item => item.kind === 'heading') || null;
      sections.push({
        title: heading ? heading.text : `第 ${slide} 页`,
        heading_id: heading ? heading.id : null,
        source_slide: slide,
        items: slideBlocks.filter(item => item !== heading),
      });
    }
  } else {
    const firstHeading = headings[0] || null;
    titleItem = firstHeading && (firstHeading.level === 1 || blocks[0] === firstHeading) ? firstHeading : null;
    if (titleItem) {
      title = titleItem.text;
      titleId = titleItem.id;
    }
    let current = null;
    const remainingLevels = headings.filter(item => item !== titleItem).map(item => item.level);
    const sectionLevel = remainingLevels.length ? Math.min(...remainingLevels) : 2;
    for (const item of blocks) {
      if (item === titleItem) continue;
      if (item.kind === 'heading' && item.level <= sectionLevel) {
        current = { title: item.text, heading_id: item.id, source_slide: item.source.slide ?? null, items: [] };
        sections.push(current);
      } else if (!current) {
        lead.push(item);
      } else {
        current.items.push(item);
      }
    }
    if (!sections.length) {
      sections.push({ title, heading_id: titleId, items: blocks.filter(item => item !== titleItem) });
      lead.length = 0;
    }
  }

  const model = {
    source: { filename, format },
    title,
    title_id: titleId,
    lead,
    sections,
    blocks,
    decorations: decorations || [],
    notes: notes || [],
    instructions: instructions || [],
    image_prompts: imagePrompts || [],
  };
  if (format === 'pptx') model.chapters = pptxChapters(sections);
  return model;
}
