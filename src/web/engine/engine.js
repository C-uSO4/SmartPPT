import { parseDocument, makeModel } from './parser.js';
import { planPages } from './layout.js';
import { renderPackage, verifyPackage, auditPackage } from './pptx.js';

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
        const extension = asset.name.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
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

export async function generateDeck({ filename, fileBytes, assets = [], style = 'paper' }, onProgress = () => {}) {
  onProgress('parsing');
  const parseStarted = performance.now();
  const { blocks, decorations, notes } = await parseDocument(filename, fileBytes, assets);
  const model = makeModel(filename, blocks, decorations, notes);
  model.style = style;
  const parseSeconds = elapsed(parseStarted);

  const planStarted = performance.now();
  const pages = planPages(model, style);
  const planSeconds = elapsed(planStarted);
  const job = { source: filename, page_count: pages.length, pages };

  const jsonStarted = performance.now();
  JSON.stringify({ model, job });
  const planJsonWriteSeconds = elapsed(jsonStarted);

  onProgress('rendering');
  const shell = await shellBytes();
  const writeStarted = performance.now();
  const { bytes, fadeCount } = await renderPackage(job, shell);
  const writeSeconds = elapsed(writeStarted);

  onProgress('auditing');
  const verifyStarted = performance.now();
  await verifyPackage(bytes, job);
  const verifySeconds = elapsed(verifyStarted);
  const auditStarted = performance.now();
  const fidelity = await auditPackage(bytes, model);
  const auditSeconds = elapsed(auditStarted);
  fidelity.seconds = auditSeconds;

  const baseName = filename.replace(/\.[^.]+$/, '') || '智能美化';
  const result = {
    title: model.title,
    format: model.source.format,
    style,
    noteCount: notes.length,
    pageCount: pages.length,
    blockCount: blocks.length,
    decorationCount: decorations.length,
    pages: previewPages(pages),
    blocks: publicBlocks(blocks),
    fidelity,
    timings: {
      parse_seconds: parseSeconds,
      plan_seconds: planSeconds,
      plan_json_write_seconds: planJsonWriteSeconds,
      write_seconds: writeSeconds,
      verify_seconds: verifySeconds,
      audit_seconds: auditSeconds,
      plan_total_seconds: parseSeconds + planSeconds + planJsonWriteSeconds,
      render_total_seconds: writeSeconds + verifySeconds,
      total_seconds: parseSeconds + planSeconds + planJsonWriteSeconds + writeSeconds + verifySeconds + auditSeconds,
    },
    downloadName: `${baseName}-智能美化.pptx`,
    morphCount: Math.max(0, pages.length - 1),
    fadeCount,
  };
  return { result, pptxBytes: bytes };
}
