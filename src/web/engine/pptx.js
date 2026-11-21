import { readZip, writeZip } from './zip.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const FONT = 'Microsoft YaHei';
const DEFAULT_BACKGROUND = '#F3F1EB';
const DEFAULT_INK = '#153B3C';
const DRAWABLE_TAGS = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp']);
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

function pptxError(message) {
  const error = new Error(message);
  error.name = 'PptxError';
  return error;
}

function xmlText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function colorXml(value) {
  const text = String(value ?? '#00000000').replace(/^#+/, '');
  const rgb = text.slice(0, 6).toUpperCase();
  const alpha = text.length === 8 ? text.slice(6, 8) : 'FF';
  if (alpha === '00') return '<a:noFill/>';
  const alphaXml = alpha === 'FF' ? '' : `<a:alpha val="${Math.round(parseInt(alpha, 16) / 255 * 100000)}"/>`;
  return `<a:solidFill><a:srgbClr val="${rgb}">${alphaXml}</a:srgbClr></a:solidFill>`;
}

function xfrmXml(element) {
  const values = ['x', 'y', 'w', 'h'].map(key => Number(element[key]));
  if (values.some(value => !Number.isFinite(value))) throw pptxError('页面元素的 x、y、w、h 必须是有限数值');
  const [x, y, w, h] = values.map(value => Math.round(value * 9525));
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.max(1, w)}" cy="${Math.max(1, h)}"/></a:xfrm>`;
}

function shapeXml(element, shapeId, name) {
  const geometry = element.shape || 'rect';
  const fill = colorXml(element.fill || '#00000000');
  let line = '<a:ln><a:noFill/></a:ln>';
  if (element.stroke) {
    const width = Math.round(Number(element.stroke.widthPt ?? 1) * 12700);
    if (!Number.isFinite(width)) throw pptxError(`形状“${name}”的线宽无效`);
    line = `<a:ln w="${width}">${colorXml(element.stroke.color)}</a:ln>`;
  }
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="${xmlText(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr>${xfrmXml(element)}<a:prstGeom prst="${xmlText(geometry)}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`;
}

function paragraphXml(paragraph) {
  const align = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[paragraph.align || 'left'] || 'l';
  const spacing = Math.round(Number(paragraph.lineSpacingPct ?? 130) * 1000);
  const after = Math.round(Number(paragraph.spaceAfterPt ?? 0) * 100);
  const runs = [];
  for (const run of paragraph.runs || []) {
    const size = Math.round(Number(run.sizePt ?? 16) * 100);
    if (!Number.isFinite(size) || !Number.isFinite(spacing) || !Number.isFinite(after)) throw pptxError('文字段落的字号或间距无效');
    const bold = run.bold ? ' b="1"' : '';
    const italic = run.italic ? ' i="1"' : '';
    const font = xmlText(run.font || FONT);
    runs.push(`<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${size}"${bold}${italic} dirty="0">${colorXml(run.color || DEFAULT_INK)}<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/></a:rPr><a:t>${xmlText(run.text || '')}</a:t></a:r>`);
  }
  return `<a:p><a:pPr algn="${align}"><a:lnSpc><a:spcPct val="${spacing}"/></a:lnSpc><a:spcAft><a:spcPts val="${after}"/></a:spcAft></a:pPr>${runs.join('')}</a:p>`;
}

