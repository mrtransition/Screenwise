import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCREEN_SCHEMA,
  PROJECT_SCHEMA,
  PHONE,
} from '../apps/server/src/domain/m3/constants.js';
import { M3SchemaError, validateM3eDoc, validateScreenDoc } from '../apps/server/src/domain/m3/schema.js';
import {
  importM3eProject,
  exportM3eProject,
  assembleProjectDoc,
  emptyScreenDoc,
  emptyFlow,
  makeEdgeId,
  createOrphanContext,
  computeEdgeOrphan,
} from '../apps/server/src/domain/m3/convert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/m3e-sample.json'), 'utf8'));
const NOW = '2026-11-05T00:00:00.000Z';

const load = () => importM3eProject(structuredClone(fixture), { now: NOW });
const byTitle = (screens, title) => screens.find((s) => s.title === title);

test('M3E 导入：frame → ScreenDoc，组坐标转为本地坐标，action 剥离', () => {
  const r = load();
  assert.equal(r.screens.length, 4, '3 个 frame + 1 个未放置屏');
  assert.equal(byTitle(r.screens, '首页').screen_id, 'f_home');
  assert.equal(byTitle(r.screens, '审批列表').screen_id, 'f_list');
  assert.equal(byTitle(r.screens, '审批详情').screen_id, 'f_detail');

  const home = byTitle(r.screens, '首页').doc;
  assert.equal(home.schema, SCREEN_SCHEMA);
  assert.equal(home.format, 'm3');
  assert.equal(home.frame.x, 0);
  assert.equal(home.frame.y, 0);
  assert.equal(home.frame.w, 412);
  assert.equal(home.frame.h, 892);
  assert.equal(home.frame.length, 1200);
  assert.equal(home.frame.bg, 'surface');

  const cardGroup = home.groups.find((g) => g.id === 'grp_home_card');
  assert.equal(cardGroup.x, 16);
  assert.equal(cardGroup.y, 120);
  const card = cardGroup.items.find((i) => i.id === 'itm_card_today');
  assert.equal(card.action, undefined);
  assert.equal(card.actions, undefined);
  assert.equal(card.noteHistory, undefined);

  const list = byTitle(r.screens, '审批列表').doc;
  assert.equal(list.groups[0].x, 16, '548 - 532');
  assert.equal(list.groups[0].y, 120);

  for (const screen of r.screens) {
    assert.deepEqual(validateScreenDoc(screen.doc), [], `${screen.screen_id} 必须是合法 ScreenDoc`);
    assert.equal(JSON.stringify(screen.doc).includes('"action"'), false);
    assert.equal(JSON.stringify(screen.doc).includes('"swipe"'), false);
  }
});

test('M3E 导入：自由组 → axis:"free" + Item.pos 绝对坐标（DC-036）', () => {
  const r = load();
  const home = byTitle(r.screens, '首页').doc;
  const free = home.groups.find((g) => g.id === 'grp_home_free');
  assert.ok(free);
  assert.equal(free.axis, 'free');
  assert.deepEqual(free.pos, { x: 16, y: 600 });
  assert.equal(free.free, undefined, 'ScreenDoc 用 axis:"free" 表达自由组');

  const fab = free.items.find((i) => i.id === 'itm_home_fab');
  const chip = free.items.find((i) => i.id === 'itm_home_chip');
  assert.deepEqual(fab.pos, { x: 16, y: 600 });
  assert.deepEqual(chip.pos, { x: 88, y: 600 });

  const { doc } = exportM3eProject({ design: r.design, screens: r.screens, edges: r.edges });
  const exported = doc.groups.find((g) => g.id === 'grp_home_free');
  assert.equal(exported.free, true);
  assert.equal(exported.axis, 'x');
  assert.deepEqual(exported.pos, {
    itm_home_fab: { x: 0, y: 0 },
    itm_home_chip: { x: 72, y: 0 },
  });
  assert.equal(exported.items[0].pos, undefined);
});

