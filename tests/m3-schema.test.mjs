import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCREEN_SCHEMA,
  PROJECT_SCHEMA,
  FLOW_SCHEMA_VERSION,
  KINDS,
  DEFAULT_THEME,
} from '../apps/server/src/domain/m3/constants.js';
import {
  M3SchemaError,
  normalizeTheme,
  normalizeProjectDesign,
  validateTheme,
  validateItem,
  validateScreenDoc,
  assertScreenDoc,
  validateProjectDesign,
  validateM3eDoc,
  validateFlowEdge,
  validateFlow,
  validateVersionSnapshot,
} from '../apps/server/src/domain/m3/schema.js';
import { emptyScreenDoc, emptyFlow } from '../apps/server/src/domain/m3/convert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/m3e-sample.json'), 'utf8'));

function item(overrides = {}) {
  return { id: 'itm_1', kind: 'button', label: '确定', icon: 'check', variant: 'filled', ...overrides };
}

function screenDoc(overrides = {}) {
  return {
    schema: SCREEN_SCHEMA,
    format: 'm3',
    frame: { id: 'scr_1', name: '首页', x: 0, y: 0, w: 412, h: 892 },
    groups: [{ id: 'grp_1', x: 16, y: 16, axis: 'y', items: [item()] }],
    ...overrides,
  };
}

test('M3 schema：合法 ScreenDoc 通过，空屏也可通过', () => {
  assert.deepEqual(validateScreenDoc(screenDoc()), []);
  assert.deepEqual(validateScreenDoc(emptyScreenDoc({ screenId: 'scr_empty' })), []);
});

test('M3 schema：schema / format / kind / 坐标错误都带路径', () => {
  const missing = validateScreenDoc(screenDoc({ schema: 'x' }));
  assert.ok(missing.some((i) => i.path === 'doc.schema' && i.code === 'SCHEMA'));

  const badFormat = validateScreenDoc(screenDoc({ format: 'node-tree' }));
  assert.ok(badFormat.some((i) => i.path === 'doc.format'));

  const badKind = validateScreenDoc(
    screenDoc({ groups: [{ id: 'g', x: 0, y: 0, axis: 'y', items: [item({ kind: 'carousel3d' })] }] })
  );
  assert.ok(badKind.some((i) => i.path.endsWith('.kind') && i.code === 'ENUM'));

  const local = validateScreenDoc(screenDoc({ frame: { id: 'scr_1', name: '首页', x: 12, y: 8, w: 412, h: 892 } }));
  assert.ok(local.some((i) => i.path === 'doc.frame.x' && i.code === 'LOCAL_COORD'));
  assert.ok(local.some((i) => i.path === 'doc.frame.y' && i.code === 'LOCAL_COORD'));
});

test('M3 schema：DC-017 禁止 ScreenDoc 持久化 action/actions/frame.swipe', () => {
  const withAction = screenDoc({
    groups: [{ id: 'g', x: 0, y: 0, axis: 'y', items: [item({ action: { to: 'scr_2', transition: 'slide' } })] }],
  });
  assert.ok(validateScreenDoc(withAction).some((i) => i.code === 'ACTION_NOT_ALLOWED' && i.path.endsWith('.action')));

  const withActions = screenDoc({
    groups: [{ id: 'g', x: 0, y: 0, axis: 'y', items: [item({ actions: { icon2: { to: 'scr_2', transition: 'fade' } } })] }],
  });
  assert.ok(validateScreenDoc(withActions).some((i) => i.code === 'ACTION_NOT_ALLOWED' && i.path.endsWith('.actions')));

  const withSwipe = screenDoc({
    frame: { id: 'scr_1', name: '首页', x: 0, y: 0, w: 412, h: 892, swipe: { left: 'scr_2' } },
  });
  assert.ok(validateScreenDoc(withSwipe).some((i) => i.code === 'ACTION_NOT_ALLOWED' && i.path === 'doc.frame.swipe'));
});

test('M3 schema：Item id 屏内唯一，Group id 屏内唯一', () => {
  const dupItem = screenDoc({
    groups: [
      { id: 'g1', x: 0, y: 0, axis: 'y', items: [item({ id: 'same' })] },
      { id: 'g2', x: 0, y: 100, axis: 'y', items: [item({ id: 'same' })] },
    ],
  });
  assert.ok(validateScreenDoc(dupItem).some((i) => i.code === 'DUPLICATE' && i.path.endsWith('.id')));

  const dupGroup = screenDoc({
    groups: [
      { id: 'same', x: 0, y: 0, axis: 'y', items: [item()] },
      { id: 'same', x: 0, y: 100, axis: 'y', items: [item({ id: 'itm_2' })] },
    ],
  });
  assert.ok(validateScreenDoc(dupGroup).some((i) => i.code === 'DUPLICATE'));
});