function textXml(element, shapeId, name) {
  const paragraphs = (element.paragraphs || []).map(paragraphXml).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="${xmlText(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>${xfrmXml(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
<p:txBody><a:bodyPr wrap="square" rtlCol="0" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function pictureXml(element, shapeId, name, relationshipId) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${shapeId}" name="${xmlText(name)}" descr="${xmlText(element.alt || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function effectXml(ctnId, spid, delay, duration) {
  return `<p:par>
  <p:cTn id="${ctnId}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="withEffect">
    <p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>
    <p:childTnLst>
      <p:set>
        <p:cBhvr>
          <p:cTn id="${ctnId + 1}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>
          <p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>
          <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>
        </p:cBhvr>
        <p:to><p:strVal val="visible"/></p:to>
      </p:set>
      <p:animEffect transition="in" filter="fade">
        <p:cBhvr>
          <p:cTn id="${ctnId + 2}" dur="${duration}"/>
          <p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>
        </p:cBhvr>
      </p:animEffect>
    </p:childTnLst>
  </p:cTn>
</p:par>`;
}

function transitionXml(duration = 650) {
  return `<mc:AlternateContent xmlns:mc="${MC}" xmlns:p="${P}" xmlns:p14="${P14}" xmlns:p159="${P159}">
  <mc:Choice Requires="p159"><p:transition spd="slow" p14:dur="${duration}"><p159:morph option="byObject"/></p:transition></mc:Choice>
  <mc:Fallback><p:transition spd="med" p14:dur="450"><p:fade thruBlk="0"/></p:transition></mc:Fallback>
</mc:AlternateContent>`;
}

function timingXml(entries) {
  let nextId = 5;
  const effects = entries.map(([shapeId, delay, duration]) => {
    const xml = effectXml(nextId, shapeId, delay, duration);
    nextId += 3;
    return xml;
  }).join('');
  return `<p:timing xmlns:p="${P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn>
<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>
</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

function validateJob(job) {
  if (!job || !Array.isArray(job.pages)) throw pptxError('job.pages 必须是页面数组');
  if (job.page_count !== undefined && job.page_count !== job.pages.length) throw pptxError('job.page_count 与 job.pages 数量不一致');
  job.pages.forEach((pageJob, index) => {
    if (!pageJob || pageJob.number !== index + 1 || !pageJob.page || !Array.isArray(pageJob.page.elements)) {
      throw pptxError(`第 ${index + 1} 页的 job 结构无效，页码必须从 1 连续编号`);
    }
    const count = pageJob.page.elements.length;
    for (const marker of pageJob.motion || []) {
      if (!Number.isInteger(marker.element_index) || marker.element_index < 0 || marker.element_index >= count || typeof marker.name !== 'string') {
        throw pptxError(`第 ${index + 1} 页存在无效的 Morph marker`);
      }
    }
    for (const elementIndex of pageJob.fade || []) {
      if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex >= count) {
        throw pptxError(`第 ${index + 1} 页存在越界的 Fade 元素索引`);
      }
    }
  });
  return job.pages;
}

function markerMap(pageJob) {
  const names = new Map();
  for (const marker of pageJob.motion || []) names.set(marker.element_index, marker.name);
  return names;
}

function fadeEntries(pageJob) {
  const paired = new Set(markerMap(pageJob).keys());
  const entries = [];
  (pageJob.fade || []).forEach((elementIndex, order) => {
    if (!paired.has(elementIndex)) entries.push([String(elementIndex + 2), 100 + order * 55, 320]);
  });
  return entries;
}

function imageBytes(element, pageNumber) {
  const asset = element.asset;
  if (!asset) throw pptxError(`第 ${pageNumber} 页图片缺少 asset 数据`);
  let bytes;
  if (asset.bytes instanceof Uint8Array) bytes = asset.bytes;
  else if (asset.bytes instanceof ArrayBuffer) bytes = new Uint8Array(asset.bytes);
  else throw pptxError(`第 ${pageNumber} 页图片 asset.bytes 必须是 Uint8Array`);
  if (!bytes.length) throw pptxError(`第 ${pageNumber} 页图片内容为空`);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return { bytes, extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { bytes, extension: '.jpg' };
  }
  if (bytes.length >= 88 && bytes[0] === 1 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
      && bytes[40] === 0x20 && bytes[41] === 0x45 && bytes[42] === 0x4D && bytes[43] === 0x46) {
    return { bytes, extension: '.emf' };
  }
  throw pptxError('图片仅支持有效的 PNG、JPEG 或 EMF 文件');
}

function slideXml(pageJob) {
  const page = pageJob.page;
  const markers = markerMap(pageJob);
  const shapes = [];
  const pictures = [];
  let pictureCount = 0;
  page.elements.forEach((element, index) => {
    const shapeId = index + 2;
    const name = markers.get(index) ?? `Element ${shapeId}`;
    if (element.type === 'shape') shapes.push(shapeXml(element, shapeId, name));
    else if (element.type === 'text') shapes.push(textXml(element, shapeId, name));
    else if (element.type === 'image') {
      pictureCount += 1;
      shapes.push(pictureXml(element, shapeId, name, `rId${pictureCount + 1}`));
      pictures.push(imageBytes(element, pageJob.number));
    } else {
      throw pptxError('本地渲染器仅接受文字、形状和 PNG/JPEG/EMF 图片');
    }
  });
  const background = String(page.background || DEFAULT_BACKGROUND).replace(/^#+/, '').slice(0, 6).toUpperCase();
  const entries = fadeEntries(pageJob);
  const transition = pageJob.number > 1 ? transitionXml() : '';
  const timing = entries.length ? timingXml(entries) : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" xmlns:mc="${MC}" xmlns:p14="${P14}" xmlns:p159="${P159}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition}${timing}</p:sld>`;
  return { xml, pictures, fadeCount: entries.length };
}

function presentationXml(pages) {
  const slideIds = pages.map((page, index) => `<p:sldId id="${255 + index + 1}" r:id="rId${index + 2}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

function presentationRelsXml(pages) {
  const relationships = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];
  pages.forEach((page, index) => {
    relationships.push(`<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${page.number}.xml"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}">${relationships.join('')}</Relationships>`;
}

function slideRelsXml(pictures) {
  const relationships = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'];
  pictures.forEach((picture, index) => {
    relationships.push(`<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${picture.mediaName}"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}">${relationships.join('')}</Relationships>`;
}

function updateContentTypes(source, pages) {
  let contentTypes = source.replace(/<Override\b[^>]*\bPartName=(["'])\/ppt\/slides\/slide\d+\.xml\1[^>]*\/\s*>/gi, '');
  const defaults = [];
  for (const [extension, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['emf', 'image/x-emf']]) {
    const pattern = new RegExp(`<Default\\b[^>]*\\bExtension=(["'])${extension}\\1`, 'i');
    if (!pattern.test(contentTypes)) defaults.push(`<Default Extension="${extension}" ContentType="${mime}"/>`);
  }
  const overrides = pages.map(page => `<Override PartName="/ppt/slides/slide${page.number}.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>`).join('');
  if (!/<\/Types\s*>/i.test(contentTypes)) throw pptxError('base.pptx 的 [Content_Types].xml 结构无效');
  contentTypes = contentTypes.replace(/<\/Types\s*>/i, `${defaults.join('')}${overrides}</Types>`);
  return contentTypes;
}

function serializeXml(document) {
  if (typeof XMLSerializer !== 'function') throw pptxError('当前浏览器不支持 XMLSerializer，无法写入模板 PPTX');
  const source = new XMLSerializer().serializeToString(document).replace(/^<\?xml[\s\S]*?\?>/, '');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${source}`;
}

function partRelationshipsName(part) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

function addRelationship(document, type, target) {
  const root = document.documentElement;
  let largest = 0;
  for (const relation of Array.from(root.childNodes)) {
    if (relation.nodeType !== 1) continue;
    const match = /^rId(\d+)$/.exec(relation.getAttribute('Id') || '');
    if (match) largest = Math.max(largest, Number(match[1]));
  }
  const id = `rId${largest + 1}`;
  const relation = document.createElementNS(RELATIONSHIPS, 'Relationship');
  relation.setAttribute('Id', id);
  relation.setAttribute('Type', type);
  relation.setAttribute('Target', target);
  root.appendChild(relation);
  return id;
}

function shapeById(document, id) {
  const properties = elementsNs(document, P, 'cNvPr').find(node => node.getAttribute('id') === String(id));
  let shape = properties;
  while (shape && (shape.namespaceURI !== P || !DRAWABLE_TAGS.has(shape.localName))) shape = shape.parentNode;
  return shape || null;
}

function copyRunProperties(document, source, fontSize) {
  const properties = document.createElementNS(A, 'a:rPr');
  if (source) {
    for (const attribute of Array.from(source.attributes)) properties.setAttribute(attribute.name, attribute.value);
    for (const child of Array.from(source.childNodes)) properties.appendChild(child.cloneNode(true));
  }
  properties.setAttribute('lang', properties.getAttribute('lang') || 'zh-CN');
  properties.setAttribute('dirty', '0');
  if (Number.isFinite(fontSize)) properties.setAttribute('sz', String(Math.max(100, Math.round(fontSize * 100))));
  return properties;
}

function replaceShapeText(document, shape, value, fontSize) {
  const body = directChild(shape, P, 'txBody');
  if (!body) return false;
  const paragraphs = Array.from(body.childNodes).filter(node => node.nodeType === 1 && node.namespaceURI === A && node.localName === 'p');
  const model = paragraphs.find(paragraph => firstDescendant(paragraph, A, 'r')) || paragraphs[0] || null;
  const paragraphProperties = directChild(model, A, 'pPr');
  const runProperties = firstDescendant(model, A, 'rPr') || directChild(model, A, 'endParaRPr');
  paragraphs.forEach(paragraph => body.removeChild(paragraph));
  const lines = String(value ?? '').split('\n');
  for (const line of lines) {
    const paragraph = document.createElementNS(A, 'a:p');
    if (paragraphProperties) paragraph.appendChild(paragraphProperties.cloneNode(true));
    if (line) {
      const run = document.createElementNS(A, 'a:r');
      run.appendChild(copyRunProperties(document, runProperties, fontSize));
      const textNode = document.createElementNS(A, 'a:t');
      textNode.textContent = line;
      run.appendChild(textNode);
      paragraph.appendChild(run);
    } else if (runProperties) {
      paragraph.appendChild(copyRunProperties(document, runProperties, fontSize));
      const endProperties = paragraph.lastChild;
      if (endProperties?.localName === 'rPr') {
        const end = document.createElementNS(A, 'a:endParaRPr');
        for (const attribute of Array.from(endProperties.attributes)) end.setAttribute(attribute.name, attribute.value);
        for (const child of Array.from(endProperties.childNodes)) end.appendChild(child.cloneNode(true));
        paragraph.replaceChild(end, endProperties);
      }
    }
    body.appendChild(paragraph);
  }
  return true;
}

function importedXmlNode(document, xml) {
  const fragment = parseXml(`<root xmlns:a="${A}" xmlns:p="${P}" xmlns:r="${R}">${xml}</root>`, '模板插入元素');
  const node = fragment.documentElement.firstChild;
  if (!node) throw pptxError('模板插入元素为空');
  return document.importNode(node, true);
}

function shapeTransform(shape) {
  return directChild(directChild(shape, P, 'spPr'), A, 'xfrm') || directChild(shape, P, 'xfrm');
}

function replaceShape(document, shape, xml) {
  if (!shape?.parentNode) throw pptxError('模板内容槽位已从页面中移除');
  const replacement = importedXmlNode(document, xml);
  const sourceTransform = shapeTransform(shape);
  const targetTransform = shapeTransform(replacement);
  if (sourceTransform && targetTransform) {
    for (const attribute of Array.from(sourceTransform.attributes)) targetTransform.setAttribute(attribute.name, attribute.value);
    for (const name of ['off', 'ext']) {
      const source = directChild(sourceTransform, A, name);
      const target = directChild(targetTransform, A, name);
      if (source && target) {
        for (const attribute of Array.from(source.attributes)) target.setAttribute(attribute.name, attribute.value);
      }
    }
  }
  shape.parentNode.replaceChild(replacement, shape);
}

function tableFrameXml(assignment) {
  const slot = assignment.slot;
  const rows = Array.isArray(assignment.rows) ? assignment.rows : [];
  const columnCount = Math.max(1, ...rows.map(row => Array.isArray(row) ? row.length : 0));
  const rowCount = Math.max(1, rows.length);
  const width = Math.max(1, Math.round(slot.width * 9525));
  const height = Math.max(1, Math.round(slot.height * 9525));
  const columnWidth = Math.max(1, Math.floor(width / columnCount));
  const rowHeight = Math.max(1, Math.floor(height / rowCount));
  const fontSize = Math.max(800, Math.min(1400, Math.round(slot.height / rowCount * 45)));
  const grid = Array.from({ length: columnCount }, () => `<a:gridCol w="${columnWidth}"/>`).join('');
  const body = Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => {
      const value = row[columnIndex] ?? '';
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${fontSize}"${rowIndex === 0 ? ' b="1"' : ''} dirty="0"/><a:t>${xmlText(value)}</a:t></a:r></a:p></a:txBody><a:tcPr marL="45720" marR="45720" marT="22860" marB="22860" anchor="ctr"/></a:tc>`;
    }).join('');
    return `<a:tr h="${rowHeight}">${cells}</a:tr>`;
  }).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${xmlText(slot.id)}" name="SmartPPT Table ${xmlText(slot.id)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(slot.left * 9525)}" y="${Math.round(slot.top * 9525)}"/><a:ext cx="${width}" cy="${height}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function removeTemplateMotion(document) {
  const root = document.documentElement;
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const motion = (child.namespaceURI === P && ['transition', 'timing'].includes(child.localName))
      || (child.namespaceURI === MC && child.localName === 'AlternateContent'
        && (firstDescendant(child, P, 'transition') || firstDescendant(child, P, 'timing')));
    if (motion) root.removeChild(child);
  }
}

function insertSlideMotion(document, pageJob) {
  removeTemplateMotion(document);
  const root = document.documentElement;
  const extensionList = directChild(root, P, 'extLst');
  if (pageJob.number > 1) {
    const transition = parseXml(transitionXml(), '模板切换').documentElement;
    root.insertBefore(document.importNode(transition, true), extensionList);
  }
  const entries = (pageJob.plan.template.fadeShapeIds || []).map((shapeId, order) => [String(shapeId), 100 + order * 55, 320]);
  if (entries.length) {
    const timing = parseXml(timingXml(entries), '模板入场动画').documentElement;
    root.insertBefore(document.importNode(timing, true), extensionList);
  }
  return entries.length;
}

function templateFadeEntries(pageJob) {
  return (pageJob.plan?.template?.fadeShapeIds || []).map((shapeId, order) => [String(shapeId), 100 + order * 55, 320]);
}

/** Clone selected template slides and fill their real content slots. */
export async function renderTemplatePackage(job, templateBytes) {
  const pages = validateJob(job);
  const archive = await readZip(templateBytes);
  if (!archive.has('ppt/presentation.xml') || !archive.has('ppt/_rels/presentation.xml.rels')) {
    throw pptxError('模板缺少 presentation.xml 或其关系文件');
  }
  const presentation = parseXml(await archive.text('ppt/presentation.xml'), '模板 presentation.xml');
  const presentationRels = parseXml(await archive.text('ppt/_rels/presentation.xml.rels'), '模板 presentation.xml.rels');
  const slideType = `${R}/slide`;
  for (const relation of Array.from(presentationRels.documentElement.childNodes)) {
    if (relation.nodeType === 1 && relation.getAttribute('Type') === slideType) {
      presentationRels.documentElement.removeChild(relation);
    }
  }
  let slideList = directChild(presentation.documentElement, P, 'sldIdLst');
  if (!slideList) {
    slideList = presentation.createElementNS(P, 'p:sldIdLst');
    presentation.documentElement.insertBefore(slideList, directChild(presentation.documentElement, P, 'sldSz'));
  }
  while (slideList.firstChild) slideList.removeChild(slideList.firstChild);

  const entries = [];
  for (const name of archive.names()) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)) continue;
    if (['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', '[Content_Types].xml'].includes(name)) continue;
    entries.push({ name, data: await archive.bytes(name) });
  }

  let fadeCount = 0;
  for (const pageJob of pages) {
    const template = pageJob.plan?.template;
    if (!template?.slidePart || !archive.has(template.slidePart)) throw pptxError(`第 ${pageJob.number} 页缺少所选模板页`);
    const document = parseXml(await archive.text(template.slidePart), `模板第 ${pageJob.number} 页来源`);
    const relationshipsName = partRelationshipsName(template.slidePart);
    const relationships = archive.has(relationshipsName)
      ? parseXml(await archive.text(relationshipsName), `${template.slidePart} 关系`)
      : parseXml(`<Relationships xmlns="${RELATIONSHIPS}"/>`, '新建模板页关系');
    for (const relation of Array.from(relationships.documentElement.childNodes)) {
      if (relation.nodeType === 1 && /\/(?:notesSlide|comments)$/.test(relation.getAttribute('Type') || '')) {
        relationships.documentElement.removeChild(relation);
      }
    }

    const titleShape = shapeById(document, template.title.slot.id);
    if (!titleShape || !replaceShapeText(document, titleShape, template.title.text, template.title.fontSize)) {
      throw pptxError(`第 ${pageJob.number} 页模板标题槽位 ${template.title.slot.id} 不可用`);
    }
    for (const assignment of template.assignments) {
      const shape = shapeById(document, assignment.slot.id);
      if (!shape) throw pptxError(`第 ${pageJob.number} 页模板槽位 ${assignment.slot.id} 不存在`);
      if (assignment.kind === 'text' || assignment.kind === 'title') {
        if (!replaceShapeText(document, shape, assignment.text, assignment.fontSize)) throw pptxError(`模板槽位 ${assignment.slot.id} 不是可编辑文字框`);
      } else if (assignment.kind === 'image') {
        const picture = imageBytes({ asset: assignment.asset }, pageJob.number);
        picture.mediaName = `smartppt-slide${pageJob.number}-image${entries.filter(entry => entry.name.startsWith('ppt/media/smartppt-')).length + 1}${picture.extension}`;
        entries.push({ name: `ppt/media/${picture.mediaName}`, data: picture.bytes });
        const relationshipId = addRelationship(relationships, `${R}/image`, `../media/${picture.mediaName}`);
        if (assignment.slotKind === 'picture' && shape.localName === 'pic') {
          const blip = firstDescendant(shape, A, 'blip');
          if (!blip) throw pptxError(`模板图片槽位 ${assignment.slot.id} 缺少 a:blip`);
          blip.setAttributeNS(R, 'r:embed', relationshipId);
          for (const crop of elementsNs(shape, A, 'srcRect')) crop.parentNode.removeChild(crop);
        } else {
          const element = {
            x: assignment.slot.left, y: assignment.slot.top, w: assignment.slot.width, h: assignment.slot.height,
            alt: assignment.text,
          };
          replaceShape(document, shape, pictureXml(element, assignment.slot.id, `SmartPPT Image ${assignment.slot.id}`, relationshipId));
        }
      } else if (assignment.kind === 'table') {
        replaceShape(document, shape, tableFrameXml(assignment));
      }
    }
    for (const id of template.clearShapeIds || []) {
      const shape = shapeById(document, id);
      if (shape && !replaceShapeText(document, shape, '', null) && shape.localName === 'graphicFrame') {
        shape.parentNode.removeChild(shape);
      }
    }
    fadeCount += insertSlideMotion(document, pageJob);

    const slideName = `ppt/slides/slide${pageJob.number}.xml`;
    const relationshipId = addRelationship(presentationRels, slideType, `slides/slide${pageJob.number}.xml`);
    const identifier = presentation.createElementNS(P, 'p:sldId');
    identifier.setAttribute('id', String(255 + pageJob.number));
    identifier.setAttributeNS(R, 'r:id', relationshipId);
    slideList.appendChild(identifier);
    entries.push({ name: slideName, data: serializeXml(document) });
    entries.push({ name: `ppt/slides/_rels/slide${pageJob.number}.xml.rels`, data: serializeXml(relationships) });
  }

  entries.push({ name: 'ppt/presentation.xml', data: serializeXml(presentation) });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: serializeXml(presentationRels) });
  entries.push({ name: '[Content_Types].xml', data: updateContentTypes(await archive.text('[Content_Types].xml'), pages) });
  return { bytes: writeZip(entries), fadeCount };
}

