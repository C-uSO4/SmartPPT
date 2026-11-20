const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const handlerPromise = import(pathToFileURL(path.join(root, 'api', 'analyze.js')).href);
const originalKey = process.env.DEEPSEEK_API_KEY;
const originalFetch = global.fetch;
let requestNumber = 0;

function request(body, options = {}) {
  requestNumber += 1;
  return new Request('https://smart-ppt-ten.vercel.app/api/analyze', {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `192.0.2.${requestNumber}`,
      ...(options.headers || {}),
    },
    body: options.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

const sample = {
  blocks: [
    { id: 'b0001', kind: 'heading', level: 1, text: '研究背景' },
    { id: 'b0002', kind: 'heading', level: 2, text: '这是一段完整解释，不应当被提升为小标题。' },
  ],
};

test.afterEach(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  global.fetch = originalFetch;
});

test('健康检查不泄露密钥并报告配置状态', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const { default: handler } = await handlerPromise;
  const response = await handler.fetch(request({}, { method: 'GET' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, { ok: true, provider: 'deepseek', configured: false });
  assert.equal(JSON.stringify(data).includes('DEEPSEEK_API_KEY'), false);
});

test('拒绝非支持方法和跨站请求', async () => {
  const { default: handler } = await handlerPromise;
  assert.equal((await handler.fetch(request({}, { method: 'PUT' }))).status, 405);
  const crossSite = await handler.fetch(request(sample, { headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.status, 403);
});

test('未配置 Secret 时明确返回可回退错误', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const { default: handler } = await handlerPromise;
  const response = await handler.fetch(request(sample));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未配置/);
});

test('输入校验拒绝非法 ID 和不支持的类型', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const { default: handler } = await handlerPromise;
  const badId = await handler.fetch(request({ blocks: [{ id: '../secret', kind: 'paragraph', text: '正文' }] }));
  assert.equal(badId.status, 400);
  const badKind = await handler.fetch(request({ blocks: [{ id: 'b1', kind: 'image', text: '图片' }] }));
  assert.equal(badKind.status, 400);
});

test('代理仅发送文字块并返回通过校验的角色', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let providerRequest;
  global.fetch = async (url, options) => {
    providerRequest = { url, options };
    return Response.json({
      model: 'deepseek-test',
      choices: [{ message: { content: JSON.stringify({ roles: [
        { id: 'b0001', kind: 'heading', level: 2 },
        { id: 'b0002', kind: 'paragraph', level: 0 },
      ] }) } }],
    });
  };
  const { default: handler } = await handlerPromise;
  const response = await handler.fetch(request(sample));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.model, 'deepseek-test');
  assert.deepEqual(data.roles[1], { id: 'b0002', kind: 'paragraph', level: 0 });
  assert.equal(providerRequest.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(providerRequest.options.headers.Authorization, 'Bearer test-key');
  const payload = JSON.parse(providerRequest.options.body);
  assert.equal(payload.response_format.type, 'json_object');
  assert.equal(payload.messages[1].content.includes('这是一段完整解释'), true);
  assert.equal(JSON.stringify(payload).includes('test-key'), false);
});

test('模型返回未知 ID 时拒绝应用', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ roles: [{ id: 'unknown', kind: 'heading', level: 1 }] }) } }],
  });
  const { default: handler } = await handlerPromise;
  const response = await handler.fetch(request(sample));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /结构校验/);
});

test('浏览器端只应用角色，不改变任何原文', async () => {
  const { applyBlockRoles } = await import(pathToFileURL(path.join(root, 'src', 'web', 'engine', 'ai.js')).href);
  const blocks = sample.blocks.map(block => ({ ...block }));
  const before = blocks.map(block => block.text);
  const changed = applyBlockRoles(blocks, [
    { id: 'b0001', kind: 'heading', level: 2 },
    { id: 'b0002', kind: 'paragraph', level: 0 },
  ]);
  assert.equal(changed, 2);
  assert.deepEqual(blocks.map(block => block.text), before);
  assert.equal(blocks[1].kind, 'paragraph');
});
