import { buildScreenDoc, buildPatch, buildExplicitPatch } from './local.js';
import { ensureDocFromRemote, ensurePatchFromRemote, htmlToTree } from './normalize.js';
import { modelFailed } from '../errors.js';

/**
 * Provider 适配层（NFR-011：换模型不改业务代码）
 *
 * 模型来源优先级：
 *   1. 服务层传入的 model（来自「AI 模型」目录的当前选中项）
 *   2. 环境变量 AI_PROVIDER / AI_BASE_URL / AI_API_KEY / AI_MODEL（兼容旧用法）
 *
 * 无论哪个 provider，返回都必须是统一契约：
 *   整屏：{ mode:'full', doc }
 *   局部：{ mode:'patch', ops:[...] }
 * 上层（service.js）只认这个契约。
 *
 * 自定义（OpenAI 兼容）网关的差异都收敛在 callRemote 里：
 *   - Base URL 写法：只给 host、给到 /v1/、直接给到 /chat/completions 都能用；
 *   - 参数兼容：response_format / max_tokens 被拒时自动降级重试，而不是直接 502；
 *   - 返回形态：content 字符串 / parts 数组 / tool_calls / reasoning_content 都能取到；
 *   - 输出形态：JSON 代码块、JSON 前后夹带说明文字都会被剥出正文；
 *   - 错误可读：把网关的错误 message 带回来，而不是只报一个状态码。
 */

const DEFAULT_TIMEOUT = 30000;
/** 整屏 JSON 节点树很容易超预算，默认给足，否则网关会按很低的默认值截断 */
const DEFAULT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 8192);

export function getProviderName() {
  return process.env.AI_PROVIDER || 'local';
}

function configOf(model) {
  if (model && typeof model === 'object' && model.provider) {
    return {
      provider: model.provider,
      model: model.model,
      base_url: model.base_url,
      api_key: model.api_key,
      timeout_ms: model.timeout_ms,
      name: model.name,
      model_id: model.model_id,
    };
  }
  return {
    provider: getProviderName(),
    model: getProviderName() === 'local' ? 'local-deterministic' : process.env.AI_MODEL,
    base_url: process.env.AI_BASE_URL,
    api_key: process.env.AI_API_KEY,
    timeout_ms: Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT),
    source: 'env',
  };
}
export function describeProvider(model) {
  const cfg = configOf(model);
  return {
    provider: cfg.provider,
    model: cfg.provider === 'local' ? 'local-deterministic' : cfg.model || 'unknown',
    base_url: cfg.provider === 'local' ? null : cfg.base_url || null,
    name: cfg.name || (cfg.provider === 'local' ? '内置生成器' : cfg.model || 'unknown'),
    source: cfg.source || 'catalog',
  };
}

export async function generateFull({ ctx, screen, project, model }) {
  const cfg = configOf(model);
  if (cfg.provider === 'local') {
    const { doc, template } = buildScreenDoc({ instruction: ctx?.payload?.instruction || '', screen, project });
    return { mode: 'full', doc, template };
  }
  return callRemote(ctx, { expects: 'doc', model: cfg });
}

export async function generatePatch({ ctx, currentDoc, screen, editScope, selection, model, route }) {
  const cfg = configOf(model);
  if (cfg.provider === 'local') {
    const base = {
      instruction: ctx?.payload?.instruction || '',
      currentDoc,
      editScope,
      selection,
      tokens: ctx?.payload?.design_tokens,
    };
    // FR-ROUTE-001：显式结构化指令优先，直接按 node_id / anchor 定位
    if (route?.layer === 'explicit' && route.target) {
      const explicit = buildExplicitPatch({ ...base, target: route.target });
      if (explicit.ops.length) return { mode: explicit.mode, ops: explicit.ops, note: explicit.note };
    }
    const patch = buildPatch(base);
    return { mode: patch.mode === 'full' ? 'full' : 'patch', ops: patch.ops, note: patch.note };
  }
  return callRemote(ctx, { expects: 'patch', model: cfg });
}

/** 连接测试：只发一句话，验证地址 / 密钥 / 模型名是否可用 */
export async function testConnection(model) {
  const cfg = configOf(model);
  if (cfg.provider === 'local') return { ok: true, provider: 'local', latency_ms: 0, reply: '内置生成器无需联网' };
  const started = Date.now();
  const { raw } = await requestChat(cfg, {
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 16,
    timeoutMs: Math.min(Number(cfg.timeout_ms || DEFAULT_TIMEOUT), 20000),
  });
  return {
    ok: true,
    provider: cfg.provider,
    model: cfg.model,
    latency_ms: Date.now() - started,
    endpoint: chatEndpoint(cfg.base_url),
    reply: String(raw || '').slice(0, 40),
  };
}