/** Render job.pages into the supplied base.pptx shell. */
export async function renderPackage(job, shellBytes) {
  const pages = validateJob(job);
  const shell = await readZip(shellBytes);
  if (!shell.has('[Content_Types].xml')) throw pptxError('base.pptx 缺少 [Content_Types].xml');
  const contentTypes = updateContentTypes(await shell.text('[Content_Types].xml'), pages);
  const entries = [];
  for (const name of shell.names()) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)) continue;
    if (name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || name === '[Content_Types].xml') continue;
    if (/^ppt\/media(?:\/|$)/.test(name)) continue;
    entries.push({ name, data: await shell.bytes(name) });
  }
  entries.push({ name: 'ppt/presentation.xml', data: presentationXml(pages) });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: presentationRelsXml(pages) });
  entries.push({ name: '[Content_Types].xml', data: contentTypes });

  let fadeCount = 0;
  for (const pageJob of pages) {
    const rendered = slideXml(pageJob);
    fadeCount += rendered.fadeCount;
    entries.push({ name: `ppt/slides/slide${pageJob.number}.xml`, data: rendered.xml });
    rendered.pictures.forEach((picture, index) => {
      picture.mediaName = `slide${pageJob.number}-image${index + 1}${picture.extension}`;
      entries.push({ name: `ppt/media/${picture.mediaName}`, data: picture.bytes });
    });
    entries.push({ name: `ppt/slides/_rels/slide${pageJob.number}.xml.rels`, data: slideRelsXml(rendered.pictures) });
  }
  return { bytes: writeZip(entries), fadeCount };
}

