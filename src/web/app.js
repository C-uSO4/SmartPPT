import { generateDeck } from './engine/engine.js';

const $ = id => document.getElementById(id);
const allowedExtensions = new Set(['docx', 'md', 'markdown', 'txt', 'pptx']);
const maxFileSize = 25 * 1024 * 1024;
const stageOrder = ['parsing', 'rendering', 'auditing'];
let selectedFile = null;
let selectedAssets = [];
let busy = false;
let currentResult = null;
let currentPage = 0;
let downloadUrl = null;

function showOnly(id) {
  ['emptyState', 'resultState', 'errorState'].forEach(name => $(name).classList.toggle('hidden', name !== id));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name) {
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

function setFile(file) {
  if (busy) return;
  const extension = extensionOf(file.name);
  if (!allowedExtensions.has(extension)) {
    showError('请选择 DOCX、MD、Markdown、TXT 或 PPTX 文件。');
    return;
  }
  if (!file.size || file.size > maxFileSize) {
    showError('文件不能为空，且不能超过 25 MB。');
    return;
  }
  selectedFile = file;
  $('dropzone').classList.add('hidden');
  $('fileCard').classList.remove('hidden');
  $('fileType').textContent = extension === 'markdown' ? 'MD' : extension.toUpperCase();
  $('fileName').textContent = file.name;
  $('fileName').title = file.name;
  $('fileSize').textContent = formatBytes(file.size);
  $('generateButton').disabled = false;
  $('errorState').classList.add('hidden');
  if (!currentResult) showOnly('emptyState');
}

function clearFile() {
  if (busy) return;
  selectedFile = null;
  selectedAssets = [];
  $('fileInput').value = '';
  $('assetInput').value = '';
  $('assetNames').textContent = 'Markdown 中按文件名引用 PNG/JPEG';
  $('fileCard').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  $('generateButton').disabled = true;
}

function showError(message) {
  showOnly('errorState');
  $('errorMessage').textContent = message;
  $('pipeline').classList.add('hidden');
  busy = false;
  $('generateButton').classList.remove('busy');
  $('generateButton').querySelector('span').textContent = '生成智能美化 PPT';
  $('generateButton').disabled = !selectedFile;
  $('removeFile').disabled = false;
  $('assetInput').disabled = false;
}

function setPipeline(stage) {
  $('pipeline').classList.remove('hidden');
  const activeIndex = stageOrder.indexOf(stage);
  document.querySelectorAll('#pipeline li').forEach((item, index) => {
    item.classList.toggle('done', stage === 'complete' || index < activeIndex);
    item.classList.toggle('active', index === activeIndex);
  });
}

function finishGeneration() {
  busy = false;
  $('generateButton').classList.remove('busy');
  $('generateButton').querySelector('span').textContent = selectedFile ? '重新生成 PPT' : '生成智能美化 PPT';
  $('generateButton').disabled = !selectedFile;
  $('removeFile').disabled = false;
  $('assetInput').disabled = false;
}

function friendlyError(error) {
  const message = String(error?.message || error || '生成失败');
  if (/无法连接|Failed to fetch|NetworkError/i.test(message)) {
    return '生成资源加载失败，请检查网络并刷新页面后重试。文件不会上传到服务器。';
  }
  if (/DecompressionStream|deflate-raw/i.test(message)) {
    return '当前浏览器不支持 Office 文件解压，请使用最新版 Chrome、Edge 或 Safari。';
  }
  if (/XML|parsererror|not well-formed|mismatched tag/i.test(message)) {
    return 'Office 文件内部结构无法读取，请在 WPS 中另存为新的 DOCX/PPTX 后重试。';
  }
  return message;
}

async function generate() {
  if (!selectedFile || busy) return;
  if (typeof DOMParser === 'undefined' || typeof DecompressionStream === 'undefined') {
    showError('当前浏览器缺少在线生成所需能力，请使用最新版 Chrome、Edge 或 Safari。');
    return;
  }
  try { new DecompressionStream('deflate-raw'); }
  catch {
    showError('当前浏览器不支持 Office 文件解压，请使用最新版 Chrome、Edge 或 Safari。');
    return;
  }
  busy = true;
  currentResult = null;
  currentPage = 0;
  showOnly('emptyState');
  setPipeline('parsing');
  $('generateButton').disabled = true;
  $('generateButton').classList.add('busy');
  $('generateButton').querySelector('span').textContent = '正在浏览器内生成…';
  $('removeFile').disabled = true;
  $('assetInput').disabled = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
    const assets = await Promise.all(selectedAssets.map(async file => ({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    const { result, pptxBytes } = await generateDeck({
      filename: selectedFile.name, fileBytes, assets, style: $('styleSelect').value,
    }, setPipeline);
    if (!result.fidelity || result.fidelity.missing_blocks.length) {
      throw new Error('原文回读存在遗漏，已阻止交付。请检查来源内容或重新导出文件。');
    }
    finishGeneration();
    renderResult(result, pptxBytes);
  } catch (error) {
    showError(friendlyError(error));
  }
}

function color(value, fallback = 'transparent') {
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value || '') ? value : fallback;
}

function placeElement(node, element) {
  node.classList.add('slide-element');
  Object.assign(node.style, {
    left: `${element.x}px`, top: `${element.y}px`,
    width: `${element.w}px`, height: `${element.h}px`,
  });
}

function renderShape(element) {
  const node = document.createElement('div');
  placeElement(node, element);
  const fill = color(element.fill);
  if (element.shape === 'line') {
    node.style.background = 'transparent';
    const vertical = element.h > element.w;
    node.style[vertical ? 'borderLeft' : 'borderTop'] = `${element.stroke?.widthPt || 1}px solid ${color(element.stroke?.color, '#d5deda')}`;
  } else if (element.shape === 'donut') {
    node.style.borderRadius = '50%';
    node.style.background = `radial-gradient(circle, transparent 0 43%, ${fill} 44% 100%)`;
  } else {
    node.style.background = fill;
    if (element.shape === 'ellipse') node.style.borderRadius = '50%';
    if (element.shape === 'roundRect') node.style.borderRadius = '16px';
    if (element.stroke) {
      node.style.border = `${element.stroke.widthPt || 1}px solid ${color(element.stroke.color)}`;
    }
  }
  return node;
}

function renderImage(element) {
  const node = document.createElement('img');
  placeElement(node, element);
  node.src = element.src || '';
  node.alt = element.alt || '';
  node.style.objectFit = 'contain';
  return node;
}

function renderText(element) {
  const node = document.createElement('div');
  placeElement(node, element);
  node.classList.add('slide-text');
  node.style.display = 'flex';
  node.style.flexDirection = 'column';
  node.style.overflow = 'hidden';
  node.style.justifyContent = element.valign === 'mid' ? 'center' : element.valign === 'bottom' ? 'flex-end' : 'flex-start';
  for (const paragraph of element.paragraphs || []) {
    const p = document.createElement('p');
    p.style.textAlign = paragraph.align || 'left';
    p.style.lineHeight = String((paragraph.lineSpacingPct || 110) / 100);
    p.style.marginBottom = `${paragraph.spaceAfterPt || 0}px`;
    p.style.width = '100%';
    if (paragraph.bullet) p.style.paddingLeft = '1em';
    for (const run of paragraph.runs || []) {
      const span = document.createElement('span');
      span.textContent = run.text || '';
      span.style.fontSize = `${(run.sizePt || 16) * 96 / 72}px`;
      span.style.fontWeight = run.bold ? '700' : '400';
      span.style.fontStyle = run.italic ? 'italic' : 'normal';
      span.style.color = color(run.color, '#153b3c');
      span.style.fontFamily = '"Microsoft YaHei", "PingFang SC", Arial, sans-serif';
      p.appendChild(span);
    }
    node.appendChild(p);
  }
  return node;
}

function renderSlide(index) {
  if (!currentResult) return;
  currentPage = Math.max(0, Math.min(index, currentResult.pages.length - 1));
  const item = currentResult.pages[currentPage];
  const canvas = $('slideCanvas');
  canvas.replaceChildren();
  canvas.style.background = color(item.page.background, '#f3f1eb');
  for (const element of item.page.elements || []) {
    if (element.type === 'shape') canvas.appendChild(renderShape(element));
    if (element.type === 'text') canvas.appendChild(renderText(element));
    if (element.type === 'image') canvas.appendChild(renderImage(element));
  }
  document.querySelectorAll('.thumb').forEach((button, buttonIndex) => {
    button.classList.toggle('active', buttonIndex === currentPage);
    button.setAttribute('aria-current', buttonIndex === currentPage ? 'page' : 'false');
  });
  $('slideCaption').textContent = `${String(item.number).padStart(2, '0')} / ${String(currentResult.pageCount).padStart(2, '0')} · ${item.layout.toUpperCase()} · ${item.title}`;
  resizeSlide();
}

function resizeSlide() {
  const scale = $('slideFrame').clientWidth / 1280;
  $('slideCanvas').style.transform = `scale(${scale})`;
}

function sourceLabel(block) {
  const source = block.source || {};
  if (source.slide) return `PPT 第 ${source.slide} 页`;
  if (source.paragraph) return `Word 第 ${source.paragraph} 段`;
  if (source.line) return `第 ${source.line} 行`;
  return '来源内容';
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '未测量';
  const value = Number(seconds);
  if (value > 0 && value < 0.001) return '<1 ms';
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
}

function renderResult(result, pptxBytes) {
  currentResult = result;
  showOnly('resultState');
  setPipeline('complete');
  $('deckTitle').textContent = result.title;
  $('deckMeta').textContent = `${result.format.toUpperCase()} 入口 · ${result.blockCount} 条原文 · 原生可编辑对象`;
  const ratio = result.fidelity.source_blocks ? result.fidelity.matched_blocks / result.fidelity.source_blocks : 0;
  $('metricFidelity').textContent = `${Math.round(ratio * 100)}%`;
  $('metricPages').textContent = result.pageCount;
  $('metricTime').textContent = formatDuration(result.timings.total_seconds);
  $('metricMotion').textContent = `${result.morphCount} 处`;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([pptxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }));
  $('downloadButton').href = downloadUrl;
  $('downloadButton').download = result.downloadName;

  const thumbnails = $('thumbnails');
  thumbnails.replaceChildren();
  result.pages.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    const number = document.createElement('b');
    number.textContent = String(item.number).padStart(2, '0');
    const title = document.createElement('span');
    title.textContent = item.title;
    const line = document.createElement('i');
    button.append(number, title, line);
    button.addEventListener('click', () => renderSlide(index));
    thumbnails.appendChild(button);
  });
  renderSlide(0);

  const missing = new Set((result.fidelity.missing_blocks || []).map(item => item.id));
  $('auditSummary').textContent = `${result.fidelity.matched_blocks} / ${result.fidelity.source_blocks} 条原文已在 PPTX 中回读匹配`;
  $('decorationSummary').textContent = `另识别 ${result.decorationCount} 条重复页眉、页码等装饰，不参与正文对账`;
  const rows = $('auditRows');
  rows.replaceChildren();
  result.blocks.forEach(block => {
    const row = document.createElement('tr');
    [sourceLabel(block), block.text, (block.numbers || []).join('、') || '—', missing.has(block.id) ? '缺失' : '已匹配'].forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    rows.appendChild(row);
  });

  const timings = [
    ['内容解析', result.timings.parse_seconds],
    ['页面规划', result.timings.plan_seconds],
    ['计划 JSON 写出', result.timings.plan_json_write_seconds],
    ['PPTX 原生写入', result.timings.write_seconds],
    ['结构回读', result.timings.verify_seconds],
    ['原文保真审计', result.timings.audit_seconds],
  ];
  const measured = timings.map(item => Number(item[1])).filter(Number.isFinite);
  const maximum = Math.max(...measured, 0.001);
  const bars = $('timingBars');
  bars.replaceChildren();
  timings.forEach(([label, seconds]) => {
    const row = document.createElement('div');
    row.className = 'timing-row';
    const name = document.createElement('span');
    name.textContent = label;
    const track = document.createElement('div');
    track.className = 'timing-track';
    const fill = document.createElement('div');
    fill.className = 'timing-fill';
    fill.style.width = Number.isFinite(Number(seconds)) ? `${Math.max(2, Number(seconds) / maximum * 100)}%` : '0';
    track.appendChild(fill);
    const value = document.createElement('strong');
    value.textContent = formatDuration(seconds);
    row.append(name, track, value);
    bars.appendChild(row);
  });
  selectTab('preview');
}

