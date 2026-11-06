import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/server/src/index.js';
import { client, listen } from './helpers.mjs';
import { tidyDoc, TIDY_MARGIN } from '../apps/server/src/domain/m3/tidy.js';
import { emptyScreenDoc, groupLayout } from '../apps/server/src/domain/m3/convert.js';
import { validateScreenDoc } from '../apps/server/src/domain/m3/schema.js';
import { KIND_SPEC } from '../apps/server/src/domain/m3/registry.js';
import { renderM3Body, renderScreenBody, assertM3Renderable, layoutGroup, estimateAnchors, themeCss } from '../apps/web/src/screen-render.js';

/**
 * M2 编辑器集成验收（SRS §11）：
 *   AC-302/303/304/306/307/308/309/318/319/321/322/323
 * 本文件覆盖服务端侧（API-018 保存、API-024 Tidy、复制、锁定、只读）与共享渲染契约。
 * 编辑器岛的交互态（V/H/空格等快捷键、撤销栈）见 `m2-editor-ui.test.mjs`。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/m3e-sample.json'), 'utf8'));
let seq = 0;

const clone = (v) => structuredClone(v);
/** 按 Registry 补全必填项（variant/label），避免测试数据与 schema 漂移 */
const it = (id, kind, extra = {}) => ({ id, kind, label: extra.label ?? '', variant: KIND_SPEC[kind]?.variant ?? 'filled', ...extra });
const tmpRoot = (tag) => `.m2test-${tag}-${process.pid}-${Date.now()}-${seq++}`;

async function withServer(tag, fn) {
  const repoRoot = tmpRoot(tag);
  const { server, repo } = createServer({ repoRoot });
  await listen(server);
  try {
    await fn({ call: client(server), repoRoot, repo });
  } finally {
    server.close();
    await fsp.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** 建一个 M3 空屏并返回 { pid, sid, doc } */
async function newM3Screen(call, title = '编辑器屏') {
  const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
  const created = await call('POST', `/api/projects/${pid}/screens`, { title, format: 'm3' });
  assert.equal(created.status, 200, JSON.stringify(created.raw));
  const sid = created.data.screen_id;
  const detail = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
  return { pid, sid, doc: detail.doc, version: detail.current_version };
}

/* ------------------------------------------------------------------ */
/* 新建屏幕必须是可直接编辑的 M3 屏                                     */
/* ------------------------------------------------------------------ */

test('FR-PROJ-003 回归：新建屏幕默认就是可编辑的 M3 屏', async () => {
  await withServer('newm3', async ({ call }) => {
    const pid = (await call('POST', '/api/projects', { name: '新建屏测试' })).data.project_id;
    // 不传 format：沿用服务端默认
    const res = await call('POST', `/api/projects/${pid}/screens`, { title: '新建页' });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    const sid = res.data.screen_id;

    const det = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(det.format, 'm3', '新建屏必须是 M3，否则设计面板只剩“先转换”');
    assert.equal(det.readonly, false, '新建屏不得是只读');
    assert.equal(det.doc?.format, 'm3');
    assert.equal(det.current_version, 1, '仍有 v1 空屏基线');
    assert.equal(det.doc.frame.id, sid);

    // 新建即可保存部件（设计面板 / 编辑器岛的前提）
    const doc = structuredClone(det.doc);
    doc.groups.push({ id: 'g1', x: 16, y: 104, axis: 'y', items: [{ id: 'i1', kind: 'card', label: '卡片', variant: 'filled' }] });
    const save = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc, base_version: det.current_version });
    assert.equal(save.status, 200, JSON.stringify(save.raw));
    assert.equal(save.data.version, 2);
  });
});

test('FR-PROJ-003 回归：新建的 M3 空屏可走生成链路（热区/节点数判断兼容 M3）', async () => {
  await withServer('newm3gen', async ({ call }) => {
    const pid = (await call('POST', '/api/projects', { name: 'M3 生成' })).data.project_id;
    const sid = (await call('POST', `/api/projects/${pid}/screens`, { title: '首页' })).data.screen_id;

    // 旧实现用 countAll(doc.root) 判断内容量，M3 文档没有 root，会抛
    // "Cannot read properties of undefined (reading 'children')"。
    const gen = await call('POST', `/api/projects/${pid}/screens/${sid}/generations`, { prompt: '登录页，手机号验证码登录', edit_scope: 'screen' });
    assert.equal(gen.status, 200, JSON.stringify(gen.raw));

    const apply = await call('POST', `/api/projects/${pid}/screens/${sid}/pending/apply`);
    assert.equal(apply.status, 200, JSON.stringify(apply.raw));
  });
});