function parseXml(source, label) {
  if (typeof DOMParser !== 'function') throw pptxError('当前浏览器不支持 DOMParser，无法回读 PPTX XML');
  if (/<!DOCTYPE/i.test(source)) throw pptxError(`${label}包含不支持的 DOCTYPE`);
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (!document.documentElement || document.documentElement.localName === 'parsererror' || document.getElementsByTagName('parsererror').length) {
    throw pptxError(`${label}不是有效的 XML`);
  }
  return document;
}

function elementsNs(parent, namespace, localName) {
  return Array.from(parent.getElementsByTagNameNS(namespace, localName));
}

function directChild(parent, namespace, localName) {
  if (!parent) return null;
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 1 && child.namespaceURI === namespace && child.localName === localName) return child;
  }
  return null;
}

function firstDescendant(parent, namespace, localName) {
  return parent.getElementsByTagNameNS(namespace, localName)[0] || null;
}

function drawableElements(document, pageNumber) {
  const common = directChild(document.documentElement, P, 'cSld');
  const tree = directChild(common, P, 'spTree');
  if (!tree) throw pptxError(`第 ${pageNumber} 页缺少 p:cSld/p:spTree`);
  return Array.from(tree.childNodes).filter(node => node.nodeType === 1 && node.namespaceURI === P && DRAWABLE_TAGS.has(node.localName));
}

