import { parseDocument, makeModel, parseVisualTemplate } from './parser.js';
import { planPages } from './layout.js';
import { renderPackage, renderTemplatePackage, verifyPackage, auditPackage } from './pptx.js';
import { analyzeBlockRoles, applyBlockRoles } from './ai.js';

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
  const { blocks, decorations, notes } = await parseDocument(filename, fileBytes, assets);
  const parseSeconds = elapsed(parseStarted);

  let ai = null;
  let aiSeconds = null;
  if (useAI) {
    const aiStarted = performance.now();
    try {
      const analysis = await analyzeBlockRoles(blocks);
      const changed = applyBlockRoles(blocks, analysis.roles);
      ai = { requested: true, applied: true, changed, model: analysis.model, warning: '' };
    } catch (error) {
      ai = {
        requested: true, applied: false, changed: 0, model: null,
        warning: `${error?.message || error}；已回退到本地规则`,
      };
    }
    aiSeconds = elapsed(aiStarted);
  }

  const model = makeModel(filename, blocks, decorations, notes);
  model.style = style;
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
      plan_seconds: planSeconds,
      plan_json_write_seconds: planJsonWriteSeconds,
      write_seconds: writeSeconds,
      verify_seconds: verifySeconds,
      audit_seconds: auditSeconds,
      plan_total_seconds: parseSeconds + (templateSeconds || 0) + (aiSeconds || 0) + planSeconds + planJsonWriteSeconds,
      render_total_seconds: writeSeconds + verifySeconds,
      total_seconds: parseSeconds + (templateSeconds || 0) + (aiSeconds || 0) + planSeconds + planJsonWriteSeconds + writeSeconds + verifySeconds + auditSeconds,
    },
    downloadName: `${baseName}-智能美化.pptx`,
    morphCount: Math.max(0, pages.length - 1),
    fadeCount,
  };
  return { result, pptxBytes: bytes };
}
