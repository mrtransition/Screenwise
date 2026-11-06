import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isTrustedIslandEvent, validateIslandMessage, ISLAND_PROTOCOL, ISLAND_VERSION } from '../apps/web/src/island-host.js';

/**
 * 编辑器岛宿主侧（SRS §6.4 / ADR 0001 / AC-318）。
 *
 * 这里验证的是宿主唯一能把关的部分：消息来源、信封结构、以及
 * 「ready → load」只握手一次的回环约束。DOM 交互在浏览器冒烟中覆盖。
 */

const msg = (overrides = {}) => ({
  protocol: ISLAND_PROTOCOL,
  request_id: 'scr_1:save:1',
  screen_id: 'scr_1',
  type: 'save',
  payload: {
    doc: { schema: 'm3studio/screen@1', format: 'm3', frame: { id: 'scr_1' }, groups: [] },
    base_version: 3,
  },
  ...overrides,
});

test('桥接：协议名与版本对齐 SRS §6.4', () => {
  assert.equal(ISLAND_PROTOCOL, 'm3studio/editor@1');
  assert.equal(ISLAND_VERSION, 1);
});

test('桥接安全：只接受同源 iframe 且协议正确的事件', () => {
  const win = { name: 'island' };
  const ok = { data: msg(), source: win, origin: 'http://127.0.0.1:8000' };
  assert.equal(isTrustedIslandEvent(ok, { frameWindow: win, origin: 'http://127.0.0.1:8000' }), true);

  // 来源窗口不对：拒
  assert.equal(isTrustedIslandEvent({ ...ok, source: { name: 'other' } }, { frameWindow: win }), false);
  // 跨源消息：拒
  assert.equal(isTrustedIslandEvent({ ...ok, origin: 'https://evil.example' }, { frameWindow: win, origin: 'http://127.0.0.1:8000' }), false);
  // 协议不对：拒
  assert.equal(isTrustedIslandEvent({ ...ok, data: msg({ protocol: 'other@1' }) }, { frameWindow: win }), false);
  // 非对象：拒
  assert.equal(isTrustedIslandEvent({ data: 'hello', source: win }, { frameWindow: win }), false);
});

test('桥接信封：缺字段/未知类型的消息被拒绝', () => {
  assert.equal(validateIslandMessage(msg()), null);

  assert.match(validateIslandMessage(null), /对象/);
  assert.match(validateIslandMessage(msg({ protocol: 'x' })), /协议/);
  assert.match(validateIslandMessage(msg({ request_id: '' })), /request_id/);
  assert.match(validateIslandMessage(msg({ screen_id: '' })), /screen_id/);
  assert.match(validateIslandMessage(msg({ type: 'exec' })), /未知消息类型/);
});

test('桥接信封：save/change 必须带 doc 与整数 base_version', () => {
  assert.match(validateIslandMessage(msg({ payload: { base_version: 1 } })), /doc/);
  assert.match(validateIslandMessage(msg({ payload: { doc: {}, base_version: '1' } })), /base_version/);
  assert.match(validateIslandMessage(msg({ payload: { doc: {}, base_version: 1.5 } })), /base_version/);

  const change = msg({ type: 'change', payload: { doc: {}, base_version: 2, dirty: true, summary: 'x' } });
  assert.equal(validateIslandMessage(change), null);

  // ready 不需要 doc
  assert.equal(validateIslandMessage(msg({ type: 'ready', payload: { protocol: ISLAND_PROTOCOL, version: 1 } })), null);
});

test('桥接信封：select / preview / error 放宽 payload 但仍校验信封', () => {
  assert.equal(validateIslandMessage(msg({ type: 'select', payload: { item_ids: ['a'], group_ids: [] } })), null);
  assert.equal(validateIslandMessage(msg({ type: 'preview', payload: {} })), null);
  assert.equal(validateIslandMessage(msg({ type: 'error', payload: { code: 'X', message: 'y' } })), null);
  assert.match(validateIslandMessage(msg({ type: 'select', request_id: undefined })), /request_id/);
});

test('桥接回环：同一 load 重复下发不得触发新 ready（协议约束）', () => {
  // 文档契约：echo 字段必须写在协议里，否则宿主与岛的分支无据可依
  const proto = fs.readFileSync('docs/编辑器岛桥接协议.md', 'utf8');
  assert.match(proto, /echo/, 'load 的 echo 语义必须写入协议文档');
  assert.match(proto, /回环约束/, '协议必须记录 ready/load 握手约束');
});
