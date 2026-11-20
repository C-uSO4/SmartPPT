const MAX_BODY_BYTES = 100_000;
const MAX_BLOCKS = 400;
const MAX_TOTAL_CHARACTERS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 6;
const rateBuckets = new Map();

export const config = { maxDuration: 60 };

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function allowedRequest(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set([
    new URL(request.url).origin,
    ...(process.env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean),
  ]);
  return allowed.has(origin);
}

function rateLimited(request) {
  const address = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (rateBuckets.get(address) || []).filter(time => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(address, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(address, recent);
  if (rateBuckets.size > 1000) {
    for (const [key, times] of rateBuckets) {
      if (!times.some(time => now - time < RATE_WINDOW_MS)) rateBuckets.delete(key);
    }
  }
  return false;
}

function validateBlocks(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BLOCKS) {
    throw new Error(`请提供 1–${MAX_BLOCKS} 个待分析文字块`);
  }
  const ids = new Set();
  let totalCharacters = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('文字块格式不正确');
    const id = String(item.id || '');
    const kind = String(item.kind || '');
    const text = String(item.text || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('文字块 ID 不正确或重复');
    if (!['heading', 'paragraph'].includes(kind)) throw new Error('包含不支持的文字块类型');
    if (!text.trim() || text.length > 4000) throw new Error('文字块为空或单块过长');
    ids.add(id);
    totalCharacters += text.length;
    if (totalCharacters > MAX_TOTAL_CHARACTERS) throw new Error('本次 AI 分析文字超过 60000 字符，请拆分文件');
    return { id, kind, text, level: Number.isInteger(item.level) ? item.level : 0 };
  });
}

function validateRoles(value, blocks) {
  if (!value || !Array.isArray(value.roles)) throw new Error('模型未返回 roles');
  const byId = new Map(blocks.map(block => [block.id, block]));
  const seen = new Set();
  return value.roles.map(role => {
    const id = String(role?.id || '');
    const kind = String(role?.kind || '');
    const level = Number(role?.level);
    if (!byId.has(id) || seen.has(id) || !['heading', 'paragraph'].includes(kind)) {
      throw new Error('模型返回了无效角色');
    }
    if (kind === 'heading' && (!Number.isInteger(level) || level < 1 || level > 4)) {
      throw new Error('模型返回了无效标题层级');
    }
    seen.add(id);
    return { id, kind, level: kind === 'heading' ? level : 0 };
  });
}

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return json({ ok: true, provider: 'deepseek', configured: Boolean(process.env.DEEPSEEK_API_KEY) });
    }
    if (request.method !== 'POST') return json({ error: '仅支持 POST 分析请求' }, 405);
    if (!allowedRequest(request)) return json({ error: '请求来源不受允许' }, 403);
    if (rateLimited(request)) return json({ error: 'AI 请求过于频繁，请稍后再试' }, 429);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ error: 'AI 请求内容过大' }, 413);

    let blocks;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'AI 请求内容过大' }, 413);
      }
      const input = JSON.parse(raw);
      blocks = validateBlocks(input.blocks);
    } catch (error) {
      return json({ error: error instanceof SyntaxError ? '请求 JSON 格式不正确' : String(error.message || error) }, 400);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return json({ error: 'AI 服务尚未配置，请稍后再试或使用本地规则' }, 503);

    const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    let providerResponse;
    try {
      providerResponse = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: '你是演示文稿结构分类器。只判断给定文字块是 heading 还是 paragraph，不能改写、概括、增删文字。普通完整句子、解释、论证、带句号的文字默认是 paragraph；只有真正承担文档或章节标题功能的短文字才是 heading。现有 heading 也可纠正为 paragraph，现有 paragraph 只有在语义明确时才可提升为 heading。返回 JSON：{"roles":[{"id":"原 ID","kind":"heading|paragraph","level":1}]}。heading 的 level 只能为 1–4，文档主标题为 1、主要章节为 2、下级小节为 3–4；paragraph 的 level 为 0。不要返回 Markdown 代码围栏。',
            },
            { role: 'user', content: JSON.stringify({ blocks }) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      return json({ error: 'AI 模型暂时无法连接，请使用本地规则或稍后重试' }, 502);
    }

    if (!providerResponse.ok) {
      console.error('DeepSeek request failed', providerResponse.status);
      return json({ error: 'AI 模型请求失败，请检查服务额度或稍后重试' }, 502);
    }

    try {
      const providerData = await providerResponse.json();
      const content = providerData.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型响应缺少内容');
      const roles = validateRoles(JSON.parse(content), blocks);
      return json({ roles, model: providerData.model || model });
    } catch (error) {
      console.error('DeepSeek response rejected', String(error.message || error));
      return json({ error: 'AI 返回结果未通过结构校验，已建议使用本地规则' }, 502);
    }
  },
};
