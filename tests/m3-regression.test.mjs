import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, client, listen } from './helpers.mjs';

/**
 * M3 回归：整屏生成格式一致性、M3 版本对比、写入权限与关联边校验。
 * 这些是 M3 屏幕成为默认后暴露出的真实缺陷，独立于 M2 编辑器交互测试。
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

const item = (id, kind, label, extra = {}) => ({
  id,
  kind,
  label,
  variant: extra.variant ?? (kind === 'button' ? 'filled' : 'text'),
  ...extra,
});

async function createM3Screen(call, pid, title) {
  const res = await call('POST', `/api/projects/${pid}/screens`, { title, format: 'm3' });
  assert.equal(res.status, 200, JSON.stringify(res.raw));
  const det = await call('GET', `/api/projects/${pid}/screens/${res.data.screen_id}`);
  assert.equal(det.status, 200, JSON.stringify(det.raw));
  return { meta: res.data, doc: det.data.doc, version: det.data.current_version };
}

async function saveDoc(call, pid, sid, doc, base_version) {
  const res = await call('POST', `/api/projects/${pid}/screens/${sid}/doc`, { doc, base_version });
  assert.equal(res.status, 200, JSON.stringify(res.raw));
  return res.data;
}

test('M3 整屏生成：meta.format 与版本内容一致，预览/导出拿得到 groups', async () => {
  await withServer(async ({ call }) => {
    const p = (await call('POST', '/api/projects', { name: 'M3 生成回归' })).data;
    const pid = p.project_id;
    const s = await createM3Screen(call, pid, '登录页');

    const gen = await call('POST', `/api/projects/${pid}/screens/${s.meta.screen_id}/generations`, {
      prompt: '登录页，手机号验证码登录',
      edit_scope: 'screen',
    });
    assert.equal(gen.status, 200, JSON.stringify(gen.raw));
    assert.equal(gen.data.mode, 'full');

    const apply = await call('POST', `/api/projects/${pid}/screens/${s.meta.screen_id}/pending/apply`);
    assert.equal(apply.status, 200, JSON.stringify(apply.raw));

    const det = (await call('GET', `/api/projects/${pid}/screens/${s.meta.screen_id}`)).data;
    assert.equal(det.format, 'm3');
    assert.equal(det.doc.format, 'm3');
    assert.equal(det.doc.schema, 'm3studio/screen@1');
    assert.equal(det.doc.frame.id, s.meta.screen_id);
    assert.ok(Array.isArray(det.doc.groups), 'M3 版本必须有 groups');
    assert.ok(det.doc.groups.length > 0, '整屏生成后不应是空文档');
    assert.equal(det.doc.root, undefined, 'M3 屏幕不应再混入 node-tree root');

    // 版本记录只能有 prompt 摘要，不保存完整 Prompt 正文
    const version = (await call('GET', `/api/projects/${pid}/screens/${s.meta.screen_id}/versions/${apply.data.version}`)).data;
    assert.match(version.prompt_digest || '', /^sha256:/);
    assert.ok(!JSON.stringify(version).includes('登录页，手机号验证码登录'), '版本快照不得保存完整 Prompt');

    const preview = (await call('GET', `/api/projects/${pid}/preview`)).data;
    const pvScreen = preview.screens.find((x) => x.screen_id === s.meta.screen_id);
    assert.equal(pvScreen.format, 'm3');
    assert.ok(Array.isArray(pvScreen.doc.groups) && pvScreen.doc.groups.length > 0, '预览必须拿到 M3 groups');

    const exp = await call('POST', `/api/projects/${pid}/export`, { format: 'm3e' });
    assert.equal(exp.status, 200, JSON.stringify(exp.raw));
    assert.ok(exp.data.doc.frames.some((f) => f.id === s.meta.screen_id));
    assert.ok(exp.data.doc.groups.length > 0, 'M3E 导出必须包含生成的部件');
  });
});

test('M3 版本对比：按 Item 返回 added/removed/changed 明细', async () => {
  await withServer(async ({ call }) => {
    const p = (await call('POST', '/api/projects', { name: 'M3 diff' })).data;
    const pid = p.project_id;
    const s = await createM3Screen(call, pid, '详情页');
    const sid = s.meta.screen_id;

    const doc = structuredClone(s.doc);
    doc.groups = [
      {
        id: 'g1',
        x: 16,
        y: 16,
        axis: 'y',
        items: [item('title', 'text', '标题'), item('keep', 'text', '保留')],
      },
    ];
    await saveDoc(call, pid, sid, doc, s.version);

    const next = structuredClone(doc);
    next.groups[0].items[0].label = '新标题';
    next.groups[0].items.push(item('added', 'button', '新增按钮'));
    next.groups[0].items = next.groups[0].items.filter((x) => x.id !== 'keep');
    await saveDoc(call, pid, sid, next, s.version + 1);

    const diff = await call('GET', `/api/projects/${pid}/screens/${sid}/diff?a=2&b=3`);
    assert.equal(diff.status, 200, JSON.stringify(diff.raw));
    assert.deepEqual(diff.data.added, ['added']);
    assert.deepEqual(diff.data.removed, ['keep']);
    assert.deepEqual(diff.data.changed, ['title']);

    const changed = diff.data.details.changed.find((x) => x.node_id === 'title');
    assert.ok(changed);
    assert.equal(changed.before.text, '标题');
    assert.equal(changed.after.text, '新标题');
    assert.equal(changed.after.tag, 'text');
    assert.ok(diff.data.details.added.some((x) => x.node_id === 'added' && x.text === '新增按钮'));
  });
});

test('画布 / 测量缓存 / 关联边：只读成员与非法目标被拒绝', async () => {
  await withServer(async ({ call, repo }) => {
    const p = (await call('POST', '/api/projects', { name: '权限与校验' })).data;
    const pid = p.project_id;
    const a = await createM3Screen(call, pid, '首页');
    const b = await createM3Screen(call, pid, '详情');

    const doc = structuredClone(a.doc);
    doc.groups = [{ id: 'g1', x: 16, y: 16, axis: 'y', items: [item('open_detail', 'button', '打开详情')] }];
    await saveDoc(call, pid, a.meta.screen_id, doc, a.version);

    await repo.updateProject(pid, (proj) => ({ ...proj, members: [...(proj.members || []), { user: 'viewer', role: 'readonly' }] }));
    const viewer = { 'x-proto-user': 'viewer' };

    const canvas = await call('PUT', `/api/projects/${pid}/canvas`, { viewport: { x: 0, y: 0, zoom: 1 } }, viewer);
    assert.equal(canvas.status, 403);
    assert.equal(canvas.error.code, 'NO_PERMISSION');

    const measure = await call('POST', `/api/projects/${pid}/screens/${a.meta.screen_id}/measurements`, { items: { open_detail: 120 } }, viewer);
    assert.equal(measure.status, 403);
    assert.equal(measure.error.code, 'NO_PERMISSION');

    const base = `/api/projects/${pid}/flow/edges`;
    const badKind = await call('POST', base, {
      source_screen_id: a.meta.screen_id,
      source_item_id: 'open_detail',
      target_kind: 'popup',
      target_screen_id: b.meta.screen_id,
    });
    assert.equal(badKind.status, 400);
    assert.match(badKind.error.message, /target_kind/);

    const badLink = await call('POST', base, {
      source_screen_id: a.meta.screen_id,
      source_item_id: 'open_detail',
      target_kind: 'link',
      url: 'javascript:alert(1)',
    });
    assert.equal(badLink.status, 400);
    assert.match(badLink.error.message, /http/);

    const goodLink = await call('POST', base, {
      source_screen_id: a.meta.screen_id,
      source_item_id: 'open_detail',
      target_kind: 'link',
      url: 'https://example.com/docs',
    });
    assert.equal(goodLink.status, 200, JSON.stringify(goodLink.raw));

    const badPatch = await call('PATCH', `${base}/${goodLink.data.edge_id}`, { target_kind: 'popup' });
    assert.equal(badPatch.status, 400);
    const badPatchLink = await call('PATCH', `${base}/${goodLink.data.edge_id}`, { target_kind: 'link', url: 'ftp://example.com' });
    assert.equal(badPatchLink.status, 400);
  });
});

test('预览只消费已确认的关联边，候选边不会变成可点击行为', async () => {
  await withServer(async ({ call, repo }) => {
    const p = (await call('POST', '/api/projects', { name: '候选边过滤' })).data;
    const pid = p.project_id;
    const a = await createM3Screen(call, pid, '首页');
    const b = await createM3Screen(call, pid, '详情');

    const doc = structuredClone(a.doc);
    doc.groups = [{ id: 'g1', x: 16, y: 16, axis: 'y', items: [item('open_detail', 'button', '打开详情')] }];
    await saveDoc(call, pid, a.meta.screen_id, doc, a.version);

    const flow = await repo.getFlow(pid);
    flow.edges.push({
      edge_id: 'edge_candidate_demo',
      project_id: pid,
      source_screen_id: a.meta.screen_id,
      source_item_id: 'open_detail',
      source_slot: null,
      source_hotspot_id: 'open_detail',
      target_kind: 'screen',
      target_screen_id: b.meta.screen_id,
      trigger: 'click',
      transition: 'none',
      status: 'candidate',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await repo.saveFlow(pid, flow);

    const preview = (await call('GET', `/api/projects/${pid}/preview`)).data;
    assert.equal(preview.edges.length, 0, '候选边不得进入预览');
  });
});

/* ------------------------------------------------------------------ */
/* 尺寸：生成内容宽于实际屏幕                                           */
/* ------------------------------------------------------------------ */