function slideNumber(name) {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  return match ? Number(match[1]) : -1;
}

function verifySlide(document, pageJob) {
  const number = pageJob.number;
  const drawables = drawableElements(document, number);
  const template = pageJob.plan?.template;
  const drawableProperties = [];
  if (!template) {
    if (drawables.length !== pageJob.page.elements.length) {
      throw pptxError(`第 ${number} 页 drawable 数为 ${drawables.length}，预期 ${pageJob.page.elements.length}`);
    }
    drawables.forEach((element, index) => {
      const properties = firstDescendant(element, P, 'cNvPr');
      if (!properties) throw pptxError(`第 ${number} 页第 ${index + 1} 个 drawable 缺少 p:cNvPr`);
      if (properties.getAttribute('id') !== String(index + 2)) throw pptxError(`第 ${number} 页 shape id 与元素顺序不一致`);
      drawableProperties.push(properties);
    });
  } else {
    const expectedIds = [template.title.slot.id, ...template.assignments.map(assignment => assignment.slot.id)];
    for (const id of expectedIds) {
      if (!shapeById(document, id)) throw pptxError(`第 ${number} 页缺少模板内容形状 ${id}`);
    }
  }
  const shapeIds = new Set(elementsNs(document, P, 'cNvPr').map(node => node.getAttribute('id')));
  for (const target of elementsNs(document, P, 'spTgt')) {
    const spid = target.getAttribute('spid');
    if (!spid || !shapeIds.has(spid)) throw pptxError(`第 ${number} 页动画引用了不存在的 shape id“${spid || ''}”`);
  }
  for (const [elementIndex, name] of markerMap(pageJob)) {
    if (drawableProperties[elementIndex].getAttribute('name') !== name) {
      throw pptxError(`第 ${number} 页缺少 Morph marker“${name}”或 marker 未对应原元素`);
    }
  }

  const morphs = elementsNs(document, P159, 'morph');
  const expectedMorphs = number > 1 ? 1 : 0;
  if (morphs.length !== expectedMorphs) throw pptxError(`第 ${number} 页 p159:morph 数量为 ${morphs.length}，预期 ${expectedMorphs}`);
  if (morphs.some(node => node.getAttribute('option') !== 'byObject')) throw pptxError(`第 ${number} 页 Morph 必须使用 byObject`);
  if (elementsNs(document, P14, 'morph').length) throw pptxError(`第 ${number} 页含有不允许的 p14:morph`);
  const fades = elementsNs(document, P, 'fade');
  if (fades.length !== expectedMorphs) throw pptxError(`第 ${number} 页 Fade 切换数量为 ${fades.length}，预期 ${expectedMorphs}`);
  if (fades.some(node => node.getAttribute('thruBlk') !== '0')) throw pptxError(`第 ${number} 页存在黑场 Fade，thruBlk 必须为 0`);

  const actualAnimationIds = elementsNs(document, P, 'animEffect').map(effect => {
    const target = firstDescendant(effect, P, 'spTgt');
    return target ? target.getAttribute('spid') : '';
  });
  const expectedAnimationIds = (template ? templateFadeEntries(pageJob) : fadeEntries(pageJob)).map(entry => entry[0]);
  if (actualAnimationIds.length !== expectedAnimationIds.length || actualAnimationIds.some((id, index) => id !== expectedAnimationIds[index])) {
    throw pptxError(`第 ${number} 页错峰 Fade 动画 spid 与 job.fade 不一致`);
  }
}