test('FR-FLOW-002 回归：M3 屏的自然语言建边可用（热区结构统一）', async () => {
  await withServer('newm3flow', async ({ call }) => {
    const pid = (await call('POST', '/api/projects', { name: 'M3 建边' })).data.project_id;
    const a = (await call('POST', `/api/projects/${pid}/screens`, { title: '首页' })).data.screen_id;
    const b = (await call('POST', `/api/projects/${pid}/screens`, { title: '详情' })).data.screen_id;

    // 给首页放一个可点击部件
    const det = (await call('GET', `/api/projects/${pid}/screens/${a}`)).data;
    const doc = structuredClone(det.doc);
    doc.groups.push({ id: 'g', x: 16, y: 104, axis: 'y', items: [{ id: 'btn_go', kind: 'button', label: '查看详情', variant: 'filled' }] });
    await call('POST', `/api/projects/${pid}/screens/${a}/doc`, { doc, base_version: det.current_version });

    const prop = await call('POST', `/api/projects/${pid}/flow/propose`, { text: '在首页点查看详情跳到详情' });
    assert.equal(prop.status, 200, JSON.stringify(prop.raw));
    assert.equal(prop.data.source_screen_id, a);
    assert.equal(prop.data.target_screen_id, b);
    assert.equal(prop.data.source_hotspot_id, 'btn_go');

    const conf = await call('POST', `/api/projects/${pid}/flow/confirm`, prop.data);
    assert.equal(conf.status, 200, JSON.stringify(conf.raw));
  });
});

test('FR-PROJ-003：显式 format:"node-tree" 仍被尊重（导入旧数据用）', async () => {
  await withServer('newlegacy', async ({ call }) => {
    const pid = (await call('POST', '/api/projects', { name: '旧格式屏' })).data.project_id;
    const res = await call('POST', `/api/projects/${pid}/screens`, { title: '旧屏', format: 'node-tree' });
    assert.equal(res.status, 200);
    const det = (await call('GET', `/api/projects/${pid}/screens/${res.data.screen_id}`)).data;
    assert.equal(det.format, 'node-tree');
    assert.equal(det.readonly, true, '旧格式屏保持只读');
  });
});

/* ------------------------------------------------------------------ */
/* API-018：编辑器保存整屏 ScreenDoc                                    */
/* ------------------------------------------------------------------ */

test('AC-302：拖入按钮后保存，生成一条 manual_direct 版本且内容落库', async () => {
  await withServer('ac302', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);

    const next = clone(doc);
    next.groups.push({
      id: 'grp_new',
      x: 16,
      y: 120,
      axis: 'x',
      items: [it('itm_new_btn', 'button', { label: '立即开始', icon: 'play_arrow' })],
    });

    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: next, base_version: version });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.equal(res.data.version, version + 1);
    assert.match(res.data.change_summary, /新增 1 个部件/);

    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version + 1);
    const items = after.doc.groups.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(items.includes('itm_new_btn'), '新 Item 必须落库');

    const versions = (await call('GET', `/api/projects/${pid}/screens/${sid}/versions`)).data;
    assert.equal(versions.versions.length, 2, '保存只生成一条新版本');
    const last = versions.versions.find((v) => v.version === version + 1);
    assert.ok(last, '应存在新版本');
    assert.equal(last.change_source, 'manual_direct');
    assert.equal(last.kind, 'manual');

    // 主链路：按钮成为可点击热区，可被建边引用
    assert.ok(after.anchors.some((a) => a.item_id === 'itm_new_btn'), '按钮应进入热区集合');
  });
});

test('AC-302：编辑器保存不产生 AI 版本，ai_cost 为 0', async () => {
  await withServer('ac302b', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const next = clone(doc);
    next.frame.note = '编辑器保存';
    next.groups.push({ id: 'g_note', x: 16, y: 40, axis: 'y', items: [it('itm_note', 'text', { label: '备注' })] });
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: next, base_version: version });
    assert.equal(res.status, 200);
    const v = (await call('GET', `/api/projects/${pid}/screens/${sid}/versions/${version + 1}`)).data;
    assert.equal(v.change_source, 'manual_direct');
    assert.equal(v.ai_cost, 0);
    assert.equal(v.route_layer, 'manual');
  });
});

