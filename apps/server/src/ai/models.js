import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic, KeyedQueue } from '../store/fs.js';
import { badRequest, notFound } from '../errors.js';

/**
 * AI 模型目录（全局配置，不属于任何项目）。
 *
 * 存储位置：data/ai-models.json
 * 安全约定：
 *  - api_key 只落在服务端文件里，任何 list/get 响应都不返回明文；
 *  - 前端只拿到 has_api_key / api_key_hint，用于判断"是否已配置"；
 *  - 更新时 api_key 留空表示保持原值，clear_api_key=true 才清除。
 *
 * 内置生成器维护（FR-ROUTE-009 / FR-ROUTE-007）：
 *  - 内置生成器除名称外，还可维护「启用范围」generator_scope、
 *    「启用的规则」rules，以及总体开关 router_enabled；
 *  - scope=off 等价于关闭内置生成器：确定性请求也走大模型（AC-211）；
 *  - 配置只影响之后的生成任务，不改写已有版本。
 */

const BUILTIN_ID = 'mdl_local';
const PROVIDERS = ['local', 'openai-compatible'];
/** 内置生成器启用范围：全局（规则+显式）/ 仅显式结构化指令 / 关闭 */
export const GENERATOR_SCOPES = ['global', 'explicit_only', 'off'];
export const DEFAULT_GENERATOR_SCOPE = 'global';
/** 内置生成器内置规则白名单，顺序即路由优先级 */
export const BUILTIN_RULES = ['text_replace', 'button_label', 'tone_adjust', 'font_scale', 'align_center', 'radius', 'color', 'bold', 'add_element', 'remove_element'];

export function defaultGeneratorConfig() {
  return {
    enabled: true,
    scope: DEFAULT_GENERATOR_SCOPE,
    rules: [...BUILTIN_RULES],
    router_enabled: true,
    updated_at: null,
    updated_by: null,
  };
}

