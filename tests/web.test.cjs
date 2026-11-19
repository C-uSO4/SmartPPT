const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('等待服务或任务完成超时');
}

test('本地网页 API 完成上传、审计、错误处理和下载', async t => {
  const port = await freePort();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'smartppt-test-'));
  const staleId = crypto.randomUUID();
  const staleDir = path.join(runtime, staleId);
  fs.mkdirSync(staleDir);
  fs.writeFileSync(path.join(staleDir, 'status.json'), JSON.stringify({
    id: staleId, stage: 'rendering', filename: 'interrupted.pptx', updatedAt: new Date().toISOString(),
  }));
  const child = spawn(process.execPath, [path.join(root, 'src', 'web', 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), RUNTIME_DIR: runtime, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  t.after(() => {
    child.kill();
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${stderr}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  });

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health, { ok: true, engine: 'local-stdlib', dependencies: 0 });
  const recovered = await (await fetch(`${base}/api/jobs/${staleId}`)).json();
  assert.equal(recovered.stage, 'error');
  assert.match(recovered.error, /服务在生成过程中重启/);
  const home = await (await fetch(base)).text();
  assert.match(home, /FORM — 智能美化 PPT/);

  const unsupported = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'bad.pdf', content: Buffer.from('bad').toString('base64') }),
  });
  assert.equal(unsupported.status, 400);

  const empty = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'empty.md', content: '' }),
  });
  assert.equal(empty.status, 400);

  const sampleResponse = await fetch(`${base}/api/sample`);
  assert.equal(sampleResponse.status, 200);
  const sample = await sampleResponse.json();
  const created = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: sample.filename, content: sample.content, style: 'midnight' }),
  });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  const completed = await waitFor(async () => {
    const status = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (status.stage === 'error') throw new Error(status.error);
    return status.stage === 'complete' ? status : null;
  });
  assert.equal(completed.result.pageCount, 6);
  assert.equal(completed.result.style, 'midnight');
  assert.equal(completed.result.pages[0].page.background, '#101820');
  assert.equal(completed.result.fidelity.matched_blocks, completed.result.fidelity.source_blocks);
  assert.equal(completed.result.fidelity.missing_blocks.length, 0);
  assert.equal(completed.result.morphCount, 5);
  assert.ok(completed.result.timings.total_seconds > 0);

  const download = await fetch(`${base}/api/jobs/${id}/download`);
  assert.equal(download.status, 200);
  const data = Buffer.from(await download.arrayBuffer());
  assert.equal(data.subarray(0, 2).toString(), 'PK');
  assert.ok(data.length > 10000);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const assetOutline = Buffer.from('# 素材示例\n\n## 图片\n![像素示意图](pixel.png)\n\n## 公式\n$$E=mc^2$$\n');
  const assetJob = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'assets.md', content: assetOutline.toString('base64'), style: 'azure',
      assets: [{ filename: 'pixel.png', content: png.toString('base64') }],
    }),
  });
  assert.equal(assetJob.status, 202);
  const assetId = (await assetJob.json()).id;
  const assetComplete = await waitFor(async () => {
    const status = await (await fetch(`${base}/api/jobs/${assetId}`)).json();
    if (status.stage === 'error') throw new Error(status.error);
    return status.stage === 'complete' ? status : null;
  });
  const imageElement = assetComplete.result.pages.flatMap(page => page.page.elements).find(element => element.type === 'image');
  assert.ok(imageElement.src.startsWith('data:image/png;base64,'));
  const assetDownload = await fetch(`${base}/api/jobs/${assetId}/download`);
  assert.equal(assetDownload.status, 200);
  const assetData = Buffer.from(await assetDownload.arrayBuffer());
  assert.equal(assetData.subarray(0, 2).toString(), 'PK');
  assert.ok(assetData.length > 10000);

  const corrupt = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'broken.pptx', content: Buffer.from('not a zip').toString('base64') }),
  });
  const corruptId = (await corrupt.json()).id;
  const failed = await waitFor(async () => {
    const status = await (await fetch(`${base}/api/jobs/${corruptId}`)).json();
    return status.stage === 'error' ? status : null;
  });
  assert.match(failed.error, /文件已损坏或不是有效的 DOCX\/PPTX/);
});
