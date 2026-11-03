import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, client, listen, seedProject } from './helpers.mjs';

/**
 * 区域 / 组件级生成的作用域验收（FR-GEN-004 / FR-GEN-005 / DC-008）
 *
 * 曾经的真实缺陷：生成器按整屏扫描定位，命中点落在选区外 → 被范围过滤清空 → 恒为 noop，
 * 用户以为"需求描述不起作用"。这里锁住：定位必须发生在选区内，且不得越界改动。
 */

async function withServer(opts, fn) {
  const ctx = freshServer(opts);
  await listen(ctx.server);
  const call = client(ctx.server);
  try {
    return await fn({ ...ctx, call });
  } finally {
    ctx.server.close();
  }
}

function gen(call, pk, sid, body) {
  return call('POST', `${pk}/screens/${sid}/generations`, { ...body });
}

/** 找出某段文案对应的节点 id */
async function nodeOf(call, pk, sid, text) {
  const s = await call('GET', `${pk}/screens/${sid}`);
  let hit = null;
  const walk = (n) => {
    if (hit) return;
    if (n.props?.text && String(n.props.text).includes(text)) hit = n.id;
    for (const c of n.children || []) walk(c);
  };
  walk(s.data.doc.root);
  return hit;
}

test('区域范围：文案替换在选区内定位生效，不再退化为「没听懂」', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    // 选副标题所在区块（"登录后继续你的工作"）
    const subId = await nodeOf(call, pk, login.screen_id, '登录后继续');
    assert.ok(subId, '应能找到副标题节点');

    const r = await gen(call, pk, login.screen_id, {
      prompt: '把「登录后继续你的工作」改成「登录以同步你的数据」',
      edit_scope: 'region',
      selection: { node_ids: [subId] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.mode, 'patch');
    assert.ok(r.data.preview_doc);
    assert.ok(JSON.stringify(r.data.preview_doc).includes('登录以同步你的数据'));

    // 选区外的标题不应被改动
    const applied = await call('POST', `${pk}/screens/${login.screen_id}/pending/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.raw));
    const doc = await call('GET', `${pk}/screens/${login.screen_id}`);
    assert.ok(JSON.stringify(doc.data.doc).includes('欢迎回来'), '选区外的标题必须保持不变');
  });
});

test('区域范围：样式类指令（加粗）只作用在选区内节点', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const subId = await nodeOf(call, pk, login.screen_id, '登录后继续');
    const r = await gen(call, pk, login.screen_id, {
      prompt: '把这里的文字加粗',
      edit_scope: 'region',
      selection: { node_ids: [subId] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.mode, 'patch');
    await call('POST', `${pk}/screens/${login.screen_id}/pending/apply`);

    const s = await call('GET', `${pk}/screens/${login.screen_id}`);
    const find = (n, id) => (n.id === id ? n : (n.children || []).reduce((a, c) => a || find(c, id), null));
    const sub = find(s.data.doc.root, subId);
    assert.equal(Number(sub?.props?.style?.fontWeight), 700, '选区节点应被加粗');

    // 标题不应被加粗
    const titleId = await nodeOf(call, pk, login.screen_id, '欢迎回来');
    const title = find(s.data.doc.root, titleId);
    // 标题原本就是 700，这里断言它"没有变成非 700 的其他值"没有意义；
    // 更有意义的断言是：标题文本与样式逐字段与改动前一致。
    assert.equal(String(title?.props?.text), '欢迎回来', '选区外标题文本不得被改');
    assert.equal(Number(title?.props?.style?.fontSize), 28, '选区外标题字号不得被改');
  });
});

test('组件范围：仅支持单节点，多选返回 400', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const a = await nodeOf(call, pk, login.screen_id, '欢迎回来');
    const b = await nodeOf(call, pk, login.screen_id, '登录后继续');
    const r = await gen(call, pk, login.screen_id, {
      prompt: '把这些文字加粗',
      edit_scope: 'component',
      selection: { node_ids: [a, b] },
    });
    assert.equal(r.status, 400, JSON.stringify(r.raw));
    assert.match(r.error.message, /组件级修改只支持单个节点/);
  });
});

test('区域范围：缺少选区在请求侧被拒，不进入路由与生成器', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const before = await call('GET', `${pk}/screens/${login.screen_id}`);
    const r = await gen(call, pk, login.screen_id, {
      prompt: '把标题改成「晚上好」',
      edit_scope: 'region',
    });
    assert.equal(r.status, 400);
    assert.equal(r.error.detail?.code || r.error.code, 'SELECTION_REQUIRED');
    // 请求被拒后，屏幕内容与版本号都不变
    const after = await call('GET', `${pk}/screens/${login.screen_id}`);
    assert.equal(after.data.current_version, before.data.current_version);
    assert.equal(after.data.status, before.data.status);
  });
});

test('路由审计：选区内的确定性修改标记 builtin_rule，且不调用大模型', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const subId = await nodeOf(call, pk, login.screen_id, '登录后继续');
    const r = await gen(call, pk, login.screen_id, {
      prompt: '把「登录后继续你的工作」改成「登录并继续」',
      edit_scope: 'region',
      selection: { node_ids: [subId] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.route.change_source, 'builtin_rule');
    assert.equal(r.data.route.ai_cost, 0);

    const logs = await call('GET', `${pk}/screens/${login.screen_id}/route-logs`);
    assert.equal(logs.data[0].is_deterministic, true);
    assert.equal(logs.data[0].route_layer, 'rule');
  });
});
