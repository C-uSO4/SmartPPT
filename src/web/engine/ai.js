const ROLE_KINDS = ['heading', 'paragraph', 'note', 'instruction', 'image_prompt'];
const CONTENT_KINDS = ['heading', 'paragraph'];

export async function analyzeBlockRoles(blocks) {
  const candidates = blocks
    .filter(block => ROLE_KINDS.includes(block.kind) && block.text.trim())
    .map(block => ({ id: block.id, kind: block.kind, level: block.level || 0, text: block.text }));
  if (!candidates.length) return { roles: [], model: null };
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: candidates }),
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(50_000) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AI 服务返回 ${response.status}`);
  const byId = new Map(candidates.map(block => [block.id, block]));
  const seen = new Set();
  const roles = Array.isArray(data.roles) ? data.roles.map(role => {
    if (!byId.has(role.id) || seen.has(role.id) || !ROLE_KINDS.includes(role.kind)) {
      throw new Error('AI 返回了无法应用的文字角色');
    }
    if (role.kind === 'heading' && (!Number.isInteger(role.level) || role.level < 1 || role.level > 4)) {
      throw new Error('AI 返回了无法应用的标题层级');
    }
    seen.add(role.id);
    return { id: role.id, kind: role.kind, level: role.kind === 'heading' ? role.level : 0 };
  }) : [];
  return { roles, model: typeof data.model === 'string' ? data.model : null };
}

export async function generateImage(prompt) {
  const response = await fetch('/api/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(55_000) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AI 配图服务返回 ${response.status}`);
  if (typeof data.image !== 'string' || !data.image) throw new Error('AI 配图服务未返回图片');
  return { image: data.image, model: typeof data.model === 'string' ? data.model : null };
}

function headingEligible(block) {
  const text = String(block.text || '').trim();
  return text.length <= 48 && !text.includes('\n') && !/[。！？；!?;，,]/.test(text) && !/^[•●▪-]\s+/.test(text);
}

export function applyBlockRoles(blocks, roles) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  let changed = 0;
  for (const role of roles) {
    const block = byId.get(role.id);
    if (!block || !ROLE_KINDS.includes(block.kind) || !ROLE_KINDS.includes(role.kind)) continue;
    if (!CONTENT_KINDS.includes(block.kind) && CONTENT_KINDS.includes(role.kind)) continue;
    if (block.kind === 'paragraph' && role.kind === 'heading' && !headingEligible(block)) continue;
    if (block.kind !== role.kind || block.level !== role.level) changed += 1;
    block.kind = role.kind;
    block.level = role.kind === 'heading' ? role.level : 0;
  }
  return changed;
}