test('生成尺寸：显式 width 与自由组偏移都不得让内容探出屏幕右边界', async () => {
  const { groupLayout, itemSize } = await import('../apps/server/src/domain/m3/convert.js');
  const { layoutGroup } = await import('../apps/web/src/screen-render.js');
  const W = 375; // 窄于 Registry 的 412 预设，正是溢出场景

  // 1) 模型照抄 412 预设，把宽度显式写成 380 / 412：必须夹到屏内
  for (const size of [380, 412, 600]) {
    const g = { id: 'g', axis: 'y', x: 16, y: 0, items: [{ id: 'a', kind: 'card', label: '卡片', size }] };
    const back = groupLayout(g, {}, W)[0];
    const front = layoutGroup(g, W)[0];
    assert.ok(back.x + back.w <= W, `后端 size=${size} 溢出：右缘 ${back.x + back.w}`);
    assert.ok(front.x + front.w <= W, `前端 size=${size} 溢出：右缘 ${front.x + front.w}`);
    assert.equal(back.w, front.w, '前后端宽度必须一致');
  }

  // 2) 不放大：显式宽度比屏宽小时保持原值
  const small = itemSize({ id: 'a', kind: 'card', size: 200 }, {}, W);
  assert.equal(small.w, 200);

  // 3) 自由组：每个部件按自己的 x 算剩余宽度，x>0 时不能再夹成整屏宽
  const free = { id: 'gf', axis: 'free', x: 0, y: 0, items: [
    { id: 'a', kind: 'box', label: '', pos: { x: 32, y: 100 }, size: 375 },
    { id: 'b', kind: 'topAppBar', label: '标题', pos: { x: 24, y: 0 } },
  ] };
  for (const p of groupLayout(free, {}, W)) {
    assert.ok(p.x + p.w <= W, `后端自由组 ${p.item.id} 溢出：右缘 ${p.x + p.w}`);
  }
  for (const p of layoutGroup(free, W)) {
    assert.ok(p.x + p.w <= W, `前端自由组 ${p.item.id} 溢出：右缘 ${p.x + p.w}`);
  }

  // 4) 长文案的估算宽度同样不能越过右边界
  const longText = { id: 'g', axis: 'y', x: 16, y: 0, items: [
    { id: 't', kind: 'text', label: '这是一段非常非常长的中文标题描述文字用于测试是否溢出屏幕边界' },
  ] };
  const tb = groupLayout(longText, {}, W)[0];
  const tf = layoutGroup(longText, W)[0];
  assert.ok(tb.x + tb.w <= W);
  assert.ok(tf.x + tf.w <= W);
});