/** 把用户填的 Base URL 归一成真正的 /chat/completions 地址 */
export function chatEndpoint(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return null;
  if (/\/chat\/completions$/i.test(b)) return b;
  // 只给到 host（或 host/xxx 但不像版本号）时补 /v1
  if (/^https?:\/\/[^/]+$/i.test(b)) b += '/v1';
  return `${b}/chat/completions`;
}

/** 判断这次失败是不是"某个可选参数不被支持"，可以去掉该参数重试 */
function unsupported(field, res, text) {
  if (res.status !== 400 && res.status !== 422) return false;
  const t = String(text || '').toLowerCase();
  const mentionsField =
    field === 'response_format'
      ? /response_format|response format|json_object|json mode/.test(t)
      : /max_tokens|max_completion_tokens|max output|maximum.*tokens/.test(t);
  const mentionsUnsupported = /unrecogn|unsupport|not support|invalid|unknown|not allowed|does not exist|不支持|无法识别/.test(t);
  return mentionsField && mentionsUnsupported;
}

function errorMessageOf(text) {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.message || j?.error || '';
  } catch {
    return String(text || '').slice(0, 300);
  }
}

async function requestChat(cfg, { messages, maxTokens, timeoutMs }) {
  const url = chatEndpoint(cfg.base_url);
  const modelName = cfg.model;
  if (!url || !modelName) {
    throw modelFailed('当前模型缺少 Base URL 或模型标识', {
      hint: '打开顶栏「AI 模型」补全配置，或切换到内置生成器',
    });
  }

  // 按"可选参数开关"逐级降级：网关拒绝 response_format / max_tokens 时重试一次，
  // 而不是把 400 直接透传成 MODEL_FAILED 让用户去猜。
  let useResponseFormat = true;
  let useMaxTokens = true;
  let body = null;
  let text = '';

  for (let attempt = 0; attempt < 4; attempt++) {
    body = { model: modelName, temperature: 0.2, messages };
    if (useResponseFormat) body.response_format = { type: 'json_object' };
    if (useMaxTokens && maxTokens) body.max_tokens = maxTokens;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(timeoutMs || DEFAULT_TIMEOUT));
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: buildHeaders(cfg.api_key),
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw modelFailed(`模型请求超时（${Number(timeoutMs || DEFAULT_TIMEOUT)}ms）`, {
          hint: '网络慢或整屏内容过大，可在「AI 模型」里调大超时时间',
          endpoint: url,
        });
      }
      throw modelFailed(`无法连接模型网关：${err?.cause?.code || err?.cause?.message || err.message}`, {
        hint: '检查 Base URL 是否为可访问的 http(s) 地址；本地服务需要先启动，容器内的 127.0.0.1 指向容器自己',
        endpoint: url,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return { json: parseJsonLoose(text) || {}, raw: text, url };

    if (useResponseFormat && unsupported('response_format', res, text)) {
      useResponseFormat = false;
      continue;
    }
    if (useMaxTokens && unsupported('max_tokens', res, text)) {
      useMaxTokens = false;
      continue;
    }
    // 旧的 max_tokens 被拒、但网关认识 max_completion_tokens：直接换成新字段再试一次
    if (useMaxTokens && res.status === 400 && /max_completion_tokens/.test(text)) {
      body.max_tokens = undefined;
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), Number(timeoutMs || DEFAULT_TIMEOUT));
      try {
        const res2 = await fetch(url, {
          method: 'POST',
          signal: ac2.signal,
          headers: buildHeaders(cfg.api_key),
          body: JSON.stringify({ ...body, max_tokens: undefined, max_completion_tokens: maxTokens }),
        });
        const text2 = await res2.text();
        if (res2.ok) return { json: parseJsonLoose(text2) || {}, raw: text2, url };
        text = text2;
        res = res2;
      } finally {
        clearTimeout(t2);
      }
    }

    const detail = errorMessageOf(text);
    const hint =
      res.status === 401 || res.status === 403
        ? 'API Key 无效或无权限'
        : res.status === 404
          ? '接口路径或模型标识不存在：Base URL 一般形如 https://host/v1，模型名要和网关里登记的完全一致'
          : res.status === 429
            ? '触发限流，稍后重试或换模型'
            : '查看网关侧日志确认请求参数是否被支持';
    throw modelFailed(`模型网关返回 ${res.status}${detail ? `：${detail}` : ''}`, {
      status: res.status,
      endpoint: url,
      hint,
      body: String(text || '').slice(0, 800),
    });
  }

  throw modelFailed('模型网关拒绝了请求参数（已尝试降级重试）', {
    endpoint: url,
    hint: '确认该网关是否支持 JSON 输出模式；不支持的请在网关侧关闭',
    request: safeStringify(body),
  });
}

