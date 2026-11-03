import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshServer, client, listen, seedProject } from './helpers.mjs';
import { walk, collectAnchors, textOf } from '../apps/server/src/domain/doc.js';
import { detectCrossScreenOutput } from '../apps/server/src/service.js';
import { buildScreenDoc } from '../apps/server/src/ai/local.js';

/**
 * 回归测试：端到端联调中暴露的真实缺陷。
 * 每一条都对应一个曾经真实发生过的问题，防止复发。
 */

let ctx;
before(async () => {
  ctx = freshServer();
  await listen(ctx.server);
  ctx.call = client(ctx.server);
  ctx.seed = await seedProject(ctx.call);
});
after(() => ctx.server.close());

test('回归：walk 接受 doc 与 root 两种入参（曾导致遍历只跑到根节点）', () => {
  const doc = { version: 1, root: { id: 'r', tag: 'div', props: {}, children: [{ id: 'a', tag: 'span', props: { text: 'x' }, children: [] }] } };
  const fromRoot = [];
  walk(doc.root, (n) => fromRoot.push(n.id));
  const fromDoc = [];
  walk(doc, (n) => fromDoc.push(n.id));
  assert.deepEqual(fromDoc, ['r', 'a'], 'walk(doc) 必须从 root 开始，且不产生伪节点');
  assert.ok(fromRoot.includes('a'));
  // 从 doc 进入时也必须覆盖子节点
  assert.ok(fromDoc.includes('a'), 'walk(doc) 必须继续下探 root.children');
});

test('回归：props.children 业务字段不得被误认为树结构的 children', () => {
  const fake = {
    id: 'b1',
    tag: 'div',
    props: { children: [{ id: 'fake-child' }], attrs: { 'data-anchor': 'x' } },
    children: [],
  };
  assert.equal(collectAnchors({ root: fake }).length, 1);
  assert.equal(textOf(fake), '');
});

test('回归：列表接口必须返回当前内容（画布依赖它渲染）', async () => {
  const { pk, login } = ctx.seed;
  const list = (await ctx.call('GET', `${pk}/screens`)).data;
  const target = list.find((s) => s.screen_id === login.screen_id);
  assert.ok(target, '应包含目标屏');
  assert.ok(target.doc?.root, '列表项必须带 doc，否则画布会渲染成空屏');
  assert.ok(target.anchors.length > 0, '列表项应带热区');
});

test('回归：模板识别不受 prompt 中元信息（# 输出格式 等）干扰', () => {
  const cases = [
    ['登录页', 'login'],
    ['审批列表', 'list'],
    ['审批详情', 'detail'],
    ['提交成功页', 'success'],
    ['首页工作台', 'home'],
  ];
  for (const [title, expect] of cases) {
    const { template } = buildScreenDoc({
      instruction: `登录 列表 详情 首页 成功 全部写在这里也只是元信息\n# 用户指令\n${title}`,
      screen: { screen_id: 's1', title },
      project: { design_tokens: {} },
    });
    assert.equal(template, expect, `${title} 应识别为 ${expect}`);
  }
});

test('回归：<screenId>_root 这类派生 id 不得被判为跨屏写入', () => {
  const target = 'scr_abc123def';
  const out = { mode: 'full', target_screen_id: target, doc: { root: { id: `${target}_root` } } };
  assert.deepEqual(detectCrossScreenOutput(out, target), []);
});

test('回归：未登记的 screen_id 也必须被拦下（白名单语义）', () => {
  const target = 'scr_abc123def';
  const out = { mode: 'patch', target_screen_id: target, ops: [{ target: { node_id: 'n1', screen_id: 'scr_neverexisted' } }] };
  const v = detectCrossScreenOutput(out, target);
  assert.ok(v.length > 0, '项目里不存在的 screen_id 同样属于越权写入');
  assert.equal(v[0].screen_id, 'scr_neverexisted');
});

