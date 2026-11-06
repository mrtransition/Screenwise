import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, client, listen } from './helpers.mjs';
import { docToSrcdoc, nodeToHtml } from '../apps/web/src/render.js';

/**
 * 空间编辑验收（FR-SPACE-001/003/004/005/007，DC-010 / DC-014 / NFR-018）
 *
 * UI 在画布 iframe 内双击文字叶子节点，失焦 / Enter 时只提交一次；
 * 服务端仍然只认 manual-patch 这一条写路径，并统一做锁定、待确认、权限校验。
 */

async function withServer(fn) {
  const ctx = freshServer();
  await listen(ctx.server);
  const call = client(ctx.server);
  try {
    return await fn({ ...ctx, call });
  } finally {
    ctx.server.close();
  }
}

const walk = (n, fn) => {
  fn(n);
  for (const c of n.children || []) walk(c, fn);
};

const findByText = (root, text) => {
  let hit = null;
  walk(root, (n) => {
    if (!hit && n.props?.text === text) hit = n;
  });
  return hit;
};

/** 建一个已生成登录页的项目：空屏基线 v1 + 生成 v2 */
async function seed(call) {
  const p = (await call('POST', '/api/projects', { name: '空间编辑验收' })).data;
  const pk = `/api/projects/${p.project_id}`;
  const s = (await call('POST', `${pk}/screens`, { title: '登录页', format: 'node-tree' })).data;
  const g = await call('POST', `${pk}/screens/${s.screen_id}/generations`, {
    prompt: '登录页，手机号验证码登录',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200, JSON.stringify(g.raw));
  const a = await call('POST', `${pk}/screens/${s.screen_id}/pending/apply`);
  assert.equal(a.status, 200, JSON.stringify(a.raw));
  return { p, pk, s };
}

test('AC-201：直接改文案生成一条 manual_direct 版本，摘要是「旧 → 新」', async () => {
  await withServer(async ({ call }) => {
    const { pk, s } = await seed(call);
    const before = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    const title = findByText(before.doc.root, '欢迎回来');
    assert.ok(title, '模板里应有标题节点');
    const v0 = before.current_version;

    const edit = await call('POST', `${pk}/screens/${s.screen_id}/manual-patch`, {
      ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: '晚上好' } }],
      edit_scope: 'component',
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.raw));
    assert.equal(edit.data.version, v0 + 1, '一次编辑只产生一个版本');

    const versions = (await call('GET', `${pk}/screens/${s.screen_id}/versions`)).data;
    assert.equal(versions.current_version, v0 + 1);
    const latest = versions.versions.find((v) => v.version === v0 + 1);
    assert.equal(latest.change_source, 'manual_direct');
    assert.equal(latest.route_layer, 'manual');
    assert.equal(latest.ai_cost, 0);
    assert.match(latest.change_summary, /手工修改文案/);
    assert.match(latest.change_summary, /欢迎回来/);
    assert.match(latest.change_summary, /晚上好/);

    const after = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    assert.equal(findByText(after.doc.root, '晚上好')?.id, title.id);
    assert.equal(findByText(after.doc.root, '欢迎回来'), null);
  });
});

test('FR-SPACE-005：空间编辑可被版本撤销恢复，且不删除历史', async () => {
  await withServer(async ({ call }) => {
    const { pk, s } = await seed(call);
    const base = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    const title = findByText(base.doc.root, '欢迎回来');

    await call('POST', `${pk}/screens/${s.screen_id}/manual-patch`, {
      ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: '你好' } }],
    });
    const undo = await call('POST', `${pk}/screens/${s.screen_id}/undo`);
    assert.equal(undo.status, 200, JSON.stringify(undo.raw));
    assert.equal(undo.data.version, base.current_version);

    const restored = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    assert.equal(findByText(restored.doc.root, '欢迎回来')?.id, title.id);
    assert.equal(restored.current_version, base.current_version);

    // 历史仍保留被撤销的那一版
    const versions = (await call('GET', `${pk}/screens/${s.screen_id}/versions`)).data;
    assert.ok(versions.versions.some((v) => v.version === base.current_version + 1), '撤销不得删除历史版本');
  });
});