function buildHeaders(apiKey) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  // 自建 OpenAI 兼容服务通常不需要 key，因此 key 可选
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v).slice(0, 600);
  } catch {
    return '';
  }
}

/**
 * 宽松 JSON 解析：只用于"网关响应体"这种结构可控的场景（不是模型输出）。
 * 网关有时会返回非 JSON（比如代理页），此时返回 null，交给上层看 text。
 */
function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callRemote(ctx, { expects, model }) {
  const cfg = model || configOf(null);
  const timeoutMs = Number(cfg.timeout_ms || process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT);
  const messages = buildMessages(ctx, expects);
  const { json } = await requestChat(cfg, { messages, maxTokens: DEFAULT_MAX_TOKENS, timeoutMs });

  const { content, finishReason, finishDetail } = pickContent(json);
  if (!content || !String(content).trim()) {
    if (finishReason === 'length') {
      throw modelFailed('模型输出被长度限制截断，未返回任何内容', {
        hint: '整屏节点树较长，请在网关或「AI 模型」里把 max_tokens 调大，或改用局部修改',
      });
    }
    const errDetail = json?.error?.message || json?.error || '';
    throw modelFailed(`模型返回空内容${errDetail ? `：${errDetail}` : ''}`, {
      hint: '确认所选模型支持 chat/completions，且 prompt 未被内容安全策略拦截',
      finish_reason: finishReason || finishDetail || null,
    });
  }

  const parsedJson = extractJson(content);
  if (parsedJson == null) {
    const looksHtml = /^\s*<(!doctype|html|[a-z]+[\s>])/i.test(String(content));
    if (looksHtml) {
      // 有的网关/模型直接吐 HTML：既然契约是"节点树"，这里直接转成树，避免落库后白屏
      return { mode: 'full', doc: ensureDocFromRemote(htmlToTree(content), { screenIdHint: ctx?.payload?.request?.target_screen_id }) };
    }
    throw modelFailed('模型输出不是合法 JSON（已在落库前拦截）', {
      hint:
        finishReason === 'length'
          ? '输出被 max_tokens 截断，调大输出上限或改用整屏分步生成'
          : '检查网关是否强制返回了额外前后缀；本系统会剥离 ```json 代码块后再解析',
      raw: String(content).slice(0, 800),
    });
  }

  return normalizeRemoteOutput(parsedJson, expects, { ctx, finishReason });
}

function buildMessages(ctx, expects) {
  const system = ctx?.prompt || '';
  const format =
    expects === 'doc'
      ? [
          '请只返回一个 JSON 对象，形如 {"version":1,"root":{"id":"...","type":"frame","tag":"section","props":{"style":{...},"attrs":{"data-block":"root"}},"children":[...]}}。',
          '节点结构：{"id":字符串(屏内唯一),"type":字符串,"tag":div|span|button|section|h1..h6|p|input|img 等,"props":{"style":{CSS 驼峰属性},"attrs":{...},"text":字符串},"children":[节点...]}。',
          '可点击元素（button / a / 可点的 li）必须在 props.attrs 里带 data-anchor 且值唯一、只含字母数字下划线短横线；顶层区块带 data-block。',
          '不要输出 HTML 字符串，不要输出注释或解释文字。',
        ].join('\n')
      : [
          '请只返回一个 JSON 对象，形如 {"mode":"patch","ops":[...],"note":"可选说明"}。',
          '可用 op：replaceNode / updateProps / insertChild / insertAfter / removeNode / setStyle。',
          'target 只能写 {"node_id":"..."} 或 {"selector":{"type":"anchor|block","value":"..."}}，禁止 nth-child / 位置索引。',
          '不需要修改时返回 {"mode":"noop","ops":[]}，并说明原因。',
        ].join('\n');
  const user = expects === 'doc' ? '请严格按照上述节点树结构，产出目标屏幕的完整 JSON。' : '请严格按照上述 ops 结构，产出局部修改的 JSON。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${format}\n\n${user}` },
  ];
}