test('M3 schema：assert 抛 M3SchemaError，保留 issues', () => {
  assert.throws(
    () => assertScreenDoc(screenDoc({ schema: 'bad' })),
    (err) => err instanceof M3SchemaError && err.code === 'SCHEMA_INVALID' && err.issues.length > 0
  );
});

test('M3 schema：主题归一化与校验', () => {
  assert.deepEqual(normalizeTheme(undefined), { ...DEFAULT_THEME });
  const normalized = normalizeTheme({ dark: 'yes', shape: 'blob', font: 'robotoSerif', motion: 'expressive' });
  assert.equal(normalized.dark, false);
  assert.equal(normalized.shape, 'rounded');
  assert.equal(normalized.font, 'robotoSerif');
  assert.equal(normalized.motion, 'expressive');
  assert.deepEqual(validateTheme(normalized), []);
  assert.ok(validateTheme({ ...DEFAULT_THEME, contrast: 'extreme' }).some((i) => i.path === 'theme.contrast'));
});

test('M3 schema：ProjectDesign 归一化与校验', () => {
  const d = normalizeProjectDesign({ title: '食谱', platform: 'web', theme: { dark: true } });
  assert.equal(d.platform, 'web');
  assert.equal(d.theme.dark, true);
  assert.equal(d.paletteKey, 'purple');
  assert.deepEqual(validateProjectDesign(d), []);
  assert.ok(validateProjectDesign({ ...d, platform: 'ios' }).some((i) => i.path === 'design.platform'));
});

test('M3 schema：M3E Doc 允许 action/swipe，但拒绝重复 frame id 与非法 kind', () => {
  assert.deepEqual(validateM3eDoc(fixture), []);
  assert.equal(fixture.frames.length, 3);

  const dupFrame = structuredClone(fixture);
  dupFrame.frames[1].id = dupFrame.frames[0].id;
  assert.ok(validateM3eDoc(dupFrame).some((i) => i.code === 'DUPLICATE' && i.path.includes('.frames[')));

  const badKind = structuredClone(fixture);
  badKind.groups[0].items[0].kind = 'unknownPart';
  assert.ok(validateM3eDoc(badKind).some((i) => i.code === 'ENUM' && i.path.endsWith('.kind')));
});

test('M3 schema：Item 字段枚举与范围校验', () => {
  assert.deepEqual(validateItem(item()), []);
  assert.ok(validateItem(item({ variant: 'glass' })).some((i) => i.path.endsWith('.variant')));
  assert.ok(validateItem(item({ fill: '#fff' })).some((i) => i.path.endsWith('.fill')));
  assert.ok(validateItem(item({ value: 120 })).some((i) => i.path.endsWith('.value')));
  assert.ok(validateItem(item({ checked: 'yes' })).some((i) => i.path.endsWith('.checked')));
  assert.ok(validateItem(item({ tabs: [{ icon: 1, label: 'x' }] })).some((i) => i.path.includes('.tabs')));
  assert.ok(validateItem(item({ corners: { tl: 1, tr: 2, bl: 3 } })).some((i) => i.path.endsWith('.corners.br')));
});

