const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const runtime = process.env.RUNTIME_DIR ? path.resolve(process.env.RUNTIME_DIR) : path.join(root, 'web-runtime');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const jobs = new Map();
const allowed = new Set(['.docx', '.md', '.markdown', '.txt', '.pptx']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
fs.mkdirSync(runtime, { recursive: true });

function send(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 70 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          const error = new Error('上传内容编码后超过 70 MB，请减少图片或拆分文件。');
          error.status = 413;
          reject(error);
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求格式不正确')); }
    });
    req.on('error', reject);
  });
}

function writeStatus(job) {
  const temp = path.join(job.dir, 'status.tmp');
  fs.writeFileSync(temp, JSON.stringify(job.public, null, 2));
  fs.renameSync(temp, path.join(job.dir, 'status.json'));
}

function setStage(job, stage, extra = {}) {
  job.public = { ...job.public, ...extra, stage, updatedAt: new Date().toISOString() };
  jobs.set(job.id, job.public);
  writeStatus(job);
}

function recoverInterruptedJobs() {
  for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = path.join(runtime, entry.name);
    try {
      const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
      if (['complete', 'error'].includes(status.stage)) continue;
      const publicStatus = {
        ...status,
        stage: 'error',
        error: '本地服务在生成过程中重启，本次任务已中断。请重新生成，不要继续等待旧任务。',
        updatedAt: new Date().toISOString(),
      };
      const job = { id: entry.name, dir, public: publicStatus };
      jobs.set(entry.name, publicStatus);
      writeStatus(job);
    } catch {}
  }
}

recoverInterruptedJobs();

function runPython(args, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const command = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    const commandArgs = process.env.PYTHON ? args : (process.platform === 'win32' ? ['-3', ...args] : args);
    const child = spawn(command, commandArgs, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('单个生成阶段超过 120 秒，已停止任务。请拆分超大文件或检查 PPT 是否异常复杂。'));
    }, timeoutMs);
    child.stdout.on('data', data => { stdout += data.toString('utf8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('找不到电脑已有的 Python 解释器，请设置 PYTHON 环境变量'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `生成程序退出，代码 ${code}`));
    });
  });
}

function friendlyError(error) {
  const message = String(error.message || '');
  if (/BadZipFile|File is not a zip file/i.test(message)) {
    return '文件已损坏或不是有效的 DOCX/PPTX，请重新导出后再上传。';
  }
  if (/单个生成阶段超过|找不到电脑已有的 Python/.test(message)) return message;
  if (/ParseError|no element found|mismatched tag|not well-formed/i.test(message)) {
    return 'Office 文件内部结构无法读取，请在 WPS 中另存为新的 DOCX/PPTX 后重试。';
  }
  const valueError = message.match(/ValueError: ([^\r\n]+)/);
  if (valueError) return valueError[1];
  return '生成失败，请检查文件内容；若是 Office 文件，请重新导出后再试。';
}

function previewPage(page) {
  return {
    ...page,
    elements: page.elements.map(element => {
      if (element.type !== 'image') return element;
      const extension = path.extname(element.path).toLowerCase();
      const type = extension === '.png' ? 'image/png' : 'image/jpeg';
      return { ...element, src: `data:${type};base64,${fs.readFileSync(element.path).toString('base64')}` };
    }),
  };
}

async function runJob(job, inputPath, originalName, style) {
  const script = path.join(root, 'src', 'smart_ppt.py');
  const jobFile = path.join(job.dir, 'job.json');
  const output = path.join(job.dir, '智能美化结果.pptx');
  const heartbeat = setInterval(() => {
    if (!['complete', 'error'].includes(job.public.stage)) {
      try { setStage(job, job.public.stage); } catch {}
    }
  }, 5000);
  heartbeat.unref();
  try {
    setStage(job, 'parsing');
    await runPython([script, 'plan', inputPath, '--out', job.dir, '--style', style], root);
    setStage(job, 'rendering');
    await runPython([script, 'render', jobFile, '--output', output], root);
    setStage(job, 'auditing');
    await runPython([script, 'audit', jobFile, output], root);
    const content = JSON.parse(fs.readFileSync(path.join(job.dir, 'content.json'), 'utf8'));
    const plan = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    const parseTiming = JSON.parse(fs.readFileSync(path.join(job.dir, 'timings.json'), 'utf8'));
    const renderTiming = JSON.parse(fs.readFileSync(path.join(job.dir, 'render-timings.json'), 'utf8'));
    const fidelity = JSON.parse(fs.readFileSync(path.join(job.dir, 'fidelity-audit.json'), 'utf8'));
    const baseName = path.basename(originalName, path.extname(originalName));
    const result = {
      title: content.title,
      format: content.source.format,
      style: content.style || 'paper',
      noteCount: (content.notes || []).length,
      pageCount: plan.page_count,
      blockCount: content.blocks.length,
      decorationCount: content.decorations.length,
      pages: plan.pages.map(page => ({ number: page.number, title: page.plan.title, layout: page.plan.layout, page: previewPage(page.page) })),
      blocks: content.blocks,
      fidelity,
      timings: {
        parse_seconds: parseTiming.stages.parse_seconds,
        plan_seconds: parseTiming.stages.plan_seconds,
        plan_json_write_seconds: parseTiming.stages.write_seconds,
        write_seconds: renderTiming.write_seconds,
        verify_seconds: renderTiming.verify_seconds,
        audit_seconds: fidelity.seconds,
        plan_total_seconds: parseTiming.stages.total_seconds,
        render_total_seconds: renderTiming.total_seconds,
        total_seconds: parseTiming.stages.total_seconds + renderTiming.total_seconds + fidelity.seconds,
      },
      downloadName: `${baseName}-智能美化.pptx`,
      morphCount: renderTiming.morph_count,
      fadeCount: renderTiming.fade_count,
    };
    setStage(job, 'complete', { result });
  } catch (error) {
    let fidelity = null;
    try { fidelity = JSON.parse(fs.readFileSync(path.join(job.dir, 'fidelity-audit.json'), 'utf8')); } catch {}
    setStage(job, 'error', { error: friendlyError(error), fidelity });
  } finally {
    clearInterval(heartbeat);
    try { fs.unlinkSync(inputPath); } catch {}
  }
}