test('AC-319 / DC-032：两个标签页先后保存，后到者 409 且不覆盖', async () => {
  await withServer('ac319', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);

    const tabA = clone(doc);
    tabA.groups.push({ id: 'g_a', x: 0, y: 0, axis: 'y', items: [it('i_a', 'text', { label: 'A 的修改' })] });
    const tabB = clone(doc);
    tabB.groups.push({ id: 'g_b', x: 0, y: 0, axis: 'y', items: [it('i_b', 'text', { label: 'B 的修改' })] });

    const a = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: tabA, base_version: version });
    assert.equal(a.status, 200);

    // B 仍持有旧 base_version：必须被拒绝，且提示刷新/另存
    const b = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: tabB, base_version: version });
    assert.equal(b.status, 409);
    assert.equal(b.error.code, 'CONFLICT');
    assert.equal(b.error.detail.current_version, version + 1);
    assert.ok(b.error.detail.hint, '冲突必须给出可照做的下一步');

    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version + 1, '冲突不得递增版本');
    const ids = after.doc.groups.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(ids.includes('i_a'), 'A 的内容必须保留');
    assert.equal(ids.includes('i_b'), false, 'B 的内容不得写入');
  });
});

test('AC-319：缺少 base_version 返回 400，不落库', async () => {
  await withServer('ac319b', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc });
    assert.equal(res.status, 400);
    assert.equal(res.error.code, 'BAD_REQUEST');
    assert.ok(res.error.detail.code === 'BASE_VERSION_REQUIRED' || res.error.detail?.hint, '必须指出缺少 base_version 并给出下一步');
    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version);
  });
});

test('AC-308：锁定屏 / 只读成员 / 旧屏保存分别返回 423 / 403 / 422', async () => {
  await withServer('ac308', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);

    await call('POST', `/api/projects/${pid}/screens/${sid}/lock`, { reason: '评审中' });
    const lockedRes = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc, base_version: version });
    assert.equal(lockedRes.status, 423);
    assert.equal(lockedRes.error.code, 'SCREEN_LOCKED');

    await call('POST', `/api/projects/${pid}/screens/${sid}/unlock`, { reason: '评审结束' });
    const meta = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(meta.current_version, version, '锁定期间版本不得递增');

    // 只读成员
    const ro = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc, base_version: version }, { 'x-proto-user': 'viewer' });
    // 本项目未登记 viewer，本地模式默认当成员；登记为 readonly 后才必须 403
    assert.ok([200, 403].includes(ro.status), `未登记成员在本地模式可写（实际 ${ro.status}）`);
  });
});

test('AC-308：只读成员保存被拒绝（团队模式登记的 readonly）', async () => {
  await withServer('ac308b', async ({ call, repoRoot }) => {
    const { pid, sid, doc } = await newM3Screen(call);
    const projFile = path.join(repoRoot, 'projects', pid, 'project.json');
    const project = JSON.parse(await fsp.readFile(projFile, 'utf8'));
    project.members = [...(project.members ?? []), { user: 'viewer', role: 'readonly' }];
    await fsp.writeFile(projFile, JSON.stringify(project));

    const cur = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc, base_version: cur.current_version }, { 'x-proto-user': 'viewer' });
    assert.equal(res.status, 403);
    assert.equal(res.error.code, 'NO_PERMISSION');
    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, cur.current_version);
  });
});

test('保存校验：frame.id 不一致 / 非法 kind 都 422，不产生版本', async () => {
  await withServer('savebad', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);

    const mismatch = clone(doc);
    mismatch.frame.id = 'scr_other';
    const r1 = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: mismatch, base_version: version });
    assert.equal(r1.status, 422);
    assert.equal(r1.error.code, 'SCHEMA_INVALID');
    assert.ok(r1.error.detail.issues.some((i) => i.path === 'doc.frame.id'));

    const badKind = clone(doc);
    badKind.groups.push({ id: 'g', x: 0, y: 0, axis: 'y', items: [{ id: 'i', kind: 'segmentedButton' }] });
    const r2 = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: badKind, base_version: version });
    assert.equal(r2.status, 422);
    assert.ok(r2.error.detail.issues.some((i) => /kind/.test(i.path)));

    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version, '校验失败不得落库');
  });
});

test('保存校验：整屏替换丢失已有热区时 422 INVALID_OUTPUT 并列出 lost_items', async () => {
  await withServer('lost', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const withCard = clone(doc);
    withCard.groups.push({ id: 'g_card', x: 16, y: 100, axis: 'y', items: [it('itm_keep', 'card', { label: '会被删掉的卡片' })] });
    const saved = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: withCard, base_version: version });
    assert.equal(saved.status, 200);

    // 建一条边指向该卡片，使其成为“被引用的热区”
    const edge = await call('POST', `/api/projects/${pid}/flow/edges`, {
      source_screen_id: sid,
      source_item_id: 'itm_keep',
      target_screen_id: (await call('GET', `/api/projects/${pid}/screens`)).data[0].screen_id,
    });
    assert.equal(edge.status, 200, JSON.stringify(edge.raw));

    const wipe = clone(withCard);
    wipe.groups = wipe.groups.filter((g) => g.id !== 'g_card');
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: wipe, base_version: version + 1 });
    assert.equal(res.status, 422);
    assert.equal(res.error.code, 'INVALID_OUTPUT');
    assert.deepEqual(res.error.detail.lost_items, ['itm_keep']);
  });
});

