/**
 * 编辑器岛桥接协议 v1（M0 spike）
 *
 * 这里只实现“协议 + 状态机 + 安全校验”，不绑定浏览器：
 *  - 宿主负责 postMessage / origin 校验 / 落库；
 *  - 编辑器岛不直接访问 API；
 *  - 超时、协议不兼容、base_version 冲突都有确定状态，草稿不丢。
 */

import { BRIDGE_PROTOCOL, BRIDGE_VERSION, M3_ERR } from './constants.js';

export const HOST_MESSAGE_TYPES = Object.freeze(['load', 'theme', 'mode', 'flush', 'fit', 'preview']);
export const ISLAND_MESSAGE_TYPES = Object.freeze(['ready', 'change', 'save', 'select', 'preview', 'error', 'dirty']);
export const BRIDGE_STATES = Object.freeze([
  'idle',
  'loading',
  'ready',
  'dirty',
  'saving',
  'saved',
  'conflict',
  'stalled',
  'error',
  'closed',
]);

const HOST_SET = new Set(HOST_MESSAGE_TYPES);
const ISLAND_SET = new Set(ISLAND_MESSAGE_TYPES);

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => isStr(v) && v.length > 0;
const isBool = (v) => typeof v === 'boolean';
const isInt = (v) => Number.isInteger(v);

const issue = (path, code, message) => ({ path, code, message });

export class BridgeProtocolError extends Error {
  constructor(issues, code = M3_ERR.BRIDGE_PROTOCOL_MISMATCH) {
    const first = issues[0];
    super(`${code}: ${first ? `${first.path} ${first.message}` : 'invalid message'}`);
    this.name = 'BridgeProtocolError';
    this.code = code;
    this.issues = issues;
  }
}

function validatePayload(type, payload, path = 'payload') {
  const out = [];
  const need = (key, ok, msg) => {
    if (!ok(payload?.[key])) out.push(issue(`${path}.${key}`, 'TYPE', msg));
  };
  const p = isObj(payload) ? payload : {};

  switch (type) {
    case 'load':
      if (!isObj(p.doc)) out.push(issue(`${path}.doc`, 'TYPE', '必须是 ScreenDoc 对象'));
      if (!isObj(p.theme)) out.push(issue(`${path}.theme`, 'TYPE', '必须是主题对象'));
      need('readonly', isBool, '必须是布尔值');
      need('locked', isBool, '必须是布尔值');
      if (p.locale !== undefined && !isStr(p.locale)) out.push(issue(`${path}.locale`, 'TYPE', '必须是字符串'));
      if (p.design_tokens !== undefined && !isObj(p.design_tokens)) {
        out.push(issue(`${path}.design_tokens`, 'TYPE', '必须是对象'));
      }
      if (p.measurements !== undefined && !isObj(p.measurements)) {
        out.push(issue(`${path}.measurements`, 'TYPE', '必须是对象'));
      }
      break;
    case 'theme':
      if (!isObj(p.theme)) out.push(issue(`${path}.theme`, 'TYPE', '必须是主题对象'));
      if (p.design_tokens !== undefined && !isObj(p.design_tokens)) {
        out.push(issue(`${path}.design_tokens`, 'TYPE', '必须是对象'));
      }
      break;
    case 'mode':
      need('readonly', isBool, '必须是布尔值');
      need('locked', isBool, '必须是布尔值');
      break;
    case 'flush':
    case 'fit':
      break;
    case 'preview':
      if (p.startItemId !== undefined && !isStr(p.startItemId)) {
        out.push(issue(`${path}.startItemId`, 'TYPE', '必须是字符串'));
      }
      if (p.start_screen_id !== undefined && !isStr(p.start_screen_id)) {
        out.push(issue(`${path}.start_screen_id`, 'TYPE', '必须是字符串'));
      }
      if (p.start_item_id !== undefined && !isStr(p.start_item_id)) {
        out.push(issue(`${path}.start_item_id`, 'TYPE', '必须是字符串'));
      }
      break;
    case 'ready':
      if (p.protocol !== BRIDGE_PROTOCOL) {
        out.push(issue(`${path}.protocol`, 'PROTOCOL', `必须是 ${BRIDGE_PROTOCOL}`));
      }
      if (!isInt(p.version)) out.push(issue(`${path}.version`, 'TYPE', '必须是整数'));
      break;
    case 'change':
      if (!isObj(p.doc)) out.push(issue(`${path}.doc`, 'TYPE', '必须是 ScreenDoc 对象'));
      need('dirty', isBool, '必须是布尔值');
      if (p.summary !== undefined && !isStr(p.summary)) out.push(issue(`${path}.summary`, 'TYPE', '必须是字符串'));
      need('base_version', isInt, '必须是整数');
      break;
    case 'save':
      if (!isObj(p.doc)) out.push(issue(`${path}.doc`, 'TYPE', '必须是 ScreenDoc 对象'));
      need('base_version', isInt, '必须是整数');
      if (p.summary !== undefined && !isStr(p.summary)) out.push(issue(`${path}.summary`, 'TYPE', '必须是字符串'));
      break;
    case 'select':
      for (const key of ['item_ids', 'group_ids']) {
        if (p[key] !== undefined && (!Array.isArray(p[key]) || !p[key].every(isStr))) {
          out.push(issue(`${path}.${key}`, 'TYPE', '必须是字符串数组'));
        }
      }
      break;
    case 'error':
      need('code', isNonEmptyStr, '必须是非空字符串');
      need('message', isStr, '必须是字符串');
      break;
    case 'dirty':
      need('dirty', isBool, '必须是布尔值');
      break;
  }
  return out;
}