test('M3E 导入：action / actions / frame.swipe → FlowEdge，target_kind 正确', () => {
  const r = load();
  assert.equal(r.edges.length, 7);

  const bar = r.edges.find((e) => e.source_item_id === 'itm_home_bar');
  assert.equal(bar.source_screen_id, 'f_home');
  assert.equal(bar.source_slot, 'icon2');
  assert.equal(bar.target_kind, 'screen');
  assert.equal(bar.target_screen_id, 'f_list');
  assert.equal(bar.transition, 'fade');
  assert.equal(bar.status, 'confirmed');

  const card = r.edges.find((e) => e.source_item_id === 'itm_card_today');
  assert.equal(card.target_screen_id, 'f_detail');
  assert.equal(card.transition, 'slide');

  const back = r.edges.find((e) => e.source_item_id === 'itm_detail_back');
  assert.equal(back.target_kind, 'back');
  assert.equal(back.target_screen_id, null);

  const link = r.edges.find((e) => e.source_item_id === 'itm_detail_link');
  assert.equal(link.target_kind, 'link');
  assert.equal(link.url, 'https://example.com/policy');

  const swipe = r.edges.find((e) => e.trigger === 'swipe');
  assert.equal(swipe.source_item_id, null);
  assert.equal(swipe.source_slot, null);
  assert.equal(swipe.direction, 'left');
  assert.equal(swipe.target_screen_id, 'f_list');
  assert.equal(swipe.transition, 'slide');
  assert.equal(swipe.expires_at, null);
  assert.equal('orphan' in swipe, false, 'orphan 不得持久化');

  const fab = r.edges.find((e) => e.source_item_id === 'itm_home_fab');
  assert.equal(fab.trigger, 'click');
  assert.equal(fab.direction, null);

  for (const edge of r.edges) assert.equal(edge.edge_id, makeEdgeId([
    edge.source_screen_id,
    edge.source_item_id ?? '',
    edge.source_slot ?? '',
    edge.target_kind,
    edge.target_screen_id ?? '',
    edge.url ?? '',
    edge.trigger,
    edge.direction ?? '',
  ]));
});

test('M3E 导入：项目级主题/平台/Prompt 选项进入 ProjectDesign', () => {
  const r = load();
  assert.equal(r.design.title, '报销审批');
  assert.equal(r.design.brief, '员工提交报销，经理审批。');
  assert.equal(r.design.platform, 'android');
  assert.equal(r.design.paletteKey, 'custom');
  assert.equal(r.design.customPalette.primary, '#3f6b4f');
  assert.equal(r.design.dynamicColor, false);
  assert.equal(r.design.theme.bothModes, true);
  assert.equal(r.design.theme.motion, 'expressive');
  assert.deepEqual(r.design.promptOptions, ['deliverable', 'tests']);
  assert.equal(r.design_tokens.colors.primary, '#3f6b4f');
  assert.equal(r.design_tokens.radius.md, 16);
});

test('M3E 导入：未归属 frame 的组进入“未放置”屏并告警，不丢内容', () => {
  const r = load();
  const unplaced = byTitle(r.screens, '未放置');
  assert.ok(unplaced);
  assert.equal(unplaced.doc.groups.length, 1);
  assert.equal(unplaced.doc.groups[0].items[0].id, 'itm_unplaced_text');
  assert.ok(r.warnings.some((w) => w.code === 'GROUP_UNPLACED' && w.group_id === 'grp_unplaced'));
  assert.deepEqual(r.loss, []);
});

test('M3E 导出：按 FlowEdge 注回 action/swipe，且不含服务端字段', () => {
  const r = load();
  const { doc, warnings } = exportM3eProject({ design: r.design, screens: r.screens, edges: r.edges });
  assert.deepEqual(warnings, []);
  assert.deepEqual(validateM3eDoc(doc), []);
  assert.equal(doc.frames.length, 4);
  assert.equal(doc.groups.length, 6);
  assert.equal(doc.title, '报销审批');
  assert.equal(doc.platform, 'android');
  assert.equal(doc.theme.motion, 'expressive');

  const home = doc.frames.find((f) => f.id === 'f_home');
  assert.deepEqual(home.swipe, { left: 'f_list' });

  const card = doc.groups.flatMap((g) => g.items).find((i) => i.id === 'itm_card_today');
  assert.deepEqual(card.action, { to: 'f_detail', transition: 'slide' });
  assert.equal(card.noteHistory, undefined);

  const bar = doc.groups.flatMap((g) => g.items).find((i) => i.id === 'itm_home_bar');
  assert.deepEqual(bar.actions.icon2, { to: 'f_list', transition: 'fade' });

  const link = doc.groups.flatMap((g) => g.items).find((i) => i.id === 'itm_detail_link');
  assert.deepEqual(link.action, { to: 'link', transition: 'none', url: 'https://example.com/policy' });

  for (const key of ['project_id', 'version', 'audit', 'pending', 'theme_snapshot']) {
    assert.equal(doc[key], undefined, `导出不得包含 ${key}`);
  }
});

test('M3E 往返：import → export → import 保持屏数与边数，且 ScreenDoc 无 action', () => {
  const first = load();
  const exported = exportM3eProject({ design: first.design, screens: first.screens, edges: first.edges });
  const second = importM3eProject(exported.doc, { now: NOW });
  assert.equal(second.screens.length, first.screens.length);
  assert.equal(second.edges.length, first.edges.length);
  assert.equal(second.design.theme.motion, first.design.theme.motion);
  for (const screen of second.screens) {
    assert.equal(JSON.stringify(screen.doc).includes('"action"'), false);
  }
});