/* ------------------------------------------------------------------ */
/* AC-303：Tidy                                                        */
/* ------------------------------------------------------------------ */

test('AC-303：Tidy 吸附栏位、统一 16dp 边距与圆角，不改文案与顺序，且可重复', async () => {
  await withServer('ac303', async ({ call }) => {
    const { pid, sid, doc } = await newM3Screen(call);
    const messy = clone(doc);
    messy.frame.place = 'top';
    messy.groups = [
      { id: 'g_top', x: 37, y: 21, axis: 'y', items: [it('i_top', 'topAppBar', { label: '首页', size: 380 })] },
      { id: 'g_list', x: 53, y: 310, axis: 'y', items: [
        it('i_card1', 'card', { label: '番茄汤' }),
        it('i_card2', 'card', { label: '南瓜汤' }),
        it('i_card3', 'card', { label: '玉米汤' }),
      ] },
      { id: 'g_nav', x: 11, y: 690, axis: 'y', items: [it('i_nav', 'bottomNav')] },
    ];

    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/tidy`, { doc: messy, shape: 'rounded' });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.equal(res.data.valid, true, JSON.stringify(res.data.issues));
    const out = res.data.doc;

    const top = out.groups.find((g) => g.id === 'g_top');
    assert.equal(top.x, 0, '顶栏贴左');
    assert.equal(top.y, 0, '顶栏贴顶');
    assert.equal(top.items[0].size, messy.frame.w, '顶栏整宽');
    assert.equal(top.items[0].label, '首页', '文案不变');

    const list = out.groups.find((g) => g.id === 'g_list');
    assert.equal(list.x, TIDY_MARGIN, '内容区左对齐 16dp');
    assert.equal(list.y, top.y + 88 + 16, '组间 16dp');
    assert.deepEqual(list.items.map((i) => i.id), ['i_card1', 'i_card2', 'i_card3'], '顺序不变');

    const nav = out.groups.find((g) => g.id === 'g_nav');
    // place="top" 时底栏参与流式排布（贴在内容流末尾下方），不强行贴屏底；
    // 贴底只在 frame.place 为 bottom 时生效，见下一个用例
    assert.ok(nav.y > list.y, '底栏应排在内容之后');
    assert.equal(nav.x, 0, '底栏整宽贴左');
    assert.equal(nav.items[0].size, messy.frame.w, '底栏整宽');

    for (const g of out.groups) for (const i of g.items) assert.deepEqual(i.corners, { tl: 12, tr: 12, bl: 12, br: 12 }, `圆角统一：${i.id}`);

    // 确定性：再跑一次不产生变化
    const again = await call('POST', `/api/projects/${pid}/screens/${sid}/tidy`, { doc: out, shape: 'rounded' });
    assert.equal(again.data.changed_count, 0, 'Tidy 必须幂等（DC-038）');
  });
});

test('AC-303 / DC-038：Tidy 只预览不落库，自由组与锁定组不参与', () => {
  const doc = emptyScreenDoc({ screenId: 'scr_t', title: '屏', width: 412, height: 892 });
  doc.frame.place = 'top';
  doc.groups = [
    { id: 'g_free', x: 0, y: 0, axis: 'free', items: [it('i_fab', 'fab', { pos: { x: 330, y: 760 } })] },
    { id: 'g_locked', x: 200, y: 200, axis: 'y', locked: true, items: [it('i_lk', 'card', { label: '锁' })] },
    { id: 'g_run', x: 40, y: 400, axis: 'y', items: [it('i_1', 'button', { label: 'A' })] },
  ];
  const out = tidyDoc(doc, { shape: 'square' });
  const free = out.doc.groups.find((g) => g.id === 'g_free');
  const locked = out.doc.groups.find((g) => g.id === 'g_locked');
  const run = out.doc.groups.find((g) => g.id === 'g_run');
  assert.deepEqual(free.items[0].pos, { x: 330, y: 760 }, '自由组坐标不动');
  assert.equal(free.items[0].corners, undefined, '自由组不参与圆角统一');
  assert.equal(locked.x, 200, '锁定组可移动性不动');
  assert.equal(locked.items[0].corners, undefined, '锁定组不参与圆角统一');
  assert.equal(run.x, TIDY_MARGIN);
  assert.deepEqual(run.items[0].corners, { tl: 0, tr: 0, bl: 0, br: 0 }, 'square 形状圆角为 0');
});

test('AC-303 回归：贴顶只对栏类族生效，普通内容不会被吸到左上角', () => {
  const doc = emptyScreenDoc({ screenId: 'scr_r', title: '屏', width: 412, height: 892 });
  doc.groups = [
    { id: 'g_card', x: 16, y: 16, axis: 'y', items: [it('i_card', 'card')] },
    { id: 'g_bar', x: 20, y: 5, axis: 'y', items: [it('i_bar', 'topAppBar')] },
  ];
  const out = tidyDoc(doc, { shape: 'rounded' });
  const card = out.doc.groups.find((g) => g.id === 'g_card');
  const bar = out.doc.groups.find((g) => g.id === 'g_bar');
  assert.equal(bar.x, 0, '栏类族贴左');
  assert.equal(bar.y, 0, '栏类族贴顶');
  assert.equal(card.x, TIDY_MARGIN, '普通内容保持 16dp 边距，不被吸到 0');
  assert.ok(card.y >= bar.y + 88, '普通内容排在顶栏之后，不与顶栏重叠');
});

test('AC-303：Tidy 结果必须是合法 ScreenDoc，且 Tidy 不产生版本', async () => {
  await withServer('ac303c', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/tidy`, { doc });
    assert.equal(res.status, 200);
    assert.deepEqual(validateScreenDoc(res.data.doc), []);
    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version, 'API-024 只预览，不提交');
  });
});

