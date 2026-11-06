/**
 * 宿主侧的编辑器岛接入（SRS §6.4 / FR-EDIT-018 / AC-318）
 *
 * 职责边界：
 *  - 创建 / 销毁 iframe，负责 `load` / `theme` / `mode` / `flush` 下发；
 *  - **校验** `event.origin` 与 `event.source`，拒绝来历不明的消息；
 *  - 只把编辑器的 `save` 转成宿主的 `onSave`（由宿主调用 API-018 落库）；
 *  - 超时由宿主定时器驱动 `checkTimeout`，进入 stalled 后提示重试且不丢草稿。
 *
 * 岛内不访问接口、不落库；宿主是唯一写入方（ADR 0001）。
 */

export const ISLAND_PROTOCOL = 'm3studio/editor@1';
export const ISLAND_VERSION = 1;
/** 优先级更高的桥接超时：10s（SRS §6.4） */
export const BRIDGE_TIMEOUT_MS = 10_000;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 只接受本页同源 iframe 发来的消息（AC-318 的安全要求） */
export function isTrustedIslandEvent(ev, { frameWindow = null, origin = '' } = {}) {
  if (!ev || !isObj(ev.data)) return false;
  if (ev.data.protocol !== ISLAND_PROTOCOL) return false;
  if (frameWindow && ev.source !== frameWindow) return false;
  if (origin && ev.origin !== origin) return false;
  return true;
}

/** 校验消息信封与关键字段的必填性；返回问题描述或 null */
export function validateIslandMessage(msg) {
  if (!isObj(msg)) return '消息必须是对象';
  if (msg.protocol !== ISLAND_PROTOCOL) return '协议标识不匹配';
  if (!msg.request_id || typeof msg.request_id !== 'string') return '缺少 request_id';
  if (!msg.screen_id || typeof msg.screen_id !== 'string') return '缺少 screen_id';
  const types = ['ready', 'change', 'save', 'select', 'preview', 'error', 'dirty'];
  if (!types.includes(msg.type)) return `未知消息类型: ${msg.type}`;
  const p = msg.payload;
  if (msg.type === 'save' || msg.type === 'change') {
    if (!isObj(p) || !isObj(p.doc)) return '缺少 doc';
    if (!Number.isInteger(p.base_version)) return '缺少整数 base_version';
  }
  return null;
}

/**
 * 挂载编辑器岛。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container iframe 挂载点
 * @param {string} opts.screenId
 * @param {object} opts.doc 初始 ScreenDoc
 * @param {object} opts.theme
 * @param {number} opts.baseVersion
 * @param {boolean} opts.readonly
 * @param {boolean} opts.locked
 * @param {(input: {doc, base_version, summary, screen_id}) => Promise<{ok:boolean, version?:number, code?:string, detail?:object}>} opts.onSave
 * @param {(doc: object, info: object) => void} [opts.onChange] 草稿变化（宿主只缓存，不落库）
 * @param {(err: object) => void} [opts.onError]
 * @param {string} [opts.src='/src/island.html']
 */