function jobFromUrl(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const dir = path.join(runtime, id);
  if (!fs.existsSync(dir)) return null;
  return { id, dir, public: jobs.get(id) || JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')) };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    send(res, 200, { ok: true, engine: 'local-stdlib', dependencies: 0 });
    return;
  }
  if (url.pathname === '/api/sample' && req.method === 'GET') {
    const file = path.join(root, 'examples', 'outline.md');
    send(res, 200, { filename: path.basename(file), content: fs.readFileSync(file).toString('base64') });
    return;
  }
  if (url.pathname === '/api/generate' && req.method === 'POST') {
    const body = await readJson(req);
    const originalName = path.basename(String(body.filename || ''));
    const extension = path.extname(originalName).toLowerCase();
    if (!allowed.has(extension)) {
      send(res, 400, { error: '请选择 DOCX、MD、TXT 或 PPTX 文件' });
      return;
    }
    if (typeof body.content !== 'string') {
      send(res, 400, { error: '文件内容为空' });
      return;
    }
    const data = Buffer.from(body.content, 'base64');
    if (!data.length || data.length > 25 * 1024 * 1024) {
      send(res, 400, { error: '文件不能为空，且不能超过 25 MB' });
      return;
    }
    const style = ['paper', 'midnight', 'azure'].includes(body.style) ? body.style : 'paper';
    const assets = Array.isArray(body.assets) ? body.assets : [];
    if (assets.length > 12) {
      send(res, 400, { error: '每次最多上传 12 张图片素材' });
      return;
    }
    const assetFiles = [];
    let assetBytes = 0;
    for (const asset of assets) {
      const filename = path.basename(String(asset.filename || ''));
      const assetExtension = path.extname(filename).toLowerCase();
      const content = typeof asset.content === 'string' ? Buffer.from(asset.content, 'base64') : Buffer.alloc(0);
      assetBytes += content.length;
      if (!['.png', '.jpg', '.jpeg'].includes(assetExtension) || !content.length || content.length > 8 * 1024 * 1024) {
        send(res, 400, { error: '图片素材须为非空 PNG/JPEG，单张不能超过 8 MB' });
        return;
      }
      if (assetFiles.some(item => item.filename === filename)) {
        send(res, 400, { error: `图片素材重名：${filename}` });
        return;
      }
      assetFiles.push({ filename, content });
    }
    if (assetBytes > 20 * 1024 * 1024) {
      send(res, 400, { error: '图片素材合计不能超过 20 MB' });
      return;
    }
    const id = crypto.randomUUID();
    const dir = path.join(runtime, id);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const inputPath = path.join(dir, `input${extension}`);
    fs.writeFileSync(inputPath, data);
    for (const asset of assetFiles) fs.writeFileSync(path.join(dir, asset.filename), asset.content);
    const now = new Date().toISOString();
    const job = { id, dir, public: { id, stage: 'uploaded', filename: safeName, createdAt: now, updatedAt: now } };
    jobs.set(id, job.public);
    writeStatus(job);
    runJob(job, inputPath, safeName, style).catch(error => {
      console.error(`任务 ${id} 状态写入失败：${error.message}`);
    });
    send(res, 202, { id });
    return;
  }
  const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/download)?$/);
  if (match) {
    const job = jobFromUrl(match[1]);
    if (!job) {
      send(res, 404, { error: '任务不存在或服务已重启' });
      return;
    }
    if (match[2]) {
      if (job.public.stage !== 'complete') {
        send(res, 409, { error: '文件尚未生成完成' });
        return;
      }
      const file = path.join(job.dir, '智能美化结果.pptx');
      const downloadName = encodeURIComponent(job.public.result.downloadName);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': `attachment; filename="smart-beautified.pptx"; filename*=UTF-8''${downloadName}`,
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    send(res, 200, job.public);
    return;
  }
  send(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(__dirname, requested);
    if (!file.startsWith(__dirname + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    send(res, error.status || 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`智能美化 PPT 网页版：http://${host}:${port}`);
});