test('M3 schema：FlowEdge / Flow 校验（V4.1 trigger / direction / expires_at）', () => {
  const edge = {
    edge_id: 'edg_1',
    source_screen_id: 'scr_1',
    source_item_id: 'itm_1',
    source_slot: null,
    target_kind: 'screen',
    target_screen_id: 'scr_2',
    url: null,
    trigger: 'click',
    direction: null,
    transition: 'slide',
    note: '',
    status: 'confirmed',
    expires_at: null,
    created_at: '2026-11-05T00:00:00.000Z',
    created_by: 'local-user',
  };
  assert.deepEqual(validateFlowEdge(edge), []);
  assert.ok(validateFlowEdge({ ...edge, target_kind: 'screen', target_screen_id: null }).some((i) => i.path.endsWith('.target_screen_id')));
  assert.ok(validateFlowEdge({ ...edge, target_kind: 'link', url: null }).some((i) => i.path.endsWith('.url')));
  assert.ok(validateFlowEdge({ ...edge, trigger: 'hover' }).some((i) => i.path.endsWith('.trigger')));
  assert.ok(validateFlowEdge({ ...edge, trigger: 'menu' }).some((i) => i.path.endsWith('.trigger')), 'menu 已不属于 trigger');

  const swipe = { ...edge, trigger: 'swipe', direction: 'left' };
  assert.deepEqual(validateFlowEdge(swipe), []);
  assert.ok(validateFlowEdge({ ...swipe, direction: null }).some((i) => i.path.endsWith('.direction')));
  assert.ok(validateFlowEdge({ ...swipe, direction: 'diagonal' }).some((i) => i.path.endsWith('.direction')));
  assert.ok(validateFlowEdge({ ...edge, expires_at: 'not-a-date' }).some((i) => i.path.endsWith('.expires_at')));
  assert.ok(
    validateFlowEdge({ ...edge, orphan: { item_missing: true } }).some((i) => i.code === 'ORPHAN_NOT_ALLOWED'),
    'orphan 不得持久化'
  );

  const flow = { schema_version: FLOW_SCHEMA_VERSION, edges: [edge] };
  assert.deepEqual(validateFlow(flow), []);
  assert.ok(validateFlow({ schema_version: 1, edges: [] }).some((i) => i.path.endsWith('.schema_version')));
  assert.ok(validateFlow({ schema_version: FLOW_SCHEMA_VERSION, edges: [edge, edge] }).some((i) => i.code === 'DUPLICATE'));
  assert.deepEqual(emptyFlow(), { schema_version: FLOW_SCHEMA_VERSION, edges: [] });
});

test('M3 schema：Group.axis="free" 与 Item.pos 规则（DC-036）', () => {
  const freeGroup = {
    id: 'grp_free',
    x: 0,
    y: 400,
    axis: 'free',
    name: '自由组',
    locked: false,
    hidden: false,
    pos: { x: 0, y: 400 },
    items: [item({ id: 'itm_fab', kind: 'fab', pos: { x: 344, y: 720 } })],
  };
  const freeDoc = screenDoc({ groups: [freeGroup] });
  assert.deepEqual(validateScreenDoc(freeDoc), []);

  const badAxis = validateScreenDoc(screenDoc({ groups: [{ ...freeGroup, axis: 'z' }] }));
  assert.ok(badAxis.some((i) => i.path === 'doc.groups[0].axis'));

  const posInRun = validateScreenDoc(
    screenDoc({ groups: [{ id: 'g', x: 0, y: 0, axis: 'y', items: [item({ pos: { x: 10, y: 10 } })] }] })
  );
  assert.ok(posInRun.some((i) => i.code === 'POS_NOT_ALLOWED'), '非自由组禁止 Item.pos');

  const badPos = validateScreenDoc(screenDoc({ groups: [{ ...freeGroup, items: [item({ pos: { x: 'a', y: 1 } })] }] }));
  assert.ok(badPos.some((i) => i.path.endsWith('.pos.x')));

  const badGroupPos = validateScreenDoc(screenDoc({ groups: [{ ...freeGroup, pos: { itm_fab: { x: 0, y: 0 } } }] }));
  assert.ok(badGroupPos.some((i) => i.path === 'doc.groups[0].pos.x'), 'ScreenDoc 的 Group.pos 是 {x,y}');
});

test('M3 schema：版本快照携带 theme_snapshot / prompt_digest（DC-031 / DC-041）', () => {
  const snapshot = { version: 1, doc: screenDoc(), theme_snapshot: { ...DEFAULT_THEME }, prompt_digest: 'sha256:abc' };
  assert.deepEqual(validateVersionSnapshot(snapshot), []);
  assert.ok(validateVersionSnapshot({ version: 1, doc: screenDoc() }).some((i) => i.path.endsWith('.theme_snapshot')));
  assert.ok(validateVersionSnapshot({ version: 0, doc: screenDoc(), theme_snapshot: { ...DEFAULT_THEME } }).some((i) => i.path.endsWith('.version')));
  assert.ok(
    validateVersionSnapshot({ ...snapshot, prompt_digest: 42 }).some((i) => i.path.endsWith('.prompt_digest'))
  );
});

test('M3 schema：常量白名单与 m3e-canvas 对齐（36 种 kind）', () => {
  assert.equal(KINDS.length, 36);
  assert.equal(new Set(KINDS).size, 36);
  assert.equal(PROJECT_SCHEMA, 'm3studio/project@1');
});
