const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const analyzeHandlerPromise = import(pathToFileURL(path.join(root, 'api', 'analyze.js')).href);
const imageHandlerPromise = import(pathToFileURL(path.join(root, 'api', 'image.js')).href);
const environmentKeys = [
  'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'MOONSHOT_API_KEY', 'KIMI_MODEL',
  'DASHSCOPE_API_KEY', 'DASHSCOPE_IMAGE_MODEL', 'DASHSCOPE_BASE_URL', 'ALLOWED_ORIGIN',
];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
let requestNumber = 0;

function request(body, options = {}, endpoint = 'analyze') {
  requestNumber += 1;
  return new Request(`https://smart-ppt-ten.vercel.app/api/${endpoint}`, {
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

test.beforeEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  global.fetch = originalFetch;
});

test.afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  global.fetch = originalFetch;
});

test('健康检查不泄露密钥并报告配置状态', async () => {
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request({}, { method: 'GET' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, { ok: true, provider: 'deepseek', configured: false });
  assert.equal(JSON.stringify(data).includes('DEEPSEEK_API_KEY'), false);
});

test('Kimi Secret 优先于 DeepSeek 且健康检查不泄露密钥', async () => {
  process.env.MOONSHOT_API_KEY = 'kimi-secret';
  process.env.DEEPSEEK_API_KEY = 'deepseek-secret';
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request({}, { method: 'GET' }));
  assert.deepEqual(await response.json(), { ok: true, provider: 'kimi', configured: true });
});

test('拒绝非支持方法和跨站请求', async () => {
  const { default: handler } = await analyzeHandlerPromise;
  assert.equal((await handler.fetch(request({}, { method: 'PUT' }))).status, 405);
  const crossSite = await handler.fetch(request(sample, { headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.status, 403);
});

test('未配置 Secret 时明确返回可回退错误', async () => {
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request(sample));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未配置/);
});

test('输入校验拒绝非法 ID 和不支持的类型', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const { default: handler } = await analyzeHandlerPromise;
  const badId = await handler.fetch(request({ blocks: [{ id: '../secret', kind: 'paragraph', text: '正文' }] }));
  assert.equal(badId.status, 400);
  const badKind = await handler.fetch(request({ blocks: [{ id: 'b1', kind: 'image', text: '图片' }] }));
  assert.equal(badKind.status, 400);
});

test('DeepSeek 代理仅发送文字块并返回通过校验的角色', async () => {
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
  const { default: handler } = await analyzeHandlerPromise;
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

test('Kimi 使用独立端点和模型并保留五类角色', async () => {
  process.env.MOONSHOT_API_KEY = 'kimi-test-key';
  process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
  process.env.KIMI_MODEL = 'kimi-test-model';
  const blocks = [
    { id: 'b0001', kind: 'paragraph', level: 0, text: '页面正文保持完整。' },
    { id: 'b0002', kind: 'note', level: 0, text: '口头补充，不显示在页面。' },
    { id: 'b0003', kind: 'instruction', level: 0, text: '本页使用居中版式' },
    { id: 'b0004', kind: 'image_prompt', level: 0, text: '生成实验室场景配图' },
  ];
  let providerRequest;
  global.fetch = async (url, options) => {
    providerRequest = { url, options };
    return Response.json({
      model: 'kimi-test-model',
      choices: [{ message: { content: JSON.stringify({ roles: [
        { id: 'b0001', kind: 'paragraph', level: 0 },
        { id: 'b0002', kind: 'note', level: 0 },
        { id: 'b0003', kind: 'instruction', level: 0 },
        { id: 'b0004', kind: 'image_prompt', level: 0 },
      ] }) } }],
    });
  };
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request({ blocks }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).roles.map(role => role.kind), ['paragraph', 'note', 'instruction', 'image_prompt']);
  assert.equal(providerRequest.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(providerRequest.options.headers.Authorization, 'Bearer kimi-test-key');
  const payload = JSON.parse(providerRequest.options.body);
  assert.equal(payload.model, 'kimi-test-model');
  assert.equal(payload.messages[1].content.includes('生成实验室场景配图'), true);
});

test('模型返回未知 ID 时拒绝应用', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ roles: [{ id: 'unknown', kind: 'heading', level: 1 }] }) } }],
  });
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request(sample));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /结构校验/);
});

test('服务端拒绝模型把备注或制作指令改为页面内容', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ roles: [{ id: 'b0001', kind: 'heading', level: 2 }] }) } }],
  });
  const { default: handler } = await analyzeHandlerPromise;
  const response = await handler.fetch(request({ blocks: [{ id: 'b0001', kind: 'note', level: 0, text: '只口述，不上屏' }] }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /结构校验/);
});