function selectTab(name) {
  document.querySelectorAll('.tab').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  ['preview', 'audit', 'timing'].forEach(tab => $(`${tab}Tab`).classList.toggle('hidden', tab !== name));
  if (name === 'preview') requestAnimationFrame(resizeSlide);
}

$('dropzone').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('fileInput').click();
  }
});
$('fileInput').addEventListener('change', event => {
  if (event.target.files[0]) setFile(event.target.files[0]);
});
['dragenter', 'dragover'].forEach(type => $('dropzone').addEventListener(type, event => {
  event.preventDefault();
  if (!busy) $('dropzone').classList.add('dragging');
}));
['dragleave', 'drop'].forEach(type => $('dropzone').addEventListener(type, event => {
  event.preventDefault();
  $('dropzone').classList.remove('dragging');
}));
$('dropzone').addEventListener('drop', event => {
  if (event.dataTransfer.files[0]) setFile(event.dataTransfer.files[0]);
});
$('assetInput').addEventListener('change', event => {
  const files = Array.from(event.target.files || []);
  const valid = files.length <= 12 && files.every(file => /\.(png|jpe?g)$/i.test(file.name) && file.size > 0 && file.size <= 8 * 1024 * 1024);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!valid || total > 20 * 1024 * 1024) {
    event.target.value = '';
    selectedAssets = [];
    $('assetNames').textContent = '请选择最多 12 张 PNG/JPEG，单张 ≤8 MB，合计 ≤20 MB';
    return;
  }
  selectedAssets = files;
  $('assetNames').textContent = files.length ? files.map(file => file.name).join('、') : 'Markdown 中按文件名引用 PNG/JPEG';
});
$('removeFile').addEventListener('click', clearFile);
$('sampleButton').addEventListener('click', async () => {
  if (busy) return;
  $('sampleButton').disabled = true;
  try {
    const response = await fetch('./examples/outline.md');
    if (!response.ok) throw new Error('示例大纲加载失败，请刷新页面后重试。');
    const bytes = await response.arrayBuffer();
    setFile(new File([bytes], 'outline.md', { type: 'text/markdown' }));
  } catch (error) {
    const message = /Failed to fetch|NetworkError/i.test(String(error?.message || error))
      ? '示例大纲加载失败，请检查网络并刷新页面后重试。'
      : (error.message || '示例大纲加载失败，请检查网络后重试。');
    showError(message);
  } finally {
    $('sampleButton').disabled = false;
  }
});
$('generateButton').addEventListener('click', generate);
$('retryButton').addEventListener('click', () => {
  if (currentResult) showOnly('resultState');
  else showOnly('emptyState');
  document.querySelector('.control-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)));
window.addEventListener('resize', resizeSlide);
if ('ResizeObserver' in window) new ResizeObserver(resizeSlide).observe($('slideFrame'));

window.addEventListener('beforeunload', () => {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
