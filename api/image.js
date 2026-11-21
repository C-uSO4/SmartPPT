const MAX_BODY_BYTES = 4_000;
const MAX_PROMPT_CHARACTERS = 500;
const MAX_IMAGE_BYTES = 3_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 4;
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

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return json({ ok: true, provider: 'dashscope-wanx', configured: Boolean(process.env.DASHSCOPE_API_KEY) });
    }
    if (request.method !== 'POST') return json({ error: '仅支持 POST 配图请求' }, 405);
    if (!allowedRequest(request)) return json({ error: '请求来源不受允许' }, 403);
    if (rateLimited(request)) return json({ error: 'AI 配图请求过于频繁，请稍后再试' }, 429);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ error: 'AI 配图请求内容过大' }, 413);

    let prompt;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'AI 配图请求内容过大' }, 413);
      }
      const input = JSON.parse(raw);
      prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT_CHARACTERS) {
        return json({ error: `请提供 1–${MAX_PROMPT_CHARACTERS} 字符的配图提示` }, 400);
      }
    } catch (error) {
      return json({ error: error instanceof SyntaxError ? '请求 JSON 格式不正确' : String(error.message || error) }, 400);
    }

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) return json({ error: 'AI 配图服务尚未配置阿里云百炼 API Key，本次未生成图片' }, 503);
    const model = process.env.DASHSCOPE_IMAGE_MODEL || 'wanx2.1-t2i-turbo';
    const baseUrl = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    let taskId;
    try {
      const response = await fetch(`${baseUrl}/services/aigc/text2image/image-synthesis`, {
        method: 'POST',
        headers: { ...headers, 'X-DashScope-Async': 'enable' },
        body: JSON.stringify({
          model,
          input: {
            prompt: `为中文演示文稿生成一张适合 16:9 页面使用的横向配图，画面简洁，不要出现文字或标志。具体需求：${prompt}`,
            negative_prompt: '文字，字母，数字，水印，Logo，低分辨率，模糊，肢体畸形',
          },
          parameters: { size: '1440*810', n: 1, prompt_extend: true, watermark: false },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        console.error('DashScope image task failed', response.status);
        return json({ error: 'AI 图片模型创建任务失败，请检查百炼额度、模型权限或稍后重试' }, 502);
      }
      const data = await response.json();
      taskId = data.output?.task_id;
      if (!taskId) throw new Error('缺少 task_id');
    } catch (error) {
      console.error('DashScope image task rejected', String(error.message || error));
      return json({ error: 'AI 图片模型暂时无法创建任务，本次未生成图片' }, 502);
    }

    const deadline = Date.now() + 38_000;
    let imageUrl = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          console.error('DashScope image query failed', response.status);
          return json({ error: 'AI 图片任务查询失败，本次未生成图片' }, 502);
        }
        const data = await response.json();
        const status = data.output?.task_status;
        if (status === 'SUCCEEDED') {
          imageUrl = data.output?.results?.[0]?.url || null;
          break;
        }
        if (status === 'FAILED' || status === 'CANCELED') {
          console.error('DashScope image generation failed', data.output?.code || status);
          return json({ error: 'AI 图片模型未能完成这张配图，请调整提示或稍后重试' }, 502);
        }
      } catch (error) {
        console.error('DashScope image query rejected', String(error.message || error));
        return json({ error: 'AI 图片任务暂时无法查询，本次未生成图片' }, 502);
      }
      await wait(1_500);
    }
    if (!imageUrl) return json({ error: 'AI 图片生成超时，本次未生成图片' }, 504);

    try {
      const parsedUrl = new URL(imageUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('图片地址不是 HTTPS');
      const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`图片下载状态 ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过响应大小限制');
      const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => bytes[index] === value);
      const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!png && !jpeg) throw new Error('图片不是有效 PNG/JPEG');
      return json({ image: encodeBase64(bytes), model });
    } catch (error) {
      console.error('DashScope image result rejected', String(error.message || error));
      return json({ error: 'AI 配图结果下载或校验失败，本次未生成图片' }, 502);
    }
  },
};
