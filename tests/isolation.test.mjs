import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { freshServer, client, listen, seedProject } from './helpers.mjs';

/**
 * 隔离性验收（NFR-001/002/003、AC-001/002/003/004/005/006/007）
 * 每条断言都直接对应 SRS 需求编号。
 */

let ctx;
before(async () => {
  ctx = freshServer();
  await listen(ctx.server);
  ctx.call = client(ctx.server);
  ctx.seed = await seedProject(ctx.call);
});
after(() => ctx.server.close());

/** 目录内容指纹：用于证明"另一个屏幕的存储完全没被写" */
function dirHash(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${createHash('sha1').update(readFileSync(p)).digest('hex')}:${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.join('|');
}

const screenDir = (sid) => path.join(ctx.repoRoot, 'projects', ctx.seed.project.project_id, 'screens', sid);

test('NFR-002 / AC-002：target_screen_id 与路径不一致时返回 403 且不产生版本', async () => {
  const { pk, login, list } = ctx.seed;
  const before = (await ctx.call('GET', `${pk}/screens/${login.screen_id}/versions`)).data.versions.length;
  const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '改点东西',
    edit_scope: 'screen',
    target_screen_id: list.screen_id,
  });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, 'FORBIDDEN_TARGET');
  const after = (await ctx.call('GET', `${pk}/screens/${login.screen_id}/versions`)).data.versions.length;
  assert.equal(after, before, '越权请求不得产生新版本');

  // 并应有审计告警（FR-AUDIT-003）
  const audit = (await ctx.call('GET', `${pk}/audit`)).data;
  assert.ok(
    audit.audits.some((a) => a.action === 'CROSS_SCREEN_WRITE_ATTEMPT'),
    '应记录 CROSS_SCREEN_WRITE_ATTEMPT 告警'
  );
});

test('FR-GEN-002 / API-001：缺少 edit_scope 的生成请求被拒绝', async () => {
  const { pk, login } = ctx.seed;
  const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, { prompt: '随便' });
  assert.equal(res.status, 400);
  assert.match(res.error.message, /edit_scope/);
});

test('NFR-003 / AI-001：生成上下文不含其他屏幕正文（日志可证明）', async () => {
  const { pk, login, list } = ctx.seed;
  const res = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '把欢迎回来改成你好呀',
    edit_scope: 'screen',
  });
  assert.equal(res.status, 200);
  const audit = res.data.context_audit;
  assert.deepEqual(audit.embedded_screen_ids, [login.screen_id], '上下文只应嵌入目标屏');
  assert.equal(audit.context_fingerprint > 0, true);

  // 另一屏的节点 id 不得出现在上下文审计里的"已嵌入屏"集合
  const listScreensCtx = audit.embedded_screen_ids;
  assert.ok(!listScreensCtx.includes(list.screen_id));
});

test('AC-001 / BR-002：改 A 屏内容后，B 屏目录内容与 mtime 完全不变', async () => {
  const { pk, login, list } = ctx.seed;
  const hashBefore = dirHash(screenDir(list.screen_id));

  const g = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '把登录按钮改成立即进入',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  const a = await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/apply`);
  assert.equal(a.status, 200);

  const hashAfter = dirHash(screenDir(list.screen_id));
  assert.equal(hashAfter, hashBefore, 'B 屏存储被意外写入');
});

test('BR-003 / FR-PATCH-001/003：修改类任务输出 patch，且只递增目标屏版本', async () => {
  const { pk, detail, list } = ctx.seed;
  const listMeta0 = (await ctx.call('GET', `${pk}/screens/${list.screen_id}`)).data;

  const g = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/generations`, {
    prompt: '把审批详情改成"审批单详情"',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  assert.equal(g.data.mode, 'patch', '已有内容的屏幕应走 patch（BR-003）');
  assert.ok(g.data.diff.length >= 1);
  assert.ok(g.data.diff.every((d) => d.op !== 'full-regenerate'));

  const before = (await ctx.call('GET', `${pk}/screens/${detail.screen_id}`)).data.current_version;
  const a = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/pending/apply`);
  assert.equal(a.data.version, before + 1);

  const listMeta1 = (await ctx.call('GET', `${pk}/screens/${list.screen_id}`)).data;
  assert.equal(listMeta1.current_version, listMeta0.current_version, '其他屏版本号不得变化');
});

test('FR-GEN-006 / FR-PATCH-002：生成结果未被接受前不写入正式版本', async () => {
  const { pk, login } = ctx.seed;
  const v0 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;
  const g = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '把欢迎回来改成晚上好',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  assert.equal(g.data.status, 'pending_confirm');
  const v1 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;
  assert.equal(v1, v0, '未确认前版本号不变');

  const rej = await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/reject`, {});
  assert.equal(rej.status, 200);
  const v2 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;
  assert.equal(v2, v0, '拒绝后版本号不变');
});