test('M3E 导出：确定性（同一输入产生同一 JSON）', () => {
  const r = load();
  const a = exportM3eProject({ design: r.design, screens: r.screens, edges: r.edges });
  const b = exportM3eProject({ design: r.design, screens: r.screens, edges: [...r.edges].reverse() });
  assert.equal(JSON.stringify(a.doc), JSON.stringify(b.doc));
});

test('M3E 导出：candidate 边不写入，confirmed 边正常写入', () => {
  const r = load();
  const candidate = {
    edge_id: 'edg_candidate',
    source_screen_id: 'f_home',
    source_item_id: 'itm_home_button',
    source_slot: null,
    target_kind: 'screen',
    target_screen_id: 'f_list',
    url: null,
    trigger: 'click',
    direction: null,
    transition: 'slide',
    note: '',
    status: 'candidate',
    expires_at: '2026-12-01T00:00:00.000Z',
    created_at: NOW,
    created_by: 'local-user',
  };
  const { doc } = exportM3eProject({ design: r.design, screens: r.screens, edges: [...r.edges, candidate] });
  const button = doc.groups.flatMap((g) => g.items).find((i) => i.id === 'itm_home_button');
  assert.equal(button.action, undefined);
});

test('M3E 导入：保留 id 冲突时重映射，边指向新 id', () => {
  const r = importM3eProject(structuredClone(fixture), { now: NOW, reservedScreenIds: ['f_home'] });
  const home = byTitle(r.screens, '首页');
  assert.notEqual(home.screen_id, 'f_home');
  assert.equal(r.id_map.screens.f_home, home.screen_id);

  const swipe = r.edges.find((e) => e.trigger === 'swipe');
  assert.equal(swipe.target_screen_id, byTitle(r.screens, '审批列表').screen_id);
  const card = r.edges.find((e) => e.source_item_id === 'itm_card_today');
  assert.equal(card.target_screen_id, byTitle(r.screens, '审批详情').screen_id);
});

test('M3E 导入：同屏重复 Item id 自动重映射，不产生非法 ScreenDoc', () => {
  const doc = {
    frames: [
      { id: 'f1', name: 'A', x: 0, y: 0, w: 412, h: 892 },
      { id: 'f2', name: 'B', x: 532, y: 0, w: 412, h: 892 },
    ],
    groups: [
      {
        id: 'g1',
        x: 16,
        y: 16,
        axis: 'y',
        items: [
          { id: 'dup', kind: 'button', label: '一', icon: null, variant: 'filled', action: { to: 'f2', transition: 'slide' } },
        ],
      },
      {
        id: 'g2',
        x: 16,
        y: 120,
        axis: 'y',
        items: [
          { id: 'dup', kind: 'button', label: '二', icon: null, variant: 'filled', action: { to: 'f2', transition: 'fade' } },
        ],
      },
    ],
    title: '重复 id',
    brief: '',
    paletteKey: 'purple',
    theme: { dark: false, bothModes: false, contrast: 'standard', shape: 'rounded', font: 'roboto', emphasized: false, motion: 'standard' },
  };
  const r = importM3eProject(doc, { now: NOW });
  const screen = r.screens.find((s) => s.screen_id === 'f1');
  const ids = screen.doc.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes('dup'));
  assert.ok(r.warnings.some((w) => w.code === 'ITEM_ID_REMAPPED'));
  assert.equal(r.edges.length, 2);
  const remapped = r.id_map.items['f1/dup'];
  assert.ok(remapped);
  assert.ok(r.edges.some((e) => e.source_item_id === remapped));
});

test('M3E 导入：非法 kind 直接失败，不产生部分数据', () => {
  const bad = structuredClone(fixture);
  bad.groups[0].items[0].kind = 'unknownPart';
  assert.throws(
    () => importM3eProject(bad, { now: NOW }),
    (err) => err instanceof M3SchemaError && err.code === 'SCHEMA_INVALID' && err.issues.some((i) => i.path.endsWith('.kind'))
  );
});

test('ProjectDoc 聚合：带 schema、可重复，且 ScreenDoc 保持本地坐标', () => {
  const r = load();
  const a = assembleProjectDoc({ design: r.design, screens: r.screens, edges: r.edges });
  const b = assembleProjectDoc({ design: r.design, screens: r.screens, edges: r.edges });
  assert.equal(a.schema, PROJECT_SCHEMA);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.frames.length, 4);
  assert.deepEqual(validateM3eDoc(a), []);
});