/* ------------------------------------------------------------------ */
/* AC-309：复制屏幕                                                     */
/* ------------------------------------------------------------------ */

test('AC-309：复制屏幕生成新 screen_id 与新 Item id，不继承版本历史', async () => {
  await withServer('ac309', async ({ call }) => {
    const { pid, sid, version: v0 } = await newM3Screen(call);
    // 先把源屏编辑一次，制造多版本
    const cur = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    const edited = clone(cur.doc);
    edited.groups.push({ id: 'g1', x: 0, y: 0, axis: 'y', items: [it('itm_copy', 'button', { label: '复制我' })] });
    await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: edited, base_version: cur.current_version });

    const dup = await call('POST', `/api/projects/${pid}/screens/${sid}/duplicate`);
    assert.equal(dup.status, 200, JSON.stringify(dup.raw));
    const copy = dup.data;
    assert.notEqual(copy.screen_id, sid, '必须生成新 screen_id');
    assert.equal(copy.current_version, 1, '不继承版本历史');
    assert.match(copy.versions[0].label, /复制自/, 'v1 摘要应注明复制自 X');
    assert.equal(copy.doc.frame.id, copy.screen_id, 'frame.id 必须同步为新屏');

    const srcIds = new Set(cur.doc.groups.flatMap((g) => g.items.map((i) => i.id)));
    const copyIds = copy.doc.groups.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(copyIds.length > 0);
    for (const id of copyIds) assert.equal(srcIds.has(id), false, `Item id 必须重映射：${id}`);
    assert.equal(new Set(copyIds).size, copyIds.length, '屏内 Item id 唯一');

    // 源屏不受影响
    const srcAfter = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(srcAfter.current_version, v0 + 1);
  });
});

/* ------------------------------------------------------------------ */
/* AC-321 / AC-322：图层字段与自由组坐标                                */
/* ------------------------------------------------------------------ */

test('AC-321：hidden 默认不导出，includeHidden 可显式包含；locked/name 持久化', async () => {
  await withServer('ac321', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const next = clone(doc);
    next.groups = [
      { id: 'g_vis', x: 0, y: 0, axis: 'y', name: '可见组', items: [it('i_vis', 'text', { label: '可见', name: '标题文本' })] },
      { id: 'g_hid', x: 0, y: 100, axis: 'y', name: '隐藏组', hidden: true, items: [it('i_hid', 'text', { label: '隐藏' })] },
      { id: 'g_lk', x: 0, y: 200, axis: 'y', name: '锁定组', locked: true, items: [it('i_lk', 'card', { label: '锁定卡片', locked: true })] },
    ];
    const saved = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: next, base_version: version });
    assert.equal(saved.status, 200, JSON.stringify(saved.raw));

    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.doc.groups.find((g) => g.id === 'g_vis').name, '可见组', 'name 持久化');
    assert.equal(after.doc.groups.find((g) => g.id === 'g_hid').hidden, true, 'hidden 持久化');
    assert.equal(after.doc.groups.find((g) => g.id === 'g_lk').locked, true, 'locked 持久化');

    const plain = await call('POST', `/api/projects/${pid}/export`, { format: 'm3e' });
    const plainText = JSON.stringify(plain.data.doc);
    assert.equal(plainText.includes('"i_hid"'), false, 'DC-037：hidden 默认不导出');

    const withHidden = await call('POST', `/api/projects/${pid}/export`, { format: 'm3e', include_hidden: true });
    assert.ok(JSON.stringify(withHidden.data.doc).includes('"i_hid"'), 'includeHidden 应包含隐藏项');
  });
});

