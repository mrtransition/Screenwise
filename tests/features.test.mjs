import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshServer, client, listen } from './helpers.mjs';
import { walk } from '../apps/server/src/domain/doc.js';
import { docToSrcdoc } from '../apps/web/src/render.js';

/**
 * 后续功能验收：区域选择、设计规范、版本撤销/对比、屏幕排序、
 * 只读成员、导出路径安全、patch 白名单与解锁状态。
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

async function makeProject(call, { name = '测试项目', tokens } = {}) {
  const res = await call('POST', '/api/projects', { name, ...(tokens ? { design_tokens: tokens } : {}) });
  assert.equal(res.status, 200, JSON.stringify(res.raw));
  return res.data;
}

async function makeScreen(call, pid, title) {
  // 本文件验证旧 node-tree 契约（root/节点树）；新建屏默认 M3 的用例见 m2-editor.test.mjs
  const res = await call('POST', `/api/projects/${pid}/screens`, { title, format: 'node-tree' });
  assert.equal(res.status, 200, JSON.stringify(res.raw));
  return res.data;
}

async function generateAndApply(call, pid, sid, prompt) {
  const g = await call('POST', `/api/projects/${pid}/screens/${sid}/generations`, { prompt, edit_scope: 'screen' });
  assert.equal(g.status, 200, JSON.stringify(g.raw));
  const a = await call('POST', `/api/projects/${pid}/screens/${sid}/pending/apply`);
  assert.equal(a.status, 200, JSON.stringify(a.raw));
  return a.data.version;
}

function findNode(root, predicate) {
  let hit = null;
  walk(root, (n) => {
    if (!hit && predicate(n)) hit = n;
  });
  return hit;
}

test('FR-GEN-004/005：区域选择必须带真实节点，且只改选区内容', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '登录页');
    await generateAndApply(call, p.project_id, s.screen_id, '登录页，手机号验证码登录');
    const doc = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data.doc;
    const target = findNode(doc.root, (n) => n.props?.text === '忘记密码？');
    assert.ok(target, '登录模板应包含「忘记密码？」');

    // 1) region 不提供 selection：请求侧直接拒绝
    const missing = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`, {
      prompt: '把忘记密码改成找回密码',
      edit_scope: 'region',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.error.detail?.code, 'SELECTION_REQUIRED');

    // 2) selection 指向不存在的节点：拒绝，且不进入模型调用
    const bogus = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`, {
      prompt: '把忘记密码改成找回密码',
      edit_scope: 'region',
      selection: { node_ids: ['not-a-real-node'] },
    });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.error.detail?.code, 'SELECTION_NOT_FOUND');

    // 3) 合法选区：只改选中的文本节点
    const ok = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`, {
      prompt: '把「忘记密码？」改成「找回密码」',
      edit_scope: 'region',
      selection: { node_ids: [target.id] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.raw));
    assert.equal(ok.data.mode, 'patch');
    assert.equal(ok.data.edit_scope, 'region');

    const applied = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/pending/apply`);
    assert.equal(applied.status, 200);
    const next = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data.doc;
    assert.equal(findNode(next.root, (n) => n.id === target.id).props.text, '找回密码');
    // 选区外的标题保持原样
    assert.equal(findNode(next.root, (n) => n.props?.text === '欢迎回来').props.text, '欢迎回来');
  });
});

test('FR-PROJ-002：设计 token 注入生成，且局部更新不会覆盖其它分组', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call, {
      tokens: {
        colors: { primary: '#ff6600', text: '#222222' },
        radius: { sm: 16, md: 20, lg: 24 },
        font: { base: 16, family: 'Georgia, serif' },
      },
    });
    assert.equal(p.design_tokens.colors.primary, '#ff6600');
    const s = await makeScreen(call, p.project_id, '登录页');
    await generateAndApply(call, p.project_id, s.screen_id, '登录页，手机号验证码登录');
    const doc = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data.doc;

    assert.equal(doc.root.props.style.fontSize, 16, '根节点字号应来自 token');
    assert.equal(doc.root.props.style.fontFamily, 'Georgia, serif');
    const forgot = findNode(doc.root, (n) => n.props?.text === '忘记密码？');
    assert.equal(forgot.props.style.color, '#ff6600', '强调文字应使用主色');

    // 只提交 colors.text，radius 必须保留
    const patch = await call('PATCH', `/api/projects/${p.project_id}/tokens`, {
      design_tokens: { colors: { text: '#333333' } },
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.raw));
    assert.equal(patch.data.design_tokens.colors.text, '#333333');
    assert.equal(patch.data.design_tokens.colors.primary, '#ff6600');
    assert.equal(patch.data.design_tokens.radius.md, 20);
  });
});

test('FR-PATCH-005 / FR-VER-004：撤销最近变更，并给出节点级对比明细', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '登录页');
    await generateAndApply(call, p.project_id, s.screen_id, '登录页，手机号验证码登录');
    const before = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data.doc;
    const title = findNode(before.root, (n) => n.props?.text === '欢迎回来');

    const manual = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/manual-patch`, {
      ops: [{ op: 'updateProps', target: { node_id: title.id }, value: { text: '你好，欢迎回来' } }],
    });
    assert.equal(manual.status, 200, JSON.stringify(manual.raw));
    assert.equal(manual.data.version, 3);

    const diff = await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}/diff?a=2&b=3`);
    assert.equal(diff.status, 200);
    const changed = diff.data.details.changed.find((x) => x.node_id === title.id);
    assert.ok(changed, '对比明细必须包含被修改节点');
    assert.equal(changed.before.text, '欢迎回来');
    assert.equal(changed.after.text, '你好，欢迎回来');

    const undo = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/undo`);
    assert.equal(undo.status, 200, JSON.stringify(undo.raw));
    assert.equal(undo.data.version, 2);
    assert.equal(undo.data.undone_from, 3);
    const restored = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data;
    assert.equal(restored.current_version, 2);
    assert.equal(findNode(restored.doc.root, (n) => n.id === title.id).props.text, '欢迎回来');
  });
});

test('FR-PROJ-004 / NFR-009：只读成员不能写屏幕、版本或设计规范', async () => {
  await withServer(async ({ call, repo }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '登录页');
    await repo.updateProject(p.project_id, (proj) => ({
      ...proj,
      members: [...(proj.members || []), { user: 'viewer', role: 'readonly' }],
    }));
    const asViewer = { 'x-proto-user': 'viewer' };

    // 读允许
    const read = await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`, undefined, asViewer);
    assert.equal(read.status, 200);

    const write = await call('POST', `/api/projects/${p.project_id}/screens`, { title: '新屏' }, asViewer);
    assert.equal(write.status, 403);
    assert.equal(write.error.code, 'NO_PERMISSION');

    const gen = await call(
      'POST',
      `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`,
      { prompt: '登录页', edit_scope: 'screen' },
      asViewer
    );
    assert.equal(gen.status, 403);
    assert.equal(gen.error.code, 'NO_PERMISSION');

    const tokens = await call(
      'PATCH',
      `/api/projects/${p.project_id}/tokens`,
      { design_tokens: { colors: { primary: '#000000' } } },
      asViewer
    );
    assert.equal(tokens.status, 403);
    assert.equal(tokens.error.code, 'NO_PERMISSION');

    // owner 仍可写
    const ownerWrite = await call('POST', `/api/projects/${p.project_id}/screens`, { title: '新屏' });
    assert.equal(ownerWrite.status, 200);
  });
});

test('FR-PROJ-003：屏幕排序持久化，拒绝不属于本项目的 id', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call);
    const a = await makeScreen(call, p.project_id, 'A');
    const b = await makeScreen(call, p.project_id, 'B');
    const c = await makeScreen(call, p.project_id, 'C');

    const res = await call('POST', `/api/projects/${p.project_id}/screens/reorder`, {
      ordered_ids: [c.screen_id, a.screen_id, b.screen_id],
    });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.deepEqual(res.data.map((x) => x.title), ['C', 'A', 'B']);
    assert.deepEqual(res.data.map((x) => x.order), ['0001', '0002', '0003']);

    const list = (await call('GET', `/api/projects/${p.project_id}/screens`)).data;
    assert.deepEqual(list.map((x) => x.title), ['C', 'A', 'B']);

    const bad = await call('POST', `/api/projects/${p.project_id}/screens/reorder`, {
      ordered_ids: [a.screen_id, 'scr_other_project'],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.error.message, /不属于该项目/);
  });
});

test('FR-PATCH-001：patch op / selector / value 白名单在落库前生效', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '登录页');
    await generateAndApply(call, p.project_id, s.screen_id, '登录页，手机号验证码登录');
    const doc = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data.doc;
    const node = findNode(doc.root, (n) => n.props?.text === '欢迎回来');
    const base = `/api/projects/${p.project_id}/screens/${s.screen_id}/manual-patch`;

    const unknownOp = await call('POST', base, {
      ops: [{ op: 'dropTable', target: { node_id: node.id } }],
    });
    assert.equal(unknownOp.status, 422);
    assert.equal(unknownOp.error.code, 'INVALID_OUTPUT');

    const badStyle = await call('POST', base, {
      ops: [{ op: 'setStyle', target: { node_id: node.id }, value: { style: 'color:red' } }],
    });
    assert.equal(badStyle.status, 422);

    const badSelector = await call('POST', base, {
      ops: [{ op: 'updateProps', target: { selector: { type: 'nth-child', value: '2' } }, value: { text: 'x' } }],
    });
    assert.equal(badSelector.status, 422);

    // 以上都不得产生版本
    const versions = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}/versions`)).data;
    assert.equal(versions.current_version, 2);
  });
});

test('FR-VER-005：解锁后状态回到 draft / applied，而不是一律 applied', async () => {
  await withServer(async ({ call }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '空屏');
    const base = `/api/projects/${p.project_id}/screens/${s.screen_id}`;

    await call('POST', `${base}/lock`, { reason: 'test' });
    let meta = (await call('GET', base)).data;
    assert.equal(meta.locked, true);
    assert.equal(meta.status, 'locked');

    await call('POST', `${base}/unlock`, { reason: 'test' });
    meta = (await call('GET', base)).data;
    assert.equal(meta.locked, false);
    assert.equal(meta.status, 'draft', '只有空屏基线时解锁应回到 draft');

    await generateAndApply(call, p.project_id, s.screen_id, '登录页，手机号验证码登录');
    await call('POST', `${base}/lock`, { reason: 'test' });
    await call('POST', `${base}/unlock`, { reason: 'test' });
    meta = (await call('GET', base)).data;
    assert.equal(meta.status, 'applied', '有内容时解锁应回到 applied');
  });
});

test('FR-EXPORT-001：导出目录名清洗，不能越出 exports 根目录', async () => {
  await withServer(async ({ call, repoRoot }) => {
    const p = await makeProject(call);
    const s = await makeScreen(call, p.project_id, '登录页');
    const res = await call('POST', `/api/projects/${p.project_id}/export`, {
      start: s.screen_id,
      name: '../../evil:name*?',
    });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    const exportsRoot = path.resolve(repoRoot, '..', 'exports');
    const rel = path.relative(exportsRoot, res.data.dir);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `导出目录越界: ${res.data.dir}`);
    assert.ok(!/[<>:"/\\|?*]/.test(path.basename(res.data.dir)), '目录名不得包含 Windows 非法字符');

    const reserved = await call('POST', `/api/projects/${p.project_id}/export`, { start: s.screen_id, name: 'CON' });
    assert.equal(reserved.status, 200, JSON.stringify(reserved.raw));
    assert.notEqual(path.basename(reserved.data.dir).toUpperCase(), 'CON', 'Windows 保留名必须被替换');
  });
});

test('FR-GEN-004 前端支撑：选区高亮与恶意 node id 的 CSS 转义', () => {
  const evil = 'n"]{background:red}';
  const doc = {
    version: 1,
    root: {
      id: 'root',
      tag: 'div',
      props: { style: {}, attrs: {} },
      children: [{ id: evil, tag: 'span', props: { text: '危险节点', style: {}, attrs: {} }, children: [] }],
    },
  };
  const html = docToSrcdoc(doc, { selectable: true, selectedNodeIds: [evil], highlightMap: { [evil]: '#f59e0b' } });
  assert.match(html, /proto:select/, '选择模式必须注入点击回传脚本');
  assert.ok(html.includes('[data-node-id="n\\"]{background:red}"]'), 'node id 必须做 CSS 字符串转义');
  assert.ok(!html.includes('body{pointer-events:none}'), '选择模式必须允许 iframe 内点击');
  const withNewline = docToSrcdoc(doc, { highlightMap: { 'a\nb': '#f59e0b' } });
  assert.ok(withNewline.includes('a\\a b'), '换行必须在 CSS 字符串中被转义');
  const readonly = docToSrcdoc(doc, {});
  assert.ok(readonly.includes('body{pointer-events:none}'), '只读渲染必须禁用指针事件');
});

test('关联模式热区测量：坐标必须是缩放无关的布局像素，并带上 screen_id 与组件宽高', () => {
  const doc = {
    version: 1,
    root: {
      id: 'root',
      tag: 'div',
      props: { style: {}, attrs: {} },
      children: [
        {
          id: 'btn',
          tag: 'button',
          props: { text: '登录', style: {}, attrs: { 'data-anchor': 'login_submit' } },
          children: [],
        },
      ],
    },
  };
  const html = docToSrcdoc(doc, { interactive: true, hotspots: true, measure: true, screenId: 'scr_demo' });
  // 用 offsetLeft/offsetTop/offsetWidth 累加，getBoundingClientRect 会被父级 transform:scale 影响
  assert.match(html, /offsetLeft/, '必须用布局像素测量，避免画布缩放把热区坐标带偏');
  assert.ok(!/getBoundingClientRect\(\)[\s\S]{0,200}\/\s*zoom/.test(html), '不能再按 zoom 做除法补偿');
  assert.ok(html.includes('"scr_demo"'), '回传消息必须带 screen_id，父页面据此定位节点');
  assert.match(html, /w:\s*w,\s*h:\s*h/, '必须回传组件宽高，用于在画布上还原热区框');
  assert.match(html, /proto:remeasure/, '必须响应父页面的重测请求');
});
