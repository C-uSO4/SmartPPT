import { parseDocument, makeModel, parseVisualTemplate, partitionBlockRoles, createImageAsset } from './parser.js';
import { planPages } from './layout.js';
import { renderPackage, renderTemplatePackage, verifyPackage, auditPackage } from './pptx.js';
import { analyzeBlockRoles, applyBlockRoles, generateImage } from './ai.js';

const elapsed = started => (performance.now() - started) / 1000;
let shellPromise;

function shellBytes() {
  if (!shellPromise) {
    shellPromise = fetch(new URL('../assets/base.pptx', import.meta.url)).then(async response => {
      if (!response.ok) throw new Error('PPTX 基础资源加载失败，请刷新页面后重试。');
      return new Uint8Array(await response.arrayBuffer());
    }).catch(error => {
      shellPromise = null;
      throw error;
    });
  }
  return shellPromise;
}

function base64(bytes) {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(value);
}

function previewPages(pages) {
  return pages.map(item => ({
    number: item.number,
    title: item.plan.title,
    layout: item.plan.layout,
    page: {
      ...item.page,
      elements: item.page.elements.map(element => {
        if (element.type !== 'image') return element;
        const { asset, ...preview } = element;
        if (asset.previewable === false || asset.extension === '.emf') {
          return { ...preview, src: '', previewUnsupported: true, previewFormat: 'EMF' };
        }
        const extension = asset.extension === '.png' || asset.name.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
        return { ...preview, src: `data:image/${extension};base64,${base64(asset.bytes)}` };
      }),
    },
  }));
}

function publicBlocks(blocks) {
  return blocks.map(item => {
    const { asset, ...block } = item;
    return block;
  });
}

function decodeImage(value) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('AI 配图数据格式不正确');
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function imagePromptAnchors(roleBlocks) {
  const anchors = new Map();
  let anchor = null;
  for (const item of roleBlocks) {
    if (item.kind === 'image_prompt') anchors.set(item.id, anchor);
    else if (!['note', 'instruction'].includes(item.kind)) anchor = item.id;
  }
  return anchors;
}

function insertGeneratedImage(model, prompt, anchor, asset) {
  const item = {
    id: `generated-${prompt.id}`, kind: 'image', text: 'AI 生成示意图', level: 0,
    source: prompt.source, numbers: [], asset, audit: false, generated: true,
  };
  if (!anchor) {
    model.lead.push(item);
    return;
  }
  const leadIndex = model.lead.findIndex(candidate => candidate.id === anchor);
  if (leadIndex >= 0 || model.title_id === anchor) {
    model.lead.splice(leadIndex + 1, 0, item);
    return;
  }
  for (const section of model.sections) {
    if (section.heading_id === anchor) {
      section.items.unshift(item);
      return;
    }
    const itemIndex = section.items.findIndex(candidate => candidate.id === anchor);
    if (itemIndex >= 0) {
      section.items.splice(itemIndex + 1, 0, item);
      return;
    }
  }
  model.lead.push(item);
}

