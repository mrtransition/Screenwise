import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, client, listen } from './helpers.mjs';
import { docToSrcdoc } from '../apps/web/src/render.js';

/**
 * M3 屏幕的选区 / 区域组件生成验收（FR-GEN-004 / FR-GEN-005 / FR-SPACE-001）。
 *
 * 真实缺陷：M3 屏渲染出的是 data-item-id，但选择脚本只认 data-node-id，
 * 服务端选区校验也只遍历 doc.root —— M3 屏在「区域 / 组件」范围下永远点不中组件，
 * 提交时还会被 SELECTION_NOT_FOUND 拒掉。这里锁住整条链路。
 */

async function withServer(fn) {
  const ctx = freshServer({});
  await listen(ctx.server);
  const call = client(ctx.server);
  try {
    return await fn(call);
  } finally {
    ctx.server.close();
  }
}

/** 建一屏真实 M3 ScreenDoc：标题 / 副标题 / 输入框 / 按钮 */
async function seedM3(call) {
  const p = (await call('POST', '/api/projects', { name: 'M3 选区' })).data;
  const pk = `/api/projects/${p.project_id}`;
  const s = (await call('POST', `${pk}/screens`, { title: '登录页' })).data;
  const sid = s.screen_id;
  const doc = {
    schema: 'm3studio/screen@1',
    version: 1,
    format: 'm3',
    frame: { id: sid, name: '登录页', x: 0, y: 0, w: 375, h: 812 },
    groups: [
      {
        id: 'grp_head',
        axis: 'free',
        x: 0,
        y: 0,
        items: [
          { id: 'itm_title', kind: 'text', variant: 'text', label: '欢迎回来', pos: { x: 24, y: 80 } },
          { id: 'itm_sub', kind: 'text', variant: 'text', label: '登录后继续你的工作', pos: { x: 24, y: 128 } },
        ],
      },
      {
        id: 'grp_form',
        axis: 'free',
        x: 0,
        y: 0,
        items: [
          { id: 'itm_phone', kind: 'textField', variant: 'outlined', label: '手机号', placeholder: '请输入手机号', pos: { x: 24, y: 200 }, w: 327 },
          { id: 'itm_submit', kind: 'button', variant: 'filled', label: '登录', pos: { x: 24, y: 280 }, w: 327 },
        ],
      },
    ],
  };
  const saved = await call('POST', `${pk}/screens/${sid}/doc`, { base_version: 1, doc });
  assert.equal(saved.status, 200, JSON.stringify(saved.raw));
  return { pk, sid };
}

const itemsOf = (doc) => doc.groups.flatMap((g) => g.items);
const itemById = (doc, id) => itemsOf(doc).find((i) => i.id === id);

test('M3 画布：选择脚本认 data-item-id，点击组件能回传 item id', () => {
  const doc = {
    schema: 'm3studio/screen@1',
    version: 1,
    format: 'm3',
    frame: { id: 's1', name: 'x', x: 0, y: 0, w: 375, h: 812 },
    groups: [{ id: 'g1', axis: 'free', items: [{ id: 'itm_a', kind: 'text', variant: 'text', label: 'A', pos: { x: 0, y: 0 } }] }],
  };
  const html = docToSrcdoc(doc, { selectable: true, screenId: 's1' });
  assert.match(html, /data-item-id="itm_a"/, 'M3 渲染必须带 data-item-id');
  assert.match(html, /proto:select/, '选择模式必须注入点击回传脚本');
  assert.ok(html.includes("'data-node-id, data-item-id, [data-anchor]'"), 'closest() 的选择器必须是合法 JS 字符串，不能被 JSON.stringify 加引号');
  assert.ok(html.includes('getAttribute(\'data-item-id\')'), '脚本必须能从 data-item-id 取回 item id');
  assert.ok(!html.includes('body{pointer-events:none}'), '选择模式必须允许 iframe 内点击');
});

test('M3 区域范围：选中 Item 后文案替换生效，且只改选中的组件', async () => {
  await withServer(async (call) => {
    const { pk, sid } = await seedM3(call);
    const g = await call('POST', `${pk}/screens/${sid}/generations`, {
      prompt: '把「登录后继续你的工作」改成「登录以同步你的数据」',
      edit_scope: 'region',
      selection: { node_ids: ['itm_sub'] },
    });
    assert.equal(g.status, 200, JSON.stringify(g.raw));
    assert.equal(g.data.mode, 'patch');
    assert.equal(itemById(g.data.preview_doc, 'itm_sub').label, '登录以同步你的数据', 'M3 文案必须落在渲染器真正读的 label 上');
    assert.equal(itemById(g.data.preview_doc, 'itm_title').label, '欢迎回来', '选区外的组件不能被改动');
  });
});

test('M3 组件范围：选中按钮后改文案，其它 Item 与组结构保持不变', async () => {
  await withServer(async (call) => {
    const { pk, sid } = await seedM3(call);
    const g = await call('POST', `${pk}/screens/${sid}/generations`, {
      prompt: '把「登录」改成「立即进入」',
      edit_scope: 'component',
      selection: { node_ids: ['itm_submit'] },
    });
    assert.equal(g.status, 200, JSON.stringify(g.raw));
    const doc = g.data.preview_doc;
    assert.equal(itemById(doc, 'itm_submit').label, '立即进入');
    assert.equal(itemById(doc, 'itm_title').label, '欢迎回来');
    assert.equal(doc.groups.length, 2, 'patch 不得改动分组结构');
  });
});

test('M3 选区校验：可选区集合按 Item 取，非法 id 仍被拒绝', async () => {
  await withServer(async (call) => {
    const { pk, sid } = await seedM3(call);
    const ok = await call('POST', `${pk}/screens/${sid}/generations`, {
      prompt: '把「欢迎回来」改成「晚上好」',
      edit_scope: 'region',
      selection: { node_ids: ['itm_title'] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.raw));

    const bad = await call('POST', `${pk}/screens/${sid}/generations`, {
      prompt: '随便改改',
      edit_scope: 'region',
      selection: { node_ids: ['itm_not_exist'] },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.error?.detail?.code, 'SELECTION_NOT_FOUND');
  });
});

test('M3 空间编辑：双击文案走 item id，写入 label 并生成人工版本', async () => {
  await withServer(async (call) => {
    const { pk, sid } = await seedM3(call);
    const base = (await call('GET', `${pk}/screens/${sid}`)).data.current_version;
    const r = await call('POST', `${pk}/screens/${sid}/manual-patch`, {
      edit_scope: 'component',
      ops: [{ op: 'updateProps', target: { node_id: 'itm_title' }, value: { text: '晚上好' } }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(itemById(r.data.doc, 'itm_title').label, '晚上好');

    const screen = await call('GET', `${pk}/screens/${sid}`);
    assert.equal(screen.data.current_version, base + 1);
  });
});

test('M3 局部 patch：item 不在本屏时拒绝落库，不改动原内容', async () => {
  await withServer(async (call) => {
    const { pk, sid } = await seedM3(call);
    const before = await call('GET', `${pk}/screens/${sid}`);
    const r = await call('POST', `${pk}/screens/${sid}/manual-patch`, {
      edit_scope: 'component',
      ops: [{ op: 'updateProps', target: { node_id: 'itm_ghost' }, value: { text: 'x' } }],
    });
    assert.equal(r.status, 422, JSON.stringify(r.raw));
    const after = await call('GET', `${pk}/screens/${sid}`);
    assert.equal(after.data.current_version, before.data.current_version, '失败不得产生版本');
  });
});
