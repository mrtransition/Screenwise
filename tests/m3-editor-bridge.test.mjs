import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  M3_ERR,
} from '../apps/server/src/domain/m3/constants.js';
import {
  BridgeProtocolError,
  validateBridgeMessage,
  assertBridgeMessage,
  createBridgeSession,
  isTrustedBridgeEvent,
  isBridgeMessageWithinLimit,
} from '../apps/server/src/domain/m3/bridge.js';
import { emptyScreenDoc } from '../apps/server/src/domain/m3/convert.js';

const SCREEN = 'scr_bridge';
const doc = emptyScreenDoc({ screenId: SCREEN, title: '桥接测试' });

function message(type, payload, overrides = {}) {
  return {
    protocol: BRIDGE_PROTOCOL,
    request_id: `req_${type}`,
    screen_id: SCREEN,
    type,
    payload,
    ...overrides,
  };
}

const loadPayload = {
  doc,
  theme: { dark: false, bothModes: false, contrast: 'standard', shape: 'rounded', font: 'roboto', emphasized: false, motion: 'standard' },
  design_tokens: { colors: { primary: '#6750A4' } },
  readonly: false,
  locked: false,
  locale: 'zh',
  measurements: {},
};

const readyPayload = { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION };

test('桥接协议：宿主 load / 编辑器 ready 消息通过校验', () => {
  assert.deepEqual(validateBridgeMessage(message('load', loadPayload), { direction: 'host' }), []);
  assert.deepEqual(validateBridgeMessage(message('ready', readyPayload), { direction: 'island' }), []);
});

test('桥接协议：缺 protocol / request_id / screen_id 都拒绝', () => {
  const noProtocol = message('load', loadPayload);
  delete noProtocol.protocol;
  assert.ok(validateBridgeMessage(noProtocol).some((i) => i.path === 'message.protocol'));

  const noRequest = message('load', loadPayload);
  delete noRequest.request_id;
  assert.ok(validateBridgeMessage(noRequest).some((i) => i.path === 'message.request_id'));

  const noScreen = message('load', loadPayload);
  delete noScreen.screen_id;
  assert.ok(validateBridgeMessage(noScreen).some((i) => i.path === 'message.screen_id'));
});

test('桥接协议：方向不匹配时拒绝（编辑器消息不能当宿主消息）', () => {
  const issues = validateBridgeMessage(message('ready', readyPayload), { direction: 'host' });
  assert.ok(issues.some((i) => i.path === 'message.type' && i.code === 'ENUM'));
  assert.throws(
    () => assertBridgeMessage(message('ready', readyPayload), { direction: 'host' }),
    (err) => err instanceof BridgeProtocolError && err.code === M3_ERR.BRIDGE_PROTOCOL_MISMATCH
  );
});

test('桥接协议：load / change / save 的关键字段必填', () => {
  assert.ok(validateBridgeMessage(message('load', { ...loadPayload, readonly: 'no' }), { direction: 'host' }).some((i) => i.path.endsWith('.readonly')));
  assert.ok(validateBridgeMessage(message('load', { ...loadPayload, doc: null }), { direction: 'host' }).some((i) => i.path.endsWith('.doc')));

  const change = message('change', { doc, dirty: true, summary: '改文案', base_version: 0 });
  assert.deepEqual(validateBridgeMessage(change, { direction: 'island' }), []);
  assert.ok(validateBridgeMessage(message('change', { doc, dirty: true }), { direction: 'island' }).some((i) => i.path.endsWith('.base_version')));

  const save = message('save', { doc, base_version: 0, summary: '保存' });
  assert.deepEqual(validateBridgeMessage(save, { direction: 'island' }), []);
  assert.ok(validateBridgeMessage(message('save', { doc }), { direction: 'island' }).some((i) => i.path.endsWith('.base_version')));
});

test('桥接会话：load → ready → change → save 正常推进', async () => {
  const sent = [];
  const saved = [];
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    send: (m) => sent.push(m),
    onSave: async (input) => {
      saved.push(input);
      return { ok: true, version: input.base_version + 1 };
    },
  });

  session.load(loadPayload);
  assert.equal(session.state, 'loading');
  assert.equal(sent[0].type, 'load');
  assert.equal(sent[0].screen_id, SCREEN);

  await session.handle(message('ready', readyPayload));
  assert.equal(session.state, 'ready');

  const changePayload = { doc, dirty: true, summary: '改标题', base_version: 0 };
  await session.handle(message('change', changePayload));
  assert.equal(session.state, 'dirty');
  assert.deepEqual(session.draft, changePayload);

  const result = await session.handle(message('save', { doc, base_version: 0, summary: '保存' }));
  assert.deepEqual(result, { ok: true, version: 1 });
  assert.equal(session.state, 'saved');
  assert.equal(session.savedVersion, 1);
  assert.equal(session.draft, null);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].screen_id, SCREEN);
});