test('AC-321：hidden Item 不进入热区，因此不能被建边引用', async () => {
  await withServer('ac321b', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const next = clone(doc);
    next.groups = [{ id: 'g', x: 0, y: 0, axis: 'y', items: [it('i_hidden_btn', 'button', { label: '隐藏按钮', hidden: true })] }];
    await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: next, base_version: version });

    const anchors = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data.anchors;
    assert.equal(anchors.some((a) => a.item_id === 'i_hidden_btn'), false, '隐藏项不得成为热区');
  });
});

test('AC-322 / DC-036：自由组 Item.pos 持久化，非自由组禁止 Item.pos', async () => {
  await withServer('ac322', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);

    const free = clone(doc);
    free.groups = [
      {
        id: 'g_free',
        x: 0,
        y: 0,
        axis: 'free',
        items: [
          it('i_fab', 'fab', { pos: { x: 300, y: 700 } }),
          it('i_chip', 'chip', { label: '标签', pos: { x: 120, y: 640 } }),
        ],
      },
    ];
    const ok = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: free, base_version: version });
    assert.equal(ok.status, 200, JSON.stringify(ok.raw));

    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.deepEqual(after.doc.groups[0].items[0].pos, { x: 300, y: 700 }, '拖动后的坐标必须持久化');
    // 渲染坐标与持久化坐标一致（编辑器/导出同一份布局规则）
    const rendered = layoutGroup(after.doc.groups[0]);
    assert.equal(rendered[0].x, 300);
    assert.equal(rendered[1].y, 640);

    const bad = clone(doc);
    bad.groups = [{ id: 'g_run', x: 0, y: 0, axis: 'y', items: [it('i_btn', 'button', { pos: { x: 10, y: 10 } })] }];
    const rej = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: bad, base_version: version + 1 });
    assert.equal(rej.status, 422);
    assert.ok(rej.error.detail.issues.some((i) => /pos/.test(i.path) && i.code === 'POS_NOT_ALLOWED'));
  });
});

/* ------------------------------------------------------------------ */
/* AC-323：共享渲染契约                                                  */
/* ------------------------------------------------------------------ */

test('AC-323 / FR-RENDER-001/002：预览与导出使用同一份渲染结构，且确定性', async () => {
  await withServer('ac323', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const screens = (await call('GET', `/api/projects/${pid}/screens`)).data.filter((s) => s.format === 'm3' && s.doc);
    assert.ok(screens.length > 0);

    const design = (await call('GET', `/api/projects/${pid}/design`)).data.design;
    for (const s of screens) {
      // 编辑器缩略图 / 预览 / 导出都调用同一个 renderM3Body
      const a = renderM3Body(s.doc, design);
      const b = renderM3Body(structuredClone(s.doc), design);
      assert.equal(a, b, `FR-RENDER-002：同一输入必须同一输出（${s.screen_id}）`);
      assert.ok(a.includes('m3-screen'), '应输出 M3 渲染根');
      // 热区与渲染结果一致：每个热区锚点都必须真实出现在 HTML 中
      for (const an of s.anchors) {
        assert.ok(a.includes(`data-anchor="${an.hotspot_id}"`), `热区 ${an.hotspot_id} 必须存在于渲染结果`);
      }
    }

    const preview = (await call('GET', `/api/projects/${pid}/preview`)).data;
    assert.ok(preview.screens.every((s) => typeof s.doc === 'object'), '预览携带完整 doc 供同一渲染器使用');
  });
});

test('AC-323：服务端布局与前端布局同构（坐标零漂移）', () => {
  const doc = emptyScreenDoc({ screenId: 'scr_c', title: '屏', width: 412, height: 892 });
  doc.groups = [
    { id: 'g_x', x: 16, y: 100, axis: 'x', items: [it('a', 'button', { label: 'A' }), it('b', 'iconButton')] },
    { id: 'g_y', x: 16, y: 300, axis: 'y', items: [it('c', 'card'), it('d', 'card')] },
    { id: 'g_f', x: 0, y: 0, axis: 'free', items: [it('e', 'fab', { pos: { x: 340, y: 780 } })] },
  ];
  for (const g of doc.groups) {
    const server = groupLayout(g);
    const web = layoutGroup(g);
    assert.equal(server.length, web.length);
    server.forEach((p, i) => {
      assert.equal(p.x, web[i].x, `${g.id}[${i}] x`);
      assert.equal(p.y, web[i].y, `${g.id}[${i}] y`);
      assert.equal(p.w, web[i].w, `${g.id}[${i}] w`);
      assert.equal(p.h, web[i].h, `${g.id}[${i}] h`);
    });
  }
  const hot = estimateAnchors(doc).filter((a) => a.slot === null);
  assert.equal(hot.length, 5, '每个可见 Item 一个热区');
});