export function mountIsland(opts) {
  const {
    container,
    screenId,
    doc,
    theme = {},
    baseVersion = 0,
    readonly = false,
    locked = false,
    onSave,
    onChange,
    onError,
    onReady,
    src = '/src/island.html',
  } = opts;

  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.className = 'island-frame';
  iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
  iframe.setAttribute('data-screen-id', screenId);
  iframe.style.cssText = 'width:100%;height:100%;border:0;background:#eef1f6';
  container.appendChild(iframe);

  /** 一次性保存回调（宿主在切屏时等待提交完成） */
  let savedOnce = null;
  const state = {
    screenId,
    baseVersion,
    readonly,
    locked,
    ready: false,
    loadSent: false,
    savedDraft: null,
    lastError: null,
    disposed: false,
  };

  const send = (type, payload) => {
    if (state.disposed) return;
    iframe.contentWindow?.postMessage(
      { protocol: ISLAND_PROTOCOL, request_id: `${screenId}:${type}:${Date.now()}`, screen_id: screenId, type, payload },
      window.location.origin
    );
  };

  // `echo`：宿主主动重新下发同一份文档（不推进版本、不清草稿），用于主题切换/外部回灌。
  // 不用 load，是因为 load 会重建岛内编辑态，导致正在进行的就地编辑被打断。
  const loadPayload = () => ({ doc: state.savedDraft?.doc ?? doc, theme, readonly: state.readonly, locked: state.locked, base_version: state.baseVersion, echo: false });
  const reloadBase = (nextDoc) => {
    if (isObj(nextDoc)) {
      iframe.contentWindow?.postMessage(
        { protocol: ISLAND_PROTOCOL, request_id: `${screenId}:echo:${Date.now()}`, screen_id: screenId, type: 'load', payload: { ...loadPayload(), doc: nextDoc, echo: true } },
        window.location.origin
      );
    }
  };
  const reload = () => {
    state.loadSent = true;
    send('load', loadPayload());
  };

  const handle = async (msg) => {
    switch (msg.type) {
      case 'ready':
        // 只在首次就绪时下发 load，避免「ready → load → ready」回环
        if (!state.ready) {
          state.ready = true;
          reload();
          onReady?.();
        }
        break;
      case 'change':
      case 'dirty':
        // 宿主只缓存草稿，不落库（协议：宿主不立即写版本）
        if (isObj(msg.payload?.doc)) state.savedDraft = msg.payload;
        onChange?.(msg.payload?.doc, { dirty: !!msg.payload?.dirty, summary: msg.payload?.summary });
        break;
      case 'save': {
        const payload = msg.payload;
        if (!onSave) break;
        let result;
        try {
          result = await onSave({ ...payload, screen_id: screenId });
        } catch (err) {
          result = { ok: false, code: err?.code || 'SAVE_FAILED', message: err?.message, detail: err?.detail };
        }
        if (result?.ok) {
          state.baseVersion = result.version;
          state.savedDraft = null;
          const cb = savedOnce;
          savedOnce = null;
          cb?.();
        }
        send('save-result', { ok: !!result?.ok, version: result?.version, code: result?.code, message: result?.message });
        if (!result?.ok) {
          state.lastError = result;
          onError?.(result);
        }
        break;
      }
      case 'error':
        state.lastError = msg.payload;
        onError?.(msg.payload);
        break;
      default:
        break;
    }
  };

  const onMessage = (ev) => {
    if (state.disposed) return;
    if (!isTrustedIslandEvent(ev, { frameWindow: iframe.contentWindow, origin: window.location.origin })) return;
    const bad = validateIslandMessage(ev.data);
    if (bad) {
      state.lastError = { code: 'BRIDGE_PROTOCOL_MISMATCH', message: bad };
      onError?.(state.lastError);
      return;
    }
    if (ev.data.screen_id !== screenId) return;
    handle(ev.data).catch((err) => onError?.({ message: err?.message }));
  };
  window.addEventListener('message', onMessage);

  // 宿主侧定时器：10s 内没有 ready 就提示重试（AC-318）
  let readyTimer = null;
  const startReadyTimer = () => {
    readyTimer = setTimeout(() => {
      if (state.ready || state.disposed) return;
      state.lastError = { code: 'EDITOR_BRIDGE_TIMEOUT', message: '编辑器加载超时' };
      onError?.(state.lastError);
    }, BRIDGE_TIMEOUT_MS);
  };

  iframe.addEventListener('load', () => {
    if (state.disposed) return;
    // 岛会在就绪后主动发 ready 并触发 load；这里再做一次幂等兜底，
    // 只对「尚未 ready」的岛下发，避免重复 load 打断正在进行的地编辑。
    if (!state.ready && !state.loadSent) reload();
    startReadyTimer();
  });
  iframe.src = src;

  return {
    get screenId() {
      return state.screenId;
    },
    get ready() {
      return state.ready;
    },
    /** iframe 是否仍挂在文档里（面板重渲染会把 iframe 连根移除） */
    get mounted() {
      return !state.disposed && !!iframe.isConnected;
    },
    get baseVersion() {
      return state.baseVersion;
    },
    get draft() {
      return state.savedDraft;
    },
    /** 注册一次性的“保存成功”回调（宿主切屏等待提交用） */
    onSavedOnce(cb) {
      savedOnce = typeof cb === 'function' ? cb : null;
      return () => {
        savedOnce = null;
      };
    },
    setMode({ readonly: ro = state.readonly, locked: lk = state.locked }) {
      state.readonly = ro;
      state.locked = lk;
      send('mode', { readonly: ro, locked: lk });
    },
    /** 宿主侧改动了草稿（如 Tidy）后回灌岛内，保持两侧同源 */
    reloadDraft(nextDoc) {
      if (isObj(nextDoc)) state.savedDraft = { doc: nextDoc, dirty: true };
      state.baseVersion = state.baseVersion;
      reloadBase(nextDoc ?? state.savedDraft?.doc);
    },
    setTheme(next) {
      send('theme', { theme: next });
    },
    /** 离开屏幕/切换屏幕前调用：请求岛立即提交未保存变更 */
    flush() {
      send('flush', {});
    },
    /** 重试：重新下发 load，岛内草稿不丢 */
    retry() {
      state.ready = false;
      iframe.contentWindow?.postMessage(
        { protocol: ISLAND_PROTOCOL, request_id: `${screenId}:load:${Date.now()}`, screen_id: screenId, type: 'load', payload: loadPayload() },
        window.location.origin
      );
      startReadyTimer();
    },
    dispose() {
      state.disposed = true;
      clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}