test('回归：已有内容的屏幕执行「修改类指令」必须走 patch 而非整屏重写', async () => {
  const { pk, detail } = ctx.seed;
  const g = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/generations`, {
    prompt: '把审批详情改成"审批单详情"',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  assert.equal(g.data.mode, 'patch');
});

test('回归：显式要求整屏重生成时才允许 full', async () => {
  const { pk, detail } = ctx.seed;
  const g = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/generations`, {
    prompt: '整屏重新生成：审批详情页',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  assert.equal(g.data.mode, 'full');
  await ctx.call('POST', `${pk}/screens/${detail.screen_id}/pending/reject`, {});
});

test('回归：patch 目标未命中返回 422 且不改内容', async () => {
  const { pk, detail } = ctx.seed;
  const before = (await ctx.call('GET', `${pk}/screens/${detail.screen_id}`)).data;
  const res = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/manual-patch`, {
    ops: [{ op: 'updateProps', target: { node_id: 'not-exist-node' }, value: { text: 'x' } }],
  });
  assert.equal(res.status, 422);
  const after = (await ctx.call('GET', `${pk}/screens/${detail.screen_id}`)).data;
  assert.equal(after.current_version, before.current_version);
  assert.deepEqual(after.doc, before.doc);
});

test('回归：并发写同一屏不会数据错乱（KeyedQueue 串行）', async () => {
  const { pk, list } = ctx.seed;
  const doc = (await ctx.call('GET', `${pk}/screens/${list.screen_id}`)).data.doc;
  const firstBlock = doc.root.children[0].id;
  const ops = Array.from({ length: 5 }, (_, i) => ({
    op: 'updateProps',
    target: { node_id: firstBlock },
    value: { style: { opacity: 0.9 + i * 0.01 }, text: undefined },
  }));
  const results = await Promise.all(
    ops.map((op) => ctx.call('POST', `${pk}/screens/${list.screen_id}/manual-patch`, { ops: [op] }))
  );
  assert.ok(results.every((r) => r.status === 200), '同屏串行写应全部成功');
  const versions = results.map((r) => r.data.version).sort((a, b) => a - b);
  assert.equal(new Set(versions).size, versions.length, '每个请求都应拿到独立且递增的版本号');
});

test('回归：导出静态包在无 JS 依赖下也能被解析出全部屏幕与边', async () => {
  const { pk, login, list } = ctx.seed;
  // 显式建一条边：该用例不能依赖其他用例的执行顺序（node --test 并行文件独立，但同一文件内顺序也需自洽）
  const e = await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: login.screen_id,
    source_hotspot_id: 'login_submit',
    target_screen_id: list.screen_id,
  });
  assert.equal(e.status, 200, JSON.stringify(e.raw));
  const res = await ctx.call('POST', `${pk}/export`, { name: `regress-${Date.now()}` });
  assert.equal(res.status, 200);
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(path.join(res.data.dir, 'index.html'), 'utf8');
  const m = html.match(/window\.__PROTO__\s*=\s*(\{.*?\});<\/script>/s);
  assert.ok(m, '应内联 __PROTO__ 数据');
  const data = JSON.parse(m[1]);
  assert.equal(data.edges.length >= 1, true);
  assert.equal(data.start.startsWith('scr_'), true);
});

/* --------------------------------------------------------------------------
 * 422 回归：用户看到的 "422 Unprocessable Entity" 曾经来自两条完全不同的路径
 * ------------------------------------------------------------------------ */

test('422 修复：模糊指令不再伪装成"模型整屏重写"，而是可操作的 UNPROCESSABLE', async () => {
  const { pk, login } = ctx.seed;
  const before = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '让这个页面更高级一些',
    edit_scope: 'screen',
  });
  assert.equal(res.status, 422);
  assert.equal(res.error.code, 'UNPROCESSABLE', '不能报成 INVALID_OUTPUT，二者含义不同');
  assert.match(res.error.message, /没有从指令中识别出可执行的修改/);
  assert.ok(res.error.detail?.hint, '必须带可操作建议，否则用户只会看到一句 422');

  const after = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  assert.equal(after.current_version, before.current_version, '识别失败不得产生版本');
  assert.deepEqual(after.doc, before.doc, '识别失败不得改动内容');
});

test('422 修复：没解析出变更时 provider 必须返回 mode=noop，而不是 mode=full', async () => {
  const { buildPatch, buildScreenDoc } = await import('../apps/server/src/ai/local.js');
  const { doc } = buildScreenDoc({ instruction: '登录页', screen: { screen_id: 's', title: '登录页' }, project: { design_tokens: {} } });
  const patch = buildPatch({ instruction: '让这个页面更高级一些', currentDoc: doc, editScope: 'screen', selection: null });
  assert.equal(patch.ops.length, 0);
  assert.equal(patch.mode, 'noop', 'mode 必须如实反映"没有变更"，否则上层误判为整屏重写 → 422');
});

test('422 修复：region / component 缺少选区时提前 400，不进入模型调用', async () => {
  const { pk, login } = ctx.seed;
  for (const scope of ['region', 'component']) {
    const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
      prompt: '把标题改大一点',
      edit_scope: scope,
    });
    assert.equal(res.status, 400, `${scope} 应在请求侧被拒绝`);
    assert.equal(res.error.code, 'BAD_REQUEST');
    assert.match(res.error.message, /selection\.node_ids/);
    assert.ok(res.error.detail?.hint);
  }
});

test('422 修复：常见自然语言修改都能产出 patch', async () => {
  const { pk, login } = ctx.seed;
  const cases = [
    ['把标题改大一点', 'updateProps'],
    ['标题加粗', 'updateProps'],
    ['把登录按钮改成圆角', 'updateProps'],
    ['加一个联系客服按钮', 'insertChild'],
  ];
  for (const [prompt, expectOp] of cases) {
    const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt, edit_scope: 'screen' });
    assert.equal(res.status, 200, `${prompt} → ${JSON.stringify(res.raw)}`);
    assert.equal(res.data.mode, 'patch');
    assert.ok(res.data.diff.some((d) => d.op === expectOp), `${prompt} 应产生 ${expectOp}`);
    await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
  }
});

test('422 修复：显式整屏重生成仍然允许，且与模糊指令区分开', async () => {
  const { pk, login } = ctx.seed;
  const full = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '整屏重新生成：登录页',
    edit_scope: 'screen',
  });
  assert.equal(full.status, 200);
  assert.equal(full.data.mode, 'full');
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
});

test('回归：job 状态必须真正落盘（曾因重读磁盘覆盖内存，永久停在 generating）', async () => {
  const { Repo } = await import('../apps/server/src/store/repo.js');
  const repo = new Repo(`.box-agent-scratch/jobstate-${Date.now()}`);
  const pid = 'p_jobstate';
  await repo.createProject({ project_id: pid, name: 'x', created_at: new Date().toISOString() });
  await repo.appendHistory(pid, 'jobs', { job_id: 'j1', status: 'generating' });
  const r = await repo.updateJob(pid, 'j1', { status: 'no_op' });
  assert.equal(r.status, 'no_op');
  const persisted = (await repo.getHistory(pid)).jobs.find((j) => j.job_id === 'j1');
  assert.equal(persisted.status, 'no_op', '内存改了但没写盘 → 历史永远是 generating');
});

test('回归：每一次生成结束后 job 都不得停留在 generating', async () => {
  const { pk, login } = ctx.seed;
  const before = (await ctx.call('GET', `${pk}/screens/${login.screen_id}/jobs`)).data.length;

  // 成功一次
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '把标题改大一点', edit_scope: 'screen' });
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
  // 失败一次（模糊指令）
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '让页面更高级', edit_scope: 'screen' });

  const jobs = (await ctx.call('GET', `${pk}/screens/${login.screen_id}/jobs`)).data;
  assert.equal(jobs.length, before + 2);
  const stuck = jobs.filter((j) => j.status === 'generating');
  assert.equal(stuck.length, 0, `仍有 job 停在 generating: ${stuck.map((j) => j.job_id).join(',')}`);
  assert.ok(jobs.some((j) => j.status === 'rejected_by_user'), '被拒绝的 job 应记录 rejected_by_user');
  assert.ok(jobs.some((j) => j.status === 'no_op'), '模糊指令应记为 no_op 而不是 failed');
});

test('回归：屏幕状态不得卡在 generating 导致后续请求全被 409', async () => {
  const { pk, login } = ctx.seed;
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '让页面更高级', edit_scope: 'screen' });
  const meta = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  assert.notEqual(meta.status, 'generating');
  const next = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '标题加粗', edit_scope: 'screen' });
  assert.equal(next.status, 200, '上一次失败不应阻塞下一次生成');
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
});

test('回归："标题"类指令必须命中真正的标题节点，而不是文档里第一个文本', async () => {
  const { pk, login } = ctx.seed;
  const doc = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.doc;
  const texts = [];
  (function w(n) {
    if (n.props?.text && n.tag !== 'button') texts.push({ id: n.id, size: Number(n.props.style?.fontSize) || 14, text: n.props.text });
    (n.children || []).forEach(w);
  })(doc.root);
  // 标题 = 字号最大的文本；doc 顺序里第一个文本未必是标题（登录页是 hero 区块）
  const heading = texts.slice().sort((a, b) => b.size - a.size)[0];
  assert.ok(/%标题|title/i.test(heading.id), `测试前提：最大字号节点应是标题，实际 ${heading.id}`);

  const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '把标题改大一点', edit_scope: 'screen' });
  assert.equal(res.status, 200);
  assert.equal(
    res.data.diff[0].node_id,
    heading.id,
    `应命中标题 ${heading.id}"${heading.text}"(size=${heading.size})，实际命中 ${res.data.diff[0].node_id}`
  );
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
});