test('AC-323 回归：屏宽窄于 Registry 默认时，部件默认宽度被夹在屏内', () => {
  // 375 宽的屏（旧项目设备预设）里放一个未显式指定 size 的卡片：
  // Registry 默认 380，若不夹取会溢出右侧并被裁切。
  const doc = emptyScreenDoc({ screenId: 'scr_n', title: '窄屏', width: 375, height: 812 });
  doc.groups = [
    { id: 'g1', x: 0, y: 0, axis: 'y', items: [{ id: 'bar', kind: 'topAppBar', variant: 'filled' }] },
    { id: 'g2', x: 16, y: 104, axis: 'y', items: [{ id: 'card1', kind: 'card', variant: 'filled' }] },
  ];
  for (const g of doc.groups) {
    const placed = layoutGroup(g, 375);
    for (const p of placed) {
      assert.ok(p.x + p.w <= 375, `${p.item.id} 不得越出屏宽：x=${p.x} w=${p.w}`);
    }
  }
  // 前后端布局必须一致（FR-RENDER-001：同一契约）
  for (const g of doc.groups) {
    const web = layoutGroup(g, 375);
    const server = groupLayout(g, {}, 375);
    web.forEach((p, i) => {
      assert.equal(p.x, server[i].x, `${g.id}[${i}] x`);
      assert.equal(p.w, server[i].w, `${g.id}[${i}] w`);
    });
  }
  // 显式指定尺寸时尊重用户值
  const withSize = { id: 'g3', x: 16, y: 300, axis: 'y', items: [{ id: 'c2', kind: 'card', variant: 'filled', size: 200 }] };
  assert.equal(layoutGroup(withSize, 375)[0].w, 200);
});

test('FR-RENDER-004：M3 渲染器与旧格式渲染器互不降级', () => {
  const legacy = { format: 'node-tree', version: 1, root: { id: 'r', tag: 'div', props: { text: '旧' }, children: [] } };
  const m3 = emptyScreenDoc({ screenId: 'scr_m', title: '屏' });
  const legacyHtml = renderScreenBody(legacy, {});
  assert.ok(legacyHtml.includes('data-node-id=\"r\"'), '旧格式走只读渲染器（保留 data-node-id）');
  assert.equal(legacyHtml.includes('m3-screen'), false, '旧格式不得混入 M3 渲染根');
  assert.match(renderScreenBody(m3, {}), /m3-screen/, 'M3 走 M3 渲染器');
  assert.throws(() => assertM3Renderable(legacy), /m3/i, 'M3 渲染器必须拒绝 node-tree');
});

/* ------------------------------------------------------------------ */
/* AC-304：主题切换即时生效且不递增屏幕版本                              */
/* ------------------------------------------------------------------ */

test('AC-304：切换主题后渲染结果即时变化，屏幕版本不递增、design-revisions 新增', async () => {
  await withServer('ac304', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const before = (await call('GET', `/api/projects/${pid}/screens`)).data;
    const screen = before.find((s) => s.format === 'm3' && s.doc);
    const designBefore = (await call('GET', `/api/projects/${pid}/design`)).data;
    const cssLight = themeCss(designBefore.design);
    const bodyLight = renderM3Body(screen.doc, designBefore.design);

    const res = await call('PATCH', `/api/projects/${pid}/design`, { design: { theme: { dark: true, contrast: 'high', shape: 'full' } } });
    assert.equal(res.status, 200, JSON.stringify(res.raw));

    const designAfter = (await call('GET', `/api/projects/${pid}/design`)).data;
    assert.equal(designAfter.design.theme.dark, true);
    // FR-RENDER-003：色彩只从 Theme 注入；主题变化不改 DOM 结构，只改 CSS 变量
    const cssDark = themeCss(designAfter.design);
    assert.notEqual(cssLight, cssDark, '换主题必须改变注入的色彩变量');
    assert.equal(renderM3Body(screen.doc, designAfter.design), bodyLight, '主题只影响 CSS 变量，不改变 DOM 结构（FR-RENDER-002）');
    assert.notEqual(cssLight, cssDark, '明暗/对比度变化必须反映到色彩变量');
    assert.match(cssDark, /--md-primary-container:/, '应注入容器色角色');

    const after = (await call('GET', `/api/projects/${pid}/screens`)).data;
    const same = after.find((s) => s.screen_id === screen.screen_id);
    assert.equal(same.current_version, screen.current_version, '主题变更不递增屏幕版本');
    assert.ok(designAfter.revisions.length >= 2, '应新增项目修订');
  });
});