/** Re-read and validate a rendered package; throws a Chinese error on failure. */
export async function verifyPackage(pptxBytes, job) {
  const pages = validateJob(job);
  const archive = await readZip(pptxBytes);
  const names = archive.names();
  for (const name of names) await archive.bytes(name);
  const slideNames = names.filter(name => slideNumber(name) >= 0);
  if (slideNames.length !== pages.length) throw pptxError(`PPTX 页数为 ${slideNames.length}，预期 ${pages.length}`);
  const presentation = parseXml(await archive.text('ppt/presentation.xml'), 'presentation.xml');
  const slideLists = elementsNs(presentation, P, 'sldIdLst');
  if (slideLists.length !== 1) throw pptxError(`presentation.xml 的 sldIdLst 数量为 ${slideLists.length}，预期 1`);
  const identifiers = elementsNs(slideLists[0], P, 'sldId');
  if (identifiers.length !== pages.length) throw pptxError(`presentation.xml 的页面引用数为 ${identifiers.length}，预期 ${pages.length}`);
  for (const pageJob of pages) {
    const name = `ppt/slides/slide${pageJob.number}.xml`;
    if (!archive.has(name)) throw pptxError(`PPTX 缺少第 ${pageJob.number} 页：${name}`);
    const document = parseXml(await archive.text(name), `第 ${pageJob.number} 页`);
    verifySlide(document, pageJob);
  }
  return true;
}