test('M3 导出：hidden 组/Item 默认不导出，includeHidden 可显式包含（DC-037）', () => {
  const r = load();
  const doc = emptyScreenDoc({ screenId: 'scr_hidden' });
  doc.groups = [
    {
      id: 'g_visible',
      x: 16,
      y: 16,
      axis: 'y',
      items: [
        { id: 'itm_visible', kind: 'button', label: '可见', icon: null, variant: 'filled' },
        { id: 'itm_hidden', kind: 'button', label: '隐藏', icon: null, variant: 'filled', hidden: true },
      ],
    },
    {
      id: 'g_hidden',
      x: 16,
      y: 200,
      axis: 'y',
      hidden: true,
      items: [{ id: 'itm_group_hidden', kind: 'text', label: '整组隐藏', icon: null, variant: 'filled' }],
    },
  ];
  const base = { design: r.design, screens: [{ screen_id: 'scr_hidden', doc }], edges: [] };

  const without = exportM3eProject(base);
  assert.equal(without.doc.groups.length, 1);
  assert.deepEqual(without.doc.groups[0].items.map((i) => i.id), ['itm_visible']);
  assert.equal(without.doc.groups[0].hidden, undefined);

  const withHidden = exportM3eProject({ ...base, includeHidden: true });
  assert.equal(withHidden.doc.groups.length, 2);
  assert.equal(withHidden.doc.groups.flatMap((g) => g.items).length, 3);
});

test('M3 孤儿边：动态计算，不写入 FlowEdge（DC-039 / FR-FLOW-007）', () => {
  const r = load();
  const home = byTitle(r.screens, '首页').doc;
  home.groups = home.groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== 'itm_card_today'),
  }));

  const context = createOrphanContext(r.screens);
  const cardEdge = r.edges.find((e) => e.source_item_id === 'itm_card_today');
  const result = computeEdgeOrphan(cardEdge, context);
  assert.equal(result.orphan, true);
  assert.equal(result.item_missing, true);

  const missingTarget = { ...cardEdge, edge_id: 'edg_missing', source_item_id: null, target_screen_id: 'scr_nope' };
  assert.equal(computeEdgeOrphan(missingTarget, context).target_missing, true);

  const missingSource = { ...cardEdge, edge_id: 'edg_src', source_screen_id: 'scr_nope', source_item_id: null };
  assert.equal(computeEdgeOrphan(missingSource, context).source_missing, true);

  const badSlot = { ...cardEdge, edge_id: 'edg_slot', source_item_id: null, source_slot: 'swipe:left' };
  assert.equal(computeEdgeOrphan(badSlot, context).slot_missing, true);

  const flow = { ...emptyFlow(), edges: r.edges };
  assert.equal(JSON.stringify(flow).includes('"orphan"'), false);
  assert.equal(JSON.stringify(flow).includes('"source_missing"'), false);
});

test('M3 导出：swipe 缺 direction 拒绝，方向冲突保留首条并告警（DC-040）', () => {
  const r = load();
  const edge = {
    edge_id: 'edg_swipe_bad',
    source_screen_id: 'f_home',
    source_item_id: null,
    source_slot: null,
    target_kind: 'screen',
    target_screen_id: 'f_detail',
    url: null,
    trigger: 'swipe',
    direction: null,
    transition: 'slide',
    note: '',
    status: 'confirmed',
    expires_at: null,
    created_at: NOW,
    created_by: 'local-user',
  };
  const { doc, warnings } = exportM3eProject({ design: r.design, screens: r.screens, edges: [...r.edges, edge] });
  assert.ok(warnings.some((w) => w.code === 'SWIPE_DIRECTION_REQUIRED' && w.edge_id === 'edg_swipe_bad'));
  assert.deepEqual(doc.frames.find((f) => f.id === 'f_home').swipe, { left: 'f_list' });

  const conflict = { ...edge, edge_id: 'edg_swipe_conflict', direction: 'left', target_screen_id: 'f_detail' };
  const result = exportM3eProject({ design: r.design, screens: r.screens, edges: [...r.edges, conflict] });
  assert.ok(result.warnings.some((w) => w.code === 'EDGE_CONFLICT'));
  assert.deepEqual(result.doc.frames.find((f) => f.id === 'f_home').swipe, { left: 'f_list' });
});

test('基线：emptyScreenDoc / emptyFlow 可直接通过校验', () => {
  const doc = emptyScreenDoc({ screenId: 'scr_new', title: '新屏' });
  assert.equal(doc.frame.w, PHONE.w);
  assert.equal(doc.frame.h, PHONE.h);
  assert.deepEqual(validateScreenDoc(doc), []);
  assert.deepEqual(emptyFlow(), { schema_version: 2, edges: [] });
});