test('AC-202 / DC-014：锁定屏拒绝空间编辑，版本号不递增', async () => {
  await withServer(async ({ call }) => {
    const { pk, s } = await seed(call);
    const before = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    const title = findByText(before.doc.root, '欢迎回来');

    await call('POST', `${pk}/screens/${s.screen_id}/lock`, { reason: '定稿' });
    const edit = await call('POST', `${pk}/screens/${s.screen_id}/manual-patch`, {
      ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: '不应落库' } }],
    });
    assert.equal(edit.status, 423, JSON.stringify(edit.raw));
    assert.equal(edit.error.code, 'SCREEN_LOCKED');

    const after = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    assert.equal(after.current_version, before.current_version);
    assert.equal(findByText(after.doc.root, '欢迎回来')?.id, title.id);
  });
});

test('边界：存在待确认结果时拒绝空间编辑，避免 pending 立刻过期', async () => {
  await withServer(async ({ call }) => {
    const { pk, s } = await seed(call);
    const before = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    const title = findByText(before.doc.root, '欢迎回来');

    const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, {
      prompt: '把登录按钮改成立即进入',
      edit_scope: 'screen',
    });
    assert.equal(gen.status, 200, JSON.stringify(gen.raw));

    const edit = await call('POST', `${pk}/screens/${s.screen_id}/manual-patch`, {
      ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: '不应落库' } }],
    });
    assert.equal(edit.status, 409, JSON.stringify(edit.raw));
    assert.equal(edit.error.detail?.code, 'PENDING_EXISTS');

    const after = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
    assert.equal(after.current_version, before.current_version);
    assert.ok(after.pending, '待确认结果必须保留');
  });
});

test('NFR-018：只读成员的空间编辑被服务端拒绝', async () => {
  await withServer(async ({ call, repo }) => {
    const { p, pk, s } = await seed(call);
    await repo.updateProject(p.project_id, (proj) => ({
      ...proj,
      members: [...(proj.members || []), { user: 'viewer', role: 'readonly' }],
    }));
    const doc = (await call('GET', `${pk}/screens/${s.screen_id}`)).data.doc;
    const title = findByText(doc.root, '欢迎回来');

    const edit = await call(
      'POST',
      `${pk}/screens/${s.screen_id}/manual-patch`,
      { ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: 'x' } }] },
      { 'x-proto-user': 'viewer' }
    );
    assert.equal(edit.status, 403);
    assert.equal(edit.error.code, 'NO_PERMISSION');
  });
});

test('客户端契约：编辑态只给文字叶子节点打 data-editable，并注入一次性提交脚本', () => {
  const doc = {
    version: 1,
    root: {
      id: 'root',
      tag: 'div',
      props: { style: { display: 'flex' }, attrs: {} },
      children: [
        {
          id: 'title',
          tag: 'span',
          props: { style: { fontSize: 28 }, attrs: {}, text: '欢迎回来' },
          children: [],
        },
        {
          id: 'btn',
          tag: 'button',
          props: { style: {}, attrs: { 'data-anchor': 'login_submit' }, text: '登录' },
          children: [],
        },
        {
          id: 'mixed',
          tag: 'div',
          props: { style: {}, attrs: {}, text: '容器上的文字' },
          children: [{ id: 'child', tag: 'span', props: { text: '子文字' }, children: [] }],
        },
      ],
    },
  };

  const html = nodeToHtml(doc.root, { editable: true });
  assert.match(html, /data-node-id="title"[^>]*data-editable="1"/);
  assert.match(html, /data-node-id="btn"[^>]*data-editable="1"/);
  assert.doesNotMatch(html, /data-node-id="root"[^>]*data-editable/);
  assert.doesNotMatch(html, /data-node-id="mixed"[^>]*data-editable/, '带子节点的容器不能被就地编辑');

  const editablePage = docToSrcdoc(doc, { editable: true, screenId: 'scr_demo' });
  assert.match(editablePage, /proto:edit/);
  assert.match(editablePage, /dblclick/);
  assert.match(editablePage, /addEventListener\('blur'/);
  assert.doesNotMatch(editablePage, /addEventListener\('input'/, '逐键输入不得落库');
  assert.match(editablePage, /scr_demo/);
  assert.doesNotMatch(editablePage, /body\{pointer-events:none\}/);

  const readOnlyPage = docToSrcdoc(doc, { screenId: 'scr_demo' });
  assert.doesNotMatch(readOnlyPage, /data-editable/);
  assert.match(readOnlyPage, /body\{pointer-events:none\}/);
});