/** Match each source block against its assigned slides, or the whole deck without a job. */
export async function auditPackage(pptxBytes, model, job = null) {
  if (!model || !Array.isArray(model.blocks)) throw pptxError('model.blocks 必须是原文块数组');
  const archive = await readZip(pptxBytes);
  const slideNames = archive.names().filter(name => slideNumber(name) >= 0).sort((left, right) => slideNumber(left) - slideNumber(right));
  const slideTexts = [];
  for (const name of slideNames) {
    const document = parseXml(await archive.text(name), name);
    slideTexts.push(clean(elementsNs(document, A, 't').map(node => node.textContent || '').join(' ')));
  }
  const allText = clean(slideTexts.join(' '));
  const expectedPages = new Map();
  for (const page of job?.pages || []) {
    for (const id of page.plan?.source_ids || []) {
      if (!expectedPages.has(id)) expectedPages.set(id, []);
      expectedPages.get(id).push(page.number);
    }
  }
  const missing = [];
  const auditedBlocks = model.blocks.filter(item => item.audit !== false);
  for (const item of auditedBlocks) {
    const value = clean(item.text);
    const assigned = job ? expectedPages.get(item.id) || [] : [];
    const matched = job
      ? assigned.some(number => slideTexts[number - 1]?.includes(value))
      : allText.includes(value);
    if (!matched) missing.push({ id: item.id, text: item.text, source: item.source, expected_pages: assigned });
  }
  return {
    source_blocks: auditedBlocks.length,
    matched_blocks: auditedBlocks.length - missing.length,
    missing_blocks: missing,
    slides: slideNames.length,
    per_page: Boolean(job),
    page_map: Object.fromEntries(expectedPages),
  };
}