test('桥接会话：base_version 过期时 409 语义，保留本地草稿', async () => {
  let saved = 0;
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    onSave: async () => ({ ok: true, version: ++saved }),
  });

  session.load(loadPayload);
  await session.handle(message('ready', readyPayload));
  await session.handle(message('save', { doc, base_version: 0, summary: '第一次' }));

  const draft = { doc, dirty: true, summary: '第二次', base_version: 1 };
  await session.handle(message('change', draft));
  const result = await session.handle(message('save', { doc, base_version: 0, summary: '旧标签页' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, M3_ERR.BRIDGE_CONFLICT);
  assert.equal(session.state, 'conflict');
  assert.deepEqual(session.draft, draft, '冲突不得丢失本地草稿');
  assert.equal(saved, 1, '冲突时不应调用宿主保存');
});

test('桥接会话：宿主返回冲突时也保留草稿', async () => {
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    onSave: async () => ({ ok: false, code: 'CONFLICT', detail: { current_version: 3 } }),
  });
  session.load(loadPayload);
  await session.handle(message('ready', readyPayload));
  const draft = { doc, dirty: true, summary: '本地修改', base_version: 0 };
  await session.handle(message('change', draft));
  const result = await session.handle(message('save', { doc, base_version: 0, summary: '保存' }));
  assert.equal(result.ok, false);
  assert.equal(session.state, 'conflict');
  assert.deepEqual(session.draft, draft);
  assert.equal(session.error.code, M3_ERR.BRIDGE_CONFLICT);
});

test('桥接会话：超时进入 stalled，重试重发 load', () => {
  let now = 0;
  const sent = [];
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    now: () => now,
    timeoutMs: 10_000,
    send: (m) => sent.push(m),
  });

  session.load(loadPayload);
  now = 10_001;
  assert.equal(session.checkTimeout(), true);
  assert.equal(session.state, 'stalled');
  assert.equal(session.error.code, M3_ERR.BRIDGE_TIMEOUT);

  assert.equal(session.retry(), true);
  assert.equal(session.state, 'loading');
  assert.equal(sent.filter((m) => m.type === 'load').length, 2);
});

test('桥接会话：保存超时保留最后一次 change', async () => {
  let now = 0;
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    now: () => now,
    timeoutMs: 10_000,
    onSave: () => new Promise(() => {}),
  });
  session.load(loadPayload);
  await session.handle(message('ready', readyPayload));
  const draft = { doc, dirty: true, summary: '保存中', base_version: 0 };
  await session.handle(message('change', draft));
  void session.handle(message('save', { doc, base_version: 0, summary: '保存' }));
  assert.equal(session.state, 'saving');

  now = 10_001;
  assert.equal(session.checkTimeout(), true);
  assert.equal(session.state, 'stalled');
  assert.deepEqual(session.draft, draft);
});

test('桥接会话：协议版本不兼容 / screen_id 不一致都拒绝', async () => {
  const session = createBridgeSession({ screenId: SCREEN, baseVersion: 0 });
  session.load(loadPayload);
  const badVersion = await session.handle(message('ready', { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION + 1 }));
  assert.equal(badVersion.code, M3_ERR.BRIDGE_PROTOCOL_MISMATCH);
  assert.equal(session.state, 'error');

  const other = createBridgeSession({ screenId: SCREEN, baseVersion: 0 });
  other.load(loadPayload);
  const badScreen = await other.handle(message('ready', readyPayload, { screen_id: 'scr_other' }));
  assert.equal(badScreen.code, M3_ERR.BRIDGE_PROTOCOL_MISMATCH);
  assert.equal(other.state, 'error');
});

test('桥接会话：选区 / 预览 / dirty 消息', async () => {
  let preview = null;
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    onPreview: (p) => {
      preview = p;
    },
  });
  session.load(loadPayload);
  await session.handle(message('ready', readyPayload));

  await session.handle(message('select', { item_ids: ['itm_1'], group_ids: ['grp_1'] }));
  assert.deepEqual(session.selection, { item_ids: ['itm_1'], group_ids: ['grp_1'] });

  await session.handle(message('preview', { start_screen_id: SCREEN, start_item_id: 'itm_1' }));
  assert.deepEqual(preview, { start_screen_id: SCREEN, start_item_id: 'itm_1' });

  await session.handle(message('dirty', { dirty: true }));
  assert.equal(session.state, 'dirty');
  await session.handle(message('dirty', { dirty: false }));
  assert.equal(session.state, 'ready');
});

test('桥接安全：origin/source 校验与 5MB 上限', () => {
  const source = {};
  assert.equal(isTrustedBridgeEvent({ origin: 'http://127.0.0.1:8787', source }, { allowedOrigins: ['http://127.0.0.1:8787'], source }), true);
  assert.equal(isTrustedBridgeEvent({ origin: 'https://evil.example', source }, { allowedOrigins: ['http://127.0.0.1:8787'], source }), false);
  assert.equal(isTrustedBridgeEvent({ origin: 'http://127.0.0.1:8787', source: {} }, { allowedOrigins: ['http://127.0.0.1:8787'], source }), false);
  assert.equal(isTrustedBridgeEvent(null), false);

  const small = message('load', loadPayload);
  assert.equal(isBridgeMessageWithinLimit(small, 1024), true);
  assert.equal(isBridgeMessageWithinLimit(small, 10), false);
});