test('AC-003 / FR-VER-005：锁定屏幕拒绝 AI 写入，返回 423 且版本不变', async () => {
  const { pk, login } = ctx.seed;
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/lock`, { reason: '设计已定稿' });
  const v0 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;

  const g = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '再改一次标题',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 423);
  assert.equal(g.error.code, 'SCREEN_LOCKED');

  const mp = await ctx.call('POST', `${pk}/screens/${login.screen_id}/manual-patch`, {
    ops: [{ op: 'updateProps', target: { node_id: 'blk_login_hero_title' }, value: { text: 'x' } }],
  });
  assert.equal(mp.status, 423, '锁定屏也不允许用户手动编辑');

  const v1 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;
  assert.equal(v1, v0);

  // 解锁审计（FR-VER-006）
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/unlock`, { reason: '需要调整文案' });
  const meta = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  assert.ok(meta.lock_audit?.some((x) => x.reason === '需要调整文案'), '解锁应记录原因');
});

test('AC-005 / FR-VER-003：回滚只影响目标屏', async () => {
  const { pk, login, list } = ctx.seed;
  const listHash = dirHash(screenDir(list.screen_id));
  const listV = (await ctx.call('GET', `${pk}/screens/${list.screen_id}`)).data.current_version;

  // 登录屏先在 v2 生成内容，再改成 v3，然后回滚到 v2
  const g = await ctx.call('POST', `${pk}/screens/${login.screen_id}/generations`, {
    prompt: '把登录按钮改成立即进入',
    edit_scope: 'screen',
  });
  assert.equal(g.status, 200);
  await ctx.call('POST', `${pk}/screens/${login.screen_id}/pending/apply`);
  const v3 = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data.current_version;

  const rb = await ctx.call('POST', `${pk}/screens/${login.screen_id}/rollback`, { version: 2 });
  assert.equal(rb.status, 200, JSON.stringify(rb.raw));

  const cur = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  assert.equal(cur.current_version, 2);
  assert.ok(v3 > 2);
  const v2doc = (await ctx.call('GET', `${pk}/screens/${login.screen_id}/versions/2`)).data.doc;
  assert.equal(cur.doc.root.id, v2doc.root.id, '回滚后内容应等于目标版本');

  const listAfter = (await ctx.call('GET', `${pk}/screens/${list.screen_id}`)).data;
  assert.equal(listAfter.current_version, listV, '其他屏版本不受影响');
  assert.equal(dirHash(screenDir(list.screen_id)), listHash, '其他屏存储不被触碰');
});

test('AC-004 / DC-004：改连线不触发任何屏幕重生成', async () => {
  const { pk, login, list, detail } = ctx.seed;
  const allHashBefore = [login, list, detail].map((s) => dirHash(screenDir(s.screen_id)));

  const e = await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: login.screen_id,
    source_hotspot_id: 'login_submit',
    target_screen_id: list.screen_id,
  });
  assert.equal(e.status, 200, JSON.stringify(e.raw));

  const up = await ctx.call('PATCH', `${pk}/flow/edges/${e.data.edge_id}`, { target_screen_id: detail.screen_id, note: '改为跳详情' });
  assert.equal(up.status, 200);
  assert.equal(up.data.target_screen_id, detail.screen_id);

  const del = await ctx.call('DELETE', `${pk}/flow/edges/${e.data.edge_id}`);
  assert.equal(del.status, 200);

  const allHashAfter = [login, list, detail].map((s) => dirHash(screenDir(s.screen_id)));
  assert.deepEqual(allHashAfter, allHashBefore, 'flow 写操作不得触碰任何屏幕目录');
});

test('DC-001 / FR-FLOW-005：Screen 与 FlowEdge 物理分离存储', async () => {
  const { pk, login, list } = ctx.seed;
  await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: login.screen_id,
    source_hotspot_id: 'login_submit',
    target_screen_id: list.screen_id,
  });
  const projDir = path.join(ctx.repoRoot, 'projects', ctx.seed.project.project_id);
  const flow = JSON.parse(readFileSync(path.join(projDir, 'flow.json'), 'utf8'));
  assert.ok(flow.edges.length >= 1);
  // flow.json 中不得出现任何节点树 / HTML 内容
  const raw = JSON.stringify(flow);
  assert.ok(!raw.includes('data-node-id'), 'flow 中不得内嵌页面内容');
  assert.ok(!raw.includes('"children"'), 'flow 中不得内嵌节点树');
});