const now = () => new Date().toISOString();
const rid = () => `mdl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

export class ModelStore {
  constructor(root) {
    this.file = path.join(root, 'ai-models.json');
    this.queue = new KeyedQueue();
  }

  async list() {
    const data = await this.#read();
    return {
      schema_version: 1,
      models: data.models.map((m) => publicModel(m, data.active_model_id)),
      active_model_id: data.active_model_id,
    };
  }

  /** 服务端内部使用：带密钥的完整配置（含内置生成器维护配置） */
  async getInner(modelId) {
    const data = await this.#read();
    return data.models.find((m) => m.model_id === modelId) || null;
  }

  /** 内置生成器当前生效配置（服务端路由与前端展示共用，不含任何密文） */
  async generatorConfig() {
    const data = await this.#read();
    const builtin = data.models.find((m) => m.builtin);
    return publicGeneratorConfig(builtin);
  }

  /**
   * 维护内置生成器（FR-ROUTE-009）：名称、启用范围、启用规则、路由总体开关。
   * 结构性约束不可改：不能删除、不能停用（enabled 恒为 true）、provider 恒为 local。
   */
  updateGenerator(input = {}) {
    return this.queue.run('ai-models', async () => {
      const data = await this.#read();
      const idx = data.models.findIndex((m) => m.builtin);
      if (idx < 0) throw notFound('内置生成器不存在');
      const existing = data.models[idx];
      const next = { ...existing };
      if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name) throw badRequest('内置生成器名称不能为空');
        if (name.length > 80) throw badRequest('内置生成器名称不能超过 80 个字符');
        next.name = name;
      }
      if (input.scope !== undefined) {
        if (!GENERATOR_SCOPES.includes(input.scope)) {
          throw badRequest(`启用范围只能是 ${GENERATOR_SCOPES.join(' / ')}`, {
            hint: 'global=规则与显式指令都走内置生成器；explicit_only=只处理携带结构化 target 的指令；off=关闭，确定性请求也走大模型',
          });
        }
      }
      const scope = input.scope ?? existing.generator_scope ?? DEFAULT_GENERATOR_SCOPE;
      if (input.rules !== undefined) {
        if (!Array.isArray(input.rules)) throw badRequest('rules 必须是数组');
        const unknown = input.rules.filter((r) => !BUILTIN_RULES.includes(r));
        if (unknown.length) throw badRequest(`未知规则: ${unknown.join(', ')}`, { hint: `可用规则：${BUILTIN_RULES.join(' / ')}` });
      }
      next.generator_scope = scope;
      next.rules = input.rules === undefined ? existing.rules || [...BUILTIN_RULES] : [...new Set(input.rules)];
      // 关闭时保留已选规则，重新打开即恢复，避免用户反复重配
      next.generator_router = input.router_enabled === undefined ? existing.generator_router !== false : !!input.router_enabled;
      next.generator_enabled = scope !== 'off';
      next.generator_updated_at = now();
      next.generator_updated_by = input.actor || null;
      next.updated_at = now();
      data.models[idx] = next;
      await this.#write(data);
      return publicModel(next, data.active_model_id);
    });
  }

  async getActive() {
    const data = await this.#read();
    return data.models.find((m) => m.model_id === data.active_model_id && m.enabled) || data.models.find((m) => m.builtin) || null;
  }

  async get(modelId) {
    const data = await this.#read();
    return data.models.find((m) => m.model_id === modelId) || null;
  }

  create(input = {}) {
    return this.queue.run('ai-models', async () => {
      const data = await this.#read();
      if ((input.provider || 'openai-compatible') === 'local') {
        throw badRequest('内置生成器已经存在，无需新增 local 模型');
      }
      const model = normalize(input, null);
      data.models.push(model);
      if (!data.active_model_id) data.active_model_id = model.model_id;
      await this.#write(data);
      return publicModel(model, data.active_model_id);
    });
  }

  update(modelId, input = {}) {
    return this.queue.run('ai-models', async () => {
      const data = await this.#read();
      const idx = data.models.findIndex((m) => m.model_id === modelId);
      if (idx < 0) throw notFound(`模型不存在: ${modelId}`);
      const existing = data.models[idx];
      if (existing.builtin && input.provider && input.provider !== 'local') {
        throw badRequest('内置生成器的 provider 不能修改');
      }
      if (existing.builtin && input.enabled === false) {
        throw badRequest('内置生成器不能停用');
      }
      const next = normalize(input, existing);
      data.models[idx] = next;
      // 停用当前模型时自动回退到内置生成器
      if (data.active_model_id === modelId && !next.enabled) data.active_model_id = BUILTIN_ID;
      await this.#write(data);
      return publicModel(next, data.active_model_id);
    });
  }

  remove(modelId) {
    return this.queue.run('ai-models', async () => {
      const data = await this.#read();
      const model = data.models.find((m) => m.model_id === modelId);
      if (!model) throw notFound(`模型不存在: ${modelId}`);
      if (model.builtin) throw badRequest('内置生成器不能删除');
      data.models = data.models.filter((m) => m.model_id !== modelId);
      if (data.active_model_id === modelId) data.active_model_id = BUILTIN_ID;
      await this.#write(data);
      return { deleted: modelId, active_model_id: data.active_model_id };
    });
  }

  activate(modelId) {
    return this.queue.run('ai-models', async () => {
      const data = await this.#read();
      const model = data.models.find((m) => m.model_id === modelId);
      if (!model) throw notFound(`模型不存在: ${modelId}`);
      if (!model.enabled) throw badRequest('模型已停用，不能设为当前模型');
      data.active_model_id = modelId;
      await this.#write(data);
      return publicModel(model, data.active_model_id);
    });
  }

  async #read() {
    const stored = await readJson(this.file);
    const data = stored && typeof stored === 'object' ? stored : defaultData();
    if (!Array.isArray(data.models)) data.models = [];
    if (!data.models.some((m) => m.builtin)) data.models.unshift(builtinModel());
    // 兼容 V2.0 时代写下的内置模型：补齐维护配置的缺省字段（不需要迁移脚本）
    data.models = data.models.map((m) => (m.builtin ? { ...builtinModel(), ...m, enabled: true, provider: 'local' } : m));
    const active = data.models.find((m) => m.model_id === data.active_model_id && m.enabled);
    if (!active) data.active_model_id = data.models.find((m) => m.builtin).model_id;
    return data;
  }

  async #write(data) {
    data.updated_at = now();
    await writeJsonAtomic(this.file, data);
  }
}

/** 前端可见字段：绝不返回 api_key 明文 */
export function publicModel(m, activeId) {
  const { api_key: apiKey, ...rest } = m;
  return {
    ...rest,
    has_api_key: !!apiKey,
    api_key_hint: apiKey ? `••••${String(apiKey).slice(-4)}` : '',
    active: m.model_id === activeId,
  };
}

function builtinModel() {
  return {
    model_id: BUILTIN_ID,
    name: '内置生成器',
    provider: 'local',
    model: 'local-deterministic',
    base_url: '',
    api_key: '',
    timeout_ms: 30000,
    enabled: true,
    builtin: true,
    source: 'builtin',
    generator_scope: DEFAULT_GENERATOR_SCOPE,
    generator_enabled: true,
    generator_router: true,
    rules: [...BUILTIN_RULES],
    created_at: now(),
    updated_at: now(),
  };
}

/** 内置生成器维护配置的外部视图（不含任何密钥或内部字段） */
export function publicGeneratorConfig(m) {
  const cfg = m || builtinModel();
  return {
    model_id: cfg.model_id || BUILTIN_ID,
    name: cfg.name || '内置生成器',
    scope: GENERATOR_SCOPES.includes(cfg.generator_scope) ? cfg.generator_scope : DEFAULT_GENERATOR_SCOPE,
    rules: Array.isArray(cfg.rules) ? [...cfg.rules] : [...BUILTIN_RULES],
    router_enabled: cfg.generator_router !== false,
    available_scopes: [...GENERATOR_SCOPES],
    available_rules: [...BUILTIN_RULES],
    updated_at: cfg.generator_updated_at || null,
    updated_by: cfg.generator_updated_by || null,
  };
}

function defaultData() {
  const models = [builtinModel()];
  let active = BUILTIN_ID;
  // 兼容旧用法：如果环境变量已经配置了远端模型，首次启动时作为默认模型
  const provider = process.env.AI_PROVIDER;
  if (provider && provider !== 'local' && process.env.AI_BASE_URL && process.env.AI_MODEL) {
    models.push({
      model_id: 'mdl_env',
      name: `环境变量 · ${process.env.AI_MODEL}`,
      provider: 'openai-compatible',
      model: process.env.AI_MODEL,
      base_url: process.env.AI_BASE_URL,
      api_key: process.env.AI_API_KEY || '',
      timeout_ms: Number(process.env.AI_TIMEOUT_MS || 30000),
      enabled: true,
      builtin: false,
      source: 'env',
      created_at: now(),
      updated_at: now(),
    });
    active = 'mdl_env';
  }
  return { schema_version: 1, models, active_model_id: active, updated_at: now() };
}

function normalize(input, existing) {
  const provider = existing?.builtin ? 'local' : input.provider || existing?.provider || 'openai-compatible';
  if (!PROVIDERS.includes(provider)) throw badRequest(`不支持的 provider: ${provider}`);

  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw badRequest('模型名称必填');
  if (name.length > 80) throw badRequest('模型名称不能超过 80 个字符');

  const modelName = existing?.builtin ? 'local-deterministic' : String(input.model ?? existing?.model ?? '').trim();
  let baseUrl = existing?.builtin ? '' : String(input.base_url ?? existing?.base_url ?? '').trim();

  if (provider !== 'local') {
    if (!modelName) throw badRequest('模型标识必填（例如 gpt-4o）');
    // 用户常见的几种写法都要能用：只写域名、写成完整 chat/completions 地址、末尾多斜杠。
    // 这里只做"能解析且是 http(s)"的宽松校验，真正的拼接在 provider.chatEndpoint 里统一处理。
    baseUrl = tidyBaseUrl(baseUrl);
    if (!baseUrl) throw badRequest('Base URL 必填（例如 https://api.openai.com/v1）');
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw badRequest(`Base URL 不是合法地址: ${baseUrl}`, {
        hint: '示例：https://api.openai.com/v1、https://dashscope.aliyuncs.com/compatible-mode/v1、http://127.0.0.1:11434/v1',
      });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest('Base URL 只支持 http/https');
  }

  const timeout = Number(input.timeout_ms ?? existing?.timeout_ms ?? 30000);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120000) {
    throw badRequest('超时时间必须是 1000–120000 毫秒');
  }

  let apiKey = existing?.api_key || '';
  if (existing?.builtin) apiKey = '';
  else if (input.clear_api_key === true) apiKey = '';
  else if (input.api_key !== undefined && String(input.api_key).trim() !== '') apiKey = String(input.api_key).trim();

  return {
    model_id: existing?.model_id || rid(),
    name,
    provider,
    model: modelName,
    base_url: baseUrl.replace(/\/+$/, ''),
    api_key: apiKey,
    timeout_ms: Math.round(timeout),
    enabled: existing?.builtin ? true : input.enabled === undefined ? existing?.enabled ?? true : !!input.enabled,
    builtin: !!existing?.builtin,
    source: existing?.source || 'custom',
    created_at: existing?.created_at || now(),
    updated_at: now(),
  };
}

/**
 * Base URL 归一：只去掉首尾空白与末尾斜杠，保留用户写到的路径层级。
 *  - https://host                  → 保持（provider 会补 /v1/chat/completions）
 *  - https://host/v1/              → https://host/v1
 *  - https://host/v1/chat/completions/ → https://host/v1/chat/completions
 * 判断"该不该补 /v1"放在 provider.chatEndpoint，那里才知道最终的请求路径。
 */
export function tidyBaseUrl(url) {
  let s = String(url ?? '').trim();
  if (!s) return '';
  // 允许用户直接粘贴带引号的地址
  s = s.replace(/^["'`<]+|["'`>]+$/g, '').trim();
  // 允许省略协议：api.openai.com/v1 → https://api.openai.com/v1
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(s) && !/^[a-zA-Z][\w+.-]*:\/\//.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}