/**
 * 校验一条桥接消息。
 * @param {unknown} message
 * @param {{direction?: 'host'|'island'|'any'}} [opts]
 */
export function validateBridgeMessage(message, opts = {}) {
  const direction = opts.direction ?? 'any';
  const out = [];
  if (!isObj(message)) return [issue('message', 'TYPE', '必须是对象')];

  if (message.protocol !== BRIDGE_PROTOCOL) {
    out.push(issue('message.protocol', 'PROTOCOL', `必须是 ${BRIDGE_PROTOCOL}`));
  }
  if (!isNonEmptyStr(message.request_id)) {
    out.push(issue('message.request_id', 'REQUIRED', '必须是非空字符串'));
  }
  if (!isNonEmptyStr(message.screen_id)) {
    out.push(issue('message.screen_id', 'REQUIRED', '必须是非空字符串'));
  }

  const allowed = direction === 'host' ? HOST_SET : direction === 'island' ? ISLAND_SET : new Set([...HOST_SET, ...ISLAND_SET]);
  if (!allowed.has(message.type)) {
    out.push(issue('message.type', 'ENUM', `在当前方向下必须是 ${[...allowed].join(' / ')} 之一`));
  } else {
    out.push(...validatePayload(message.type, message.payload, 'message.payload'));
  }

  return out;
}

export function assertBridgeMessage(message, opts = {}) {
  const issues = validateBridgeMessage(message, opts);
  if (issues.length) throw new BridgeProtocolError(issues);
  return message;
}

/** 消息体大小上限（默认 5MB，SRS 6.4） */
export function isBridgeMessageWithinLimit(message, maxBytes = 5 * 1024 * 1024) {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).length <= maxBytes;
  } catch {
    return false;
  }
}

/** 宿主侧 origin/source 校验 */
export function isTrustedBridgeEvent(event, { allowedOrigins = [], source = null } = {}) {
  if (!event || typeof event !== 'object') return false;
  if (!isStr(event.origin)) return false;
  if (allowedOrigins.length && !allowedOrigins.includes(event.origin)) return false;
  if (source && event.source !== source) return false;
  return true;
}

/**
 * 宿主侧会话状态机。`send` 注入实际传输（postMessage），便于测试。
 *
 * @param {{
 *   screenId: string,
 *   baseVersion: number,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   send?: (message: object) => void,
 *   onSave?: (input: {doc: object, base_version: number, summary?: string, screen_id: string}) => ({ok: boolean, version?: number, code?: string, detail?: object} | Promise<...>),
 *   onPreview?: (input: {start_screen_id: string, start_item_id?: string}) => void,
 *   onError?: (error: {code: string, message: string, detail?: object}) => void,
 * }} options
 */