test('浏览器端拒绝 AI 把完整正文提升为标题', async () => {
  const { applyBlockRoles } = await import(pathToFileURL(path.join(root, 'src', 'web', 'engine', 'ai.js')).href);
  const blocks = [
    { id: 'body', kind: 'paragraph', level: 0, text: '这是一段完整解释，不能变成小标题。' },
    { id: 'short', kind: 'paragraph', level: 0, text: '研究背景' },
  ];
  const changed = applyBlockRoles(blocks, [
    { id: 'body', kind: 'heading', level: 3 },
    { id: 'short', kind: 'heading', level: 2 },
  ]);
  assert.equal(changed, 1);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.equal(blocks[0].level, 0);
  assert.equal(blocks[1].kind, 'heading');
  assert.equal(blocks[1].level, 2);
});

test('浏览器端禁止备注、指令和配图需求回流页面', async () => {
  const { applyBlockRoles } = await import(pathToFileURL(path.join(root, 'src', 'web', 'engine', 'ai.js')).href);
  const blocks = [
    { id: 'note', kind: 'note', level: 0, text: '讲稿' },
    { id: 'instruction', kind: 'instruction', level: 0, text: '使用深色模板' },
    { id: 'image', kind: 'image_prompt', level: 0, text: '生成一张实验室配图' },
  ];
  const changed = applyBlockRoles(blocks, blocks.map(block => ({ id: block.id, kind: 'paragraph', level: 0 })));
  assert.equal(changed, 0);
  assert.deepEqual(blocks.map(block => block.kind), ['note', 'instruction', 'image_prompt']);
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

test('万相健康检查和未配置错误不泄露密钥', async () => {
  const { default: handler } = await imageHandlerPromise;
  const health = await handler.fetch(request({}, { method: 'GET' }, 'image'));
  assert.deepEqual(await health.json(), { ok: true, provider: 'dashscope-wanx', configured: false });
  const response = await handler.fetch(request({ prompt: '实验室中的离子通道研究示意图' }, {}, 'image'));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /阿里云百炼/);
});

test('万相创建任务、轮询并下载真实 PNG 响应', async () => {
  process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
  process.env.DASHSCOPE_IMAGE_MODEL = 'wanx-test-model';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const calls = [];
  let queries = 0;
  global.fetch = async (url, options = {}) => {
    const address = String(url);
    calls.push({ address, options });
    if (address.endsWith('/services/aigc/text2image/image-synthesis')) {
      return Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
    }
    if (address.endsWith('/tasks/task-1')) {
      queries += 1;
      return Response.json({ output: queries === 1
        ? { task_status: 'RUNNING' }
        : { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example.test/generated.png' }] } });
    }
    if (address === 'https://cdn.example.test/generated.png') return new Response(png, { status: 200 });
    throw new Error(`unexpected fetch: ${address}`);
  };
  const { default: handler } = await imageHandlerPromise;
  const response = await handler.fetch(request({ prompt: '蓝色背景下的离子通道结构，简洁科研插画' }, {}, 'image'));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.model, 'wanx-test-model');
  assert.equal(data.image, Buffer.from(png).toString('base64'));
  assert.equal(queries, 2);
  assert.deepEqual(calls.map(call => call.address), [
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    'https://dashscope.aliyuncs.com/api/v1/tasks/task-1',
    'https://dashscope.aliyuncs.com/api/v1/tasks/task-1',
    'https://cdn.example.test/generated.png',
  ]);
  const creation = JSON.parse(calls[0].options.body);
  assert.equal(creation.model, 'wanx-test-model');
  assert.match(creation.input.prompt, /离子通道结构/);
  assert.equal(calls[0].options.headers['X-DashScope-Async'], 'enable');
  assert.equal(JSON.stringify(creation).includes('dashscope-test-key'), false);
});

test('万相拒绝非图片结果并明确本次未生成', async () => {
  process.env.DASHSCOPE_API_KEY = 'dashscope-test-key';
  global.fetch = async url => {
    const address = String(url);
    if (address.endsWith('/services/aigc/text2image/image-synthesis')) {
      return Response.json({ output: { task_id: 'task-2' } });
    }
    if (address.endsWith('/tasks/task-2')) {
      return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example.test/not-image' }] } });
    }
    return new Response('not an image', { status: 200 });
  };
  const { default: handler } = await imageHandlerPromise;
  const response = await handler.fetch(request({ prompt: '生成一张配图' }, {}, 'image'));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /下载或校验失败/);
});