/* ------------------------------------------------------------------ */
/* 鼠标交互特效                                                         */
/* ------------------------------------------------------------------ */

test('交互特效：渲染出的控件必须带 hover / active 视觉反馈', async () => {
  const { SCREEN_BASE_CSS } = await import('../apps/web/src/screen-render.js');
  const css = SCREEN_BASE_CSS;
  // 设计页、预览、静态导出共用这一份样式，缺了就等于"控件点上去没反应"
  assert.ok(/\[data-anchor\]:hover/.test(css), '必须有全局 hover 兜底');
  assert.ok(/\[data-anchor\]:active/.test(css), '必须有按下反馈');
  assert.ok(/:focus-visible/.test(css), '键盘聚焦要有可见轮廓');
  assert.ok(/\.m3-item\{[^}]*transition:/.test(css), '状态变化要有过渡动画');
  assert.ok(/prefers-reduced-motion/.test(css), '尊重系统的减少动效偏好');

  // 常用可点击部件要有专属反馈（仅靠全局兜底在栏类容器上几乎看不出变化）
  for (const kind of ['button', 'card', 'listItem', 'textField', 'iconButton', 'topAppBar', 'bottomNav', 'tabs', 'image']) {
    assert.ok(css.includes(`.m3-k-${kind}[data-anchor]:hover`), `${kind} 缺少专属 hover 规则`);
  }

  // 内部子元素（tab / nav-item / rail-item）本身不带 anchor，hover 必须写在容器上
  for (const inner of ['.m3-tab[data-anchor]', '.m3-nav-item[data-anchor]', '.m3-rail-item[data-anchor]']) {
    assert.equal(css.includes(inner), false, `${inner} 永远匹配不到，应改为容器选择器`);
  }
  assert.ok(/\.m3-k-tabs\[data-anchor\]:hover/.test(css));
  assert.ok(/\.m3-k-bottomNav\[data-anchor\]:hover/.test(css));
});