export function createBridgeSession(options = {}) {
  const screenId = options.screenId;
  if (!isNonEmptyStr(screenId)) throw new Error('createBridgeSession 需要 screenId');
  let savedVersion = Number.isInteger(options.baseVersion) ? options.baseVersion : 0;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const send = options.send ?? (() => {});
  const onSave = options.onSave;
  const onPreview = options.onPreview;
  const onError = options.onError;

  let state = 'idle';
  let lastLoad = null;
  let lastChange = null;
  let selection = { item_ids: [], group_ids: [] };
  let lastSeenAt = now();
  let lastSentAt = 0;
  let pendingSince = 0;
  let lastError = null;
  let seq = 0;

  const requestId = (type) => `${screenId}:${type}:${++seq}`;

  const emit = (type, payload) => {
    const message = {
      protocol: BRIDGE_PROTOCOL,
      request_id: requestId(type),
      screen_id: screenId,
      type,
      payload,
    };
    lastSentAt = now();
    send(message);
    return message;
  };

  const fail = (code, message, detail) => {
    state = 'error';
    lastError = { code, message, ...(detail ? { detail } : {}) };
    if (onError) onError(lastError);
    return lastError;
  };

  const session = {
    get screenId() {
      return screenId;
    },
    get state() {
      return state;
    },
    get savedVersion() {
      return savedVersion;
    },
    get draft() {
      return lastChange;
    },
    get selection() {
      return selection;
    },
    get error() {
      return lastError;
    },
    get lastSentAt() {
      return lastSentAt;
    },

    load(payload) {
      lastLoad = payload;
      state = 'loading';
      lastError = null;
      lastSeenAt = now();
      pendingSince = now();
      return emit('load', payload);
    },

    setTheme(payload) {
      return emit('theme', payload);
    },

    setMode(payload) {
      return emit('mode', payload);
    },

    flush() {
      return emit('flush', {});
    },

    fit() {
      return emit('fit', {});
    },

    preview(startItemId) {
      return emit('preview', startItemId ? { startItemId } : {});
    },

    /** 处理来自编辑器岛的消息；返回保存结果（若为 save） */
    async handle(message) {
      assertBridgeMessage(message, { direction: 'island' });
      if (message.screen_id !== screenId) {
        return fail(M3_ERR.BRIDGE_PROTOCOL_MISMATCH, '消息 screen_id 与会话不一致', {
          expected: screenId,
          actual: message.screen_id,
        });
      }
      lastSeenAt = now();

      switch (message.type) {
        case 'ready':
          if (message.payload.version !== BRIDGE_VERSION) {
            return fail(M3_ERR.BRIDGE_PROTOCOL_MISMATCH, '编辑器协议版本不兼容', {
              expected: BRIDGE_VERSION,
              actual: message.payload.version,
            });
          }
          if (state === 'loading' || state === 'stalled') state = 'ready';
          return { ok: true, state };

        case 'change':
          lastChange = message.payload;
          state = message.payload.dirty ? 'dirty' : 'ready';
          return { ok: true, state };

        case 'dirty':
          state = message.payload.dirty ? 'dirty' : 'ready';
          return { ok: true, state };

        case 'select':
          selection = {
            item_ids: message.payload.item_ids ?? [],
            group_ids: message.payload.group_ids ?? [],
          };
          return { ok: true, selection };

        case 'preview':
          if (onPreview) onPreview(message.payload);
          return { ok: true, payload: message.payload };

        case 'error':
          return fail(message.payload.code, message.payload.message, message.payload.detail);

        case 'save': {
          const { doc, base_version, summary } = message.payload;
          if (!onSave) return fail(M3_ERR.BRIDGE_PROTOCOL_MISMATCH, '宿主未提供 onSave');
          if (base_version !== savedVersion) {
            state = 'conflict';
            lastError = {
              code: M3_ERR.BRIDGE_CONFLICT,
              message: '版本已前进，拒绝覆盖',
              detail: { base_version, current_version: savedVersion },
            };
            if (onError) onError(lastError);
            return { ok: false, code: M3_ERR.BRIDGE_CONFLICT, current_version: savedVersion };
          }
          state = 'saving';
          pendingSince = now();
          let result;
          try {
            result = await onSave({ doc, base_version, summary, screen_id: screenId });
          } catch (err) {
            state = 'error';
            lastError = { code: M3_ERR.BRIDGE_SAVE_FAILED, message: '保存失败', detail: { message: err?.message } };
            if (onError) onError(lastError);
            return { ok: false, code: M3_ERR.BRIDGE_SAVE_FAILED, message: '保存失败', detail: { message: err?.message } };
          }
          if (result?.ok) {
            savedVersion = Number.isInteger(result.version) ? result.version : savedVersion + 1;
            lastChange = null;
            state = 'saved';
            return { ok: true, version: savedVersion };
          }
          if (result?.code === M3_ERR.BRIDGE_CONFLICT || result?.code === 'CONFLICT') {
            state = 'conflict';
            lastError = {
              code: M3_ERR.BRIDGE_CONFLICT,
              message: '版本已前进，拒绝覆盖',
              detail: result.detail ?? { base_version, current_version: savedVersion },
            };
            if (onError) onError(lastError);
            return { ok: false, code: M3_ERR.BRIDGE_CONFLICT, current_version: savedVersion };
          }
          state = 'error';
          lastError = { code: result?.code ?? M3_ERR.BRIDGE_SAVE_FAILED, message: result?.message ?? '保存失败', detail: result?.detail };
          if (onError) onError(lastError);
          return { ok: false, code: result?.code ?? M3_ERR.BRIDGE_SAVE_FAILED, message: result?.message ?? '保存失败', detail: result?.detail };
        }

        default:
          return fail(M3_ERR.BRIDGE_PROTOCOL_MISMATCH, `未知消息类型: ${message.type}`);
      }
    },

    /** 由宿主定时器调用；超时不丢最后一次 change */
    checkTimeout(at = now()) {
      if ((state === 'loading' || state === 'saving') && at - pendingSince > timeoutMs) {
        state = 'stalled';
        lastError = {
          code: M3_ERR.BRIDGE_TIMEOUT,
          message: '编辑器桥接超时，请重试',
          detail: { timeout_ms: timeoutMs, has_draft: !!lastChange },
        };
        if (onError) onError(lastError);
        return true;
      }
      return false;
    },

    /** 超时后重发 load；本地草稿保留 */
    retry() {
      if (state !== 'stalled') return false;
      if (!lastLoad) return false;
      state = 'loading';
      lastSeenAt = now();
      pendingSince = now();
      emit('load', lastLoad);
      return true;
    },

    close() {
      state = 'closed';
    },
  };

  return session;
}