/**
 * 从 chat/completions 响应里取出"模型说的话"。
 * 覆盖：content 字符串、parts 数组、tool_calls.arguments、reasoning_content。
 */
function pickContent(json) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || choice.delta || {};
  const finishReason = choice.finish_reason || null;
  const parts = [];

  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (v.trim()) parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') push(item);
        else if (item && typeof item === 'object') push(item.text ?? item.content ?? item.output_text ?? '');
      }
      return;
    }
    if (typeof v === 'object') push(v.text ?? v.content ?? '');
  };

  push(msg.content);
  if (!parts.length) push(msg.reasoning_content ?? msg.reasoning);
  if (!parts.length && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) push(tc?.function?.arguments);
  }
  if (!parts.length && msg.function_call?.arguments) push(msg.function_call.arguments);
  // 个别网关把结果放在 choices[0].text（completions 风格）
  if (!parts.length) push(choice.text);

  return { content: parts.join('\n'), finishReason };
}

/**
 * 从可能夹带 ```json 代码块、前后说明文字的字符串里取出 JSON 值。
 * 返回 null 表示确实没有可解析的 JSON。
 */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试 */
  }

  // 1) ```json ... ``` / ``` ... ```
  const fence = /```(?:json|JSON|javascript|js)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(s))) {
    const body = m[1].trim();
    try {
      return JSON.parse(body);
    } catch {
      /* 继续 */
    }
  }

  // 2) 从第一个 { 或 [ 开始做括号配平（忽略字符串内部的括号）
  const start = s.search(/[{[]/);
  if (start >= 0) {
    const candidate = sliceBalanced(s, start);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* 落空 */
      }
    }
  }
  return null;
}

function sliceBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 远端网关可能直接返回 doc / ops，也可能已经套了统一契约。
 * 这里统一归一化 + 结构修复，避免上层因为少一层外壳而误判。
 */
function normalizeRemoteOutput(parsed, expects, { ctx, finishReason } = {}) {
  const screenIdHint = ctx?.payload?.request?.target_screen_id;
  if (expects === 'doc') {
    const raw = parsed && typeof parsed === 'object' && parsed.doc ? parsed.doc : parsed;
    // {"root": ...} 或 {"version":1,"root":...} 都接受
    const docLike = raw && typeof raw === 'object' && raw.root && !raw.tag ? raw : raw;
    return { mode: 'full', doc: ensureDocFromRemote(docLike, { screenIdHint }) };
  }

  const wraps = [];
  if (Array.isArray(parsed?.ops)) wraps.push(parsed);
  if (Array.isArray(parsed?.patch?.ops)) wraps.push({ ...parsed.patch, note: parsed.note });
  if (Array.isArray(parsed?.changes)) wraps.push({ ...parsed, ops: parsed.changes });
  if (Array.isArray(parsed?.edits)) wraps.push({ ...parsed, ops: parsed.edits });
  if (Array.isArray(parsed)) wraps.push({ ops: parsed });

  if (!wraps.length) {
    // 模型直接返回了整屏 doc（常见的"越权/偷懒"）：交给上层按 full 处理，
    // 由 service 判断是否需要整屏替换，而不是在这里冒充 patch。
    const raw = parsed?.doc && parsed.doc.root ? parsed.doc : parsed;
    if (raw && typeof raw === 'object' && raw.root) {
      if (finishReason === 'length') {
        throw modelFailed('模型输出被长度限制截断，整屏 JSON 不完整', {
          hint: '调大输出上限，或把修改拆小后用局部 patch',
        });
      }
      return { mode: 'full', doc: ensureDocFromRemote(raw, { screenIdHint }) };
    }
    throw modelFailed('模型输出缺少 ops 数组（已在落库前拦截）', {
      raw: JSON.stringify(parsed).slice(0, 800),
      hint: '模型可能没有按 patch 契约返回；本次修改未写入屏幕',
    });
  }

  const first = wraps[0];
  const ops = ensurePatchFromRemote(first.ops);
  if (!ops.length) {
    // 空 ops 是"没听懂"，不是非法输出
    return { mode: 'noop', ops: [], note: first.note || parsed?.note || '模型未给出可执行的修改' };
  }
  return { mode: 'patch', ops, note: first.note ?? parsed?.note };
}

export { normalizeRemoteOutput };