export async function generateDeck({
  filename, fileBytes, assets = [], style = 'paper', templateBytes = null, templateName = '', useAI = false,
}, onProgress = () => {}) {
  onProgress('parsing');
  let visualTemplate = null;
  let templateSeconds = null;
  if (templateBytes) {
    const templateStarted = performance.now();
    try {
      visualTemplate = await parseVisualTemplate(templateBytes);
    } catch (error) {
      throw new Error(`模板读取失败：${error?.message || error}`);
    }
    templateSeconds = elapsed(templateStarted);
  }

  const parseStarted = performance.now();
  const parsed = await parseDocument(filename, fileBytes, assets);
  const { decorations, roleBlocks } = parsed;
  let { blocks, notes, instructions, imagePrompts } = parsed;
  const parseSeconds = elapsed(parseStarted);

  let ai = null;
  let aiSeconds = null;
  const localRoles = roleBlocks.map(item => ({ item, kind: item.kind, level: item.level }));
  if (useAI) {
    const aiStarted = performance.now();
    try {
      const analysis = await analyzeBlockRoles(roleBlocks);
      const changed = applyBlockRoles(roleBlocks, analysis.roles);
      ({ blocks, notes, instructions, imagePrompts } = partitionBlockRoles(roleBlocks));
      if (!blocks.length) throw new Error('AI 分类后没有可识别的页面正文');
      ai = { requested: true, applied: true, changed, model: analysis.model, warning: '' };
    } catch (error) {
      ai = {
        requested: true, applied: false, changed: 0, model: null,
        warning: `${error?.message || error}；已回退到本地规则`,
      };
      for (const role of localRoles) {
        role.item.kind = role.kind;
        role.item.level = role.level;
      }
      ({ blocks, notes, instructions, imagePrompts } = partitionBlockRoles(roleBlocks));
    }
    aiSeconds = elapsed(aiStarted);
  }

  const model = makeModel(filename, blocks, decorations, notes, instructions, imagePrompts);
  model.style = style;
  const images = { requested: imagePrompts.length, generated: 0, failed: 0, models: [], warnings: [] };
  let imageSeconds = null;
  if (imagePrompts.length && !useAI) {
    images.warnings.push(`检测到 ${imagePrompts.length} 条配图需求；开启 AI 后才会发送到图片模型。`);
  }
  if (useAI && imagePrompts.length) {
    const imageStarted = performance.now();
    const anchors = imagePromptAnchors(roleBlocks);
    const generated = [];
    for (const [index, prompt] of imagePrompts.slice(0, 4).entries()) {
      try {
        const response = await generateImage(prompt.text);
        const asset = createImageAsset(`ai-generated-${index + 1}.jpg`, decodeImage(response.image));
        generated.push({ prompt, anchor: anchors.get(prompt.id) || null, asset });
        if (response.model && !images.models.includes(response.model)) images.models.push(response.model);
      } catch (error) {
        images.failed += 1;
        images.warnings.push(`第 ${index + 1} 条配图未生成：${error?.message || error}`);
      }
    }
    if (imagePrompts.length > 4) {
      images.failed += imagePrompts.length - 4;
      images.warnings.push('单次最多生成 4 张 AI 配图，其余需求未发送。');
    }
    generated.reverse().forEach(item => insertGeneratedImage(model, item.prompt, item.anchor, item.asset));
    images.generated = generated.length;
    imageSeconds = elapsed(imageStarted);
  }
  const planStarted = performance.now();
  const pages = planPages(model, style, visualTemplate);
  const planSeconds = elapsed(planStarted);
  const job = { source: filename, page_count: pages.length, pages };

  const jsonStarted = performance.now();
  JSON.stringify({ model, job }, (key, value) => key === 'bytes' && value instanceof Uint8Array ? value.byteLength : value);
  const planJsonWriteSeconds = elapsed(jsonStarted);

  onProgress('rendering');
  const shell = visualTemplate ? null : await shellBytes();
  const writeStarted = performance.now();
  const { bytes, fadeCount } = visualTemplate
    ? await renderTemplatePackage(job, templateBytes)
    : await renderPackage(job, shell);
  const writeSeconds = elapsed(writeStarted);

  onProgress('auditing');
  const verifyStarted = performance.now();
  await verifyPackage(bytes, job);
  const verifySeconds = elapsed(verifyStarted);
  const auditStarted = performance.now();
  const fidelity = await auditPackage(bytes, model, job);
  const auditSeconds = elapsed(auditStarted);
  fidelity.seconds = auditSeconds;

  const baseName = filename.replace(/\.[^.]+$/, '') || '智能美化';
  const result = {
    title: model.title,
    format: model.source.format,
    style,
    ai,
    template: visualTemplate ? {
      applied: true,
      name: templateName || '模板.pptx',
      titleFont: visualTemplate.fonts.title,
      bodyFont: visualTemplate.fonts.body,
      coverBackground: visualTemplate.cover.image ? 'image' : 'color',
      contentBackground: visualTemplate.content.image ? 'image' : 'color',
      layoutCount: visualTemplate.candidates.length,
      usedLayoutCount: new Set(pages.map(page => page.plan.template.slidePart)).size,
      warnings: visualTemplate.warnings,
      limitations: '下载稿保留所选模板页的母版、版式、装饰与媒体；网页预览同步显示这些装饰及 PNG/JPEG 图片，复杂效果、裁剪和旋转仍以 WPS 中的下载稿为准。模板原始动画会替换为当前切换与入场效果，不生成可复用母版。',
    } : null,
    noteCount: notes.length,
    instructionCount: instructions.length,
    imagePromptCount: imagePrompts.length,
    images,
    pageCount: pages.length,
    blockCount: blocks.length,
    decorationCount: decorations.length,
    pages: previewPages(pages),
    blocks: publicBlocks(blocks),
    fidelity,
    timings: {
      parse_seconds: parseSeconds,
      template_parse_seconds: templateSeconds,
      ai_seconds: aiSeconds,
      image_seconds: imageSeconds,
      plan_seconds: planSeconds,
      plan_json_write_seconds: planJsonWriteSeconds,
      write_seconds: writeSeconds,
      verify_seconds: verifySeconds,
      audit_seconds: auditSeconds,
      plan_total_seconds: parseSeconds + (templateSeconds || 0) + (aiSeconds || 0) + (imageSeconds || 0) + planSeconds + planJsonWriteSeconds,
      render_total_seconds: writeSeconds + verifySeconds,
      total_seconds: parseSeconds + (templateSeconds || 0) + (aiSeconds || 0) + (imageSeconds || 0) + planSeconds + planJsonWriteSeconds + writeSeconds + verifySeconds + auditSeconds,
    },
    downloadName: `${baseName}-智能美化.pptx`,
    morphCount: Math.max(0, pages.length - 1),
    fadeCount,
  };
  return { result, pptxBytes: bytes };
}