test('AC-006 / FR-FLOW-006：删除有连线的屏幕必须先处理关联边', async () => {
  const { pk } = ctx.seed;
  const a = (await ctx.call('POST', `${pk}/screens`, { title: '临时页A' })).data;
  const b = (await ctx.call('POST', `${pk}/screens`, { title: '临时页B' })).data;
  await ctx.call('POST', `${pk}/screens/${a.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
  await ctx.call('POST', `${pk}/screens/${a.screen_id}/pending/apply`);
  const e = await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: a.screen_id,
    source_hotspot_id: 'login_submit',
    target_screen_id: b.screen_id,
  });
  assert.equal(e.status, 200);

  const del1 = await ctx.call('DELETE', `${pk}/screens/${b.screen_id}`, {});
  assert.equal(del1.status, 409);
  assert.equal(del1.error.detail.code, 'EDGES_EXIST');

  const del2 = await ctx.call('DELETE', `${pk}/screens/${b.screen_id}`, { edge_action: 'delete_edges' });
  assert.equal(del2.status, 200);
  assert.equal(del2.data.deleted, b.screen_id);
});

test('AC-007 / AI-007：AI 输出夹带跨屏写入时拒绝并告警', async () => {
  const evil = {
    generateFull: async () => ({
      mode: 'full',
      doc: { version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } },
      screen_id: 'scr_OTHER',
      target_screen_id: 'scr_OTHER',
    }),
    generatePatch: async () => ({
      mode: 'patch',
      ops: [{ op: 'updateProps', target: { node_id: 'x', screen_id: 'scr_OTHER' }, value: { text: 'hack' } }],
    }),
  };
  const s = freshServer({ ai: evil });
  await listen(s.server);
  const call = client(s.server);
  try {
    const p = (await call('POST', '/api/projects', { name: '恶意输出测试' })).data;
    const scr = (await call('POST', `/api/projects/${p.project_id}/screens`, { title: '登录页' })).data;
    const res = await call('POST', `/api/projects/${p.project_id}/screens/${scr.screen_id}/generations`, {
      prompt: '登录页',
      edit_scope: 'screen',
    });
    assert.equal(res.status, 403, JSON.stringify(res.raw));
    assert.equal(res.error.code, 'FORBIDDEN_TARGET');

    const audit = (await call('GET', `/api/projects/${p.project_id}/audit`)).data;
    assert.ok(audit.audits.some((a) => a.action === 'AI_CROSS_SCREEN_OUTPUT'), '应产生跨屏输出告警');

    const meta = (await call('GET', `/api/projects/${p.project_id}/screens/${scr.screen_id}`)).data;
    assert.equal(meta.current_version, 1, '越权输出不得落库');
  } finally {
    s.server.close();
  }
});

test('AC-008 / NFR-008：patch 中途失败时屏幕保持应用前状态', async () => {
  const { pk, detail } = ctx.seed;
  const v0 = (await ctx.call('GET', `${pk}/screens/${detail.screen_id}`)).data;
  assert.ok(v0.doc.root.children.length > 0, '详情屏应有内容');
  const good = { op: 'updateProps', target: { node_id: v0.doc.root.children[0].id }, value: { style: { opacity: 0.9 } } };
  const bad = { op: 'updateProps', target: { node_id: '不存在的节点id' }, value: { text: 'x' } };
  const res = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/manual-patch`, { ops: [good, bad] });
  assert.equal(res.status, 422);
  assert.equal(res.error.code, 'INVALID_OUTPUT');

  const v1 = (await ctx.call('GET', `${pk}/screens/${detail.screen_id}`)).data;
  assert.equal(v1.current_version, v0.current_version, '失败不得递增版本');
  assert.deepEqual(v1.doc, v0.doc, '失败必须保持原内容（无半应用）');
});

test('FR-PATCH-001 校验：结构化伪选择器被拒绝', async () => {
  const { pk, detail } = ctx.seed;
  const res = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/manual-patch`, {
    ops: [{ op: 'updateProps', target: { selector: 'div:nth-child(3)' }, value: { text: 'x' } }],
  });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(res.error), /选择器不稳定/);
});

test('FR-CANVAS-003：复制屏幕生成新 screen_id 且不共享版本历史', async () => {
  const { pk, detail } = ctx.seed;
  const dup = await ctx.call('POST', `${pk}/screens/${detail.screen_id}/duplicate`);
  assert.equal(dup.status, 200);
  assert.notEqual(dup.data.screen_id, detail.screen_id);
  // M2（AC-309）：副本不继承版本历史，「复制自 X」直接作为 v1，不再额外制造空屏基线
  assert.equal(dup.data.versions.length, 1, '副本只应有「复制自 X」一条版本');
  assert.match(dup.data.versions[0].label, /复制自/);
});