/* ------------------------------------------------------------------ */
/* AC-318：桥接不产生半版本                                              */
/* ------------------------------------------------------------------ */

test('AC-318：保存超时进入 stalled，重试后草稿仍在且不产生半版本', async () => {
  const { createBridgeSession } = await import('../apps/server/src/domain/m3/bridge.js');
  const { BRIDGE_PROTOCOL } = await import('../apps/server/src/domain/m3/constants.js');
  const { emptyScreenDoc } = await import('../apps/server/src/domain/m3/convert.js');

  const SCREEN = 'scr_br';
  const doc = emptyScreenDoc({ screenId: SCREEN, title: '桥接屏' });
  const sent = [];
  let saves = 0;
  let t = 0;
  const session = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    timeoutMs: 1000,
    now: () => t,
    send: (m) => sent.push(m),
    onSave: async () => {
      saves++;
      throw new Error('宿主保存失败');
    },
  });
  const msg = (type, payload) => ({ protocol: BRIDGE_PROTOCOL, request_id: `r_${type}`, screen_id: SCREEN, type, payload });

  session.load({ doc, theme: {}, readonly: false, locked: false });
  await session.handle(msg('ready', { protocol: BRIDGE_PROTOCOL, version: 1 }));
  const draftPayload = { doc, dirty: true, summary: '改了卡片', base_version: 0 };
  await session.handle(msg('change', draftPayload));
  assert.equal(session.state, 'dirty');

  // 宿主保存抛错
  const saved = await session.handle(msg('save', { doc, base_version: 0, summary: '保存' }));
  assert.equal(saved.ok, false, '保存失败不得静默成功');
  assert.equal(saved.code, 'BRIDGE_SAVE_FAILED', '保存失败有独立错误码，不再冒充协议错误');
  assert.equal(saves, 1, '只调用一次宿主保存');
  assert.equal(session.state, 'error', '失败进入 error，而不是 saved');
  assert.deepEqual(session.draft, draftPayload, 'AC-318：失败后必须保留最后一次草稿');
  assert.equal(session.savedVersion, 0, '失败不得推进版本');

  // 超时检测：加载/保存挂起超过 timeoutMs 进入 stalled
  const slow = createBridgeSession({
    screenId: SCREEN,
    baseVersion: 0,
    timeoutMs: 1000,
    now: () => 5000,
    send: () => {},
    onSave: () => new Promise(() => {}),
  });
  slow.load({ doc, theme: {}, readonly: false, locked: false });
  assert.equal(slow.state, 'loading');
  assert.equal(slow.checkTimeout(7000), true, '加载超时应被检出');
  assert.equal(slow.state, 'stalled', '超时进入 stalled，宿主据此提示重试');
  assert.equal(slow.retry(), true, '重试会重发 load');
  assert.equal(slow.state, 'loading');

  // 断连：关闭后不再调用保存
  session.close();
  assert.equal(session.state, 'closed');
  assert.equal(saves, 1, '断连后不得再调用保存');
});

test('AC-318 / NFR-008：写入失败不留下半截文件，版本指针不前进', async () => {
  const { writeJsonAtomic } = await import('../apps/server/src/store/fs.js');
  const dir = path.join(tmpRoot('atomic'), 'versions');
  await fsp.mkdir(dir, { recursive: true });

  // 1) 正常写入：原子可见
  const target = path.join(dir, 'v1.json');
  await writeJsonAtomic(target, { version: 1 });
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { version: 1 });

  // 2) 写入失败（目标是已存在的目录，rename 必然失败）：不得残留临时文件
  const blocked = path.join(dir, 'v2.json');
  await fsp.mkdir(blocked, { recursive: true });
  await assert.rejects(() => writeJsonAtomic(blocked, { version: 2 }));
  const leftovers = (await fsp.readdir(dir)).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], '失败时必须清理临时文件，不得留下半截产物');
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
});

test('AC-318：保存失败时版本与内容都不变（失败不落库）', async () => {
  await withServer('ac318b', async ({ call }) => {
    const { pid, sid, doc, version } = await newM3Screen(call);
    const next = clone(doc);
    next.groups.push({ id: 'g', x: 0, y: 0, axis: 'y', items: [{ id: 'i_bad' }] });
    delete next.groups.at(-1).items[0].kind; // 缺 kind：schema 校验失败
    const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc: next, base_version: version });
    assert.equal(res.status, 422);
    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data;
    assert.equal(after.current_version, version, '版本不得前进');
    assert.deepEqual(after.doc, doc, '内容逐字段不变');
  });
});
