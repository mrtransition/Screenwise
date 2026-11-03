import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshServer, client, listen, seedProject } from './helpers.mjs';

/**
 * 内置生成器维护 + 确定性路由验收（SRS §3.12 / AC-203 / AC-204 / AC-205 / AC-211）
 *
 * 关注点：
 *  - 内置生成器的配置维护（名称 / 启用范围 / 规则 / 路由开关）与结构约束；
 *  - 确定性请求短路大模型，且版本带 change_source=builtin_rule / ai_cost=0；
 *  - 创作意图、否定语义不被误降级；
 *  - 关闭内置生成器后，确定性请求回到大模型（原流程不变）。
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
  return call('POST', `${pk}/screens/${sid}/generations`, { edit_scope: 'screen', ...body });
}

async function apply(call, pk, sid) {
  const r = await call('POST', `${pk}/screens/${sid}/pending/apply`);
  assert.equal(r.status, 200, JSON.stringify(r.raw));
  return r.data;
}

/** 本地假网关：记录被调用次数，用于证明"没有调用大模型" */
async function fakeGateway(reply) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(raw);
      const body = { choices: [{ message: { content: JSON.stringify(reply) } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}/v1` };
}

async function useGateway(call, base) {
  const m = await call('POST', '/api/models', {
    name: '假网关',
    provider: 'openai-compatible',
    model: 'fake-1',
    base_url: base,
  });
  assert.equal(m.status, 200, JSON.stringify(m.raw));
  const act = await call('POST', `/api/models/${m.data.model_id}/activate`);
  assert.equal(act.status, 200, JSON.stringify(act.raw));
  return m.data.model_id;
}

/* ---------------- 配置维护 ---------------- */

test('内置生成器维护：默认配置可读，且不泄漏任何密钥字段', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('GET', '/api/generator');
    assert.equal(r.status, 200);
    assert.equal(r.data.model_id, 'mdl_local');
    assert.equal(r.data.scope, 'global');
    assert.equal(r.data.router_enabled, true);
    assert.ok(r.data.rules.includes('text_replace'));
    assert.deepEqual(r.data.available_scopes, ['global', 'explicit_only', 'off']);
    assert.equal(r.raw.ok && JSON.stringify(r.raw).includes('api_key'), false);
  });
});

test('内置生成器维护：可改名称 / 范围 / 规则 / 路由开关，非法输入被拒', async () => {
  await withServer({}, async ({ call }) => {
    const ok = await call('PATCH', '/api/generator', {
      name: '本机规则引擎',
      scope: 'explicit_only',
      rules: ['text_replace', 'button_label'],
      router_enabled: false,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.raw));
    assert.equal(ok.data.name, '本机规则引擎');
    assert.equal(ok.data.scope, 'explicit_only');
    assert.deepEqual(ok.data.rules, ['text_replace', 'button_label']);
    assert.equal(ok.data.router_enabled, false);
    assert.equal(ok.data.updated_by, 'local-user');

    const again = await call('GET', '/api/generator');
    assert.equal(again.data.name, '本机规则引擎');
    assert.deepEqual(again.data.rules, ['text_replace', 'button_label']);

    // 模型列表里的名称同步变化，且结构约束不变
    const models = await call('GET', '/api/models');
    const builtin = models.data.models.find((m) => m.builtin);
    assert.equal(builtin.name, '本机规则引擎');
    assert.equal(builtin.enabled, true);

    const badScope = await call('PATCH', '/api/generator', { scope: 'sometimes' });
    assert.equal(badScope.status, 400);
    assert.ok(badScope.error.detail?.hint);

    const badRule = await call('PATCH', '/api/generator', { rules: ['no_such_rule'] });
    assert.equal(badRule.status, 400);

    const badName = await call('PATCH', '/api/generator', { name: '   ' });
    assert.equal(badName.status, 400);
  });
});

test('内置生成器维护：关闭范围等价于关闭生成器，但结构上不可删除/停用', async () => {
  await withServer({}, async ({ call }) => {
    const off = await call('PATCH', '/api/generator', { scope: 'off' });
    assert.equal(off.status, 200);
    assert.equal(off.data.scope, 'off');

    const del = await call('DELETE', '/api/models/mdl_local');
    assert.equal(del.status, 400);
    const stop = await call('PATCH', '/api/models/mdl_local', { enabled: false });
    assert.equal(stop.status, 400);

    // 重新打开时保留已选规则，不需要重配
    const on = await call('PATCH', '/api/generator', { scope: 'global' });
    assert.equal(on.data.scope, 'global');
    assert.ok(on.data.rules.length > 0);
  });
});

/* ---------------- 路由与成本 ---------------- */

test('AC-203：结构化文案修改走内置生成器，ai_cost=0，版本标记 builtin_rule', async () => {
  await withServer({}, async ({ call }) => {
    const { project, pk, login } = await seedProject(call);
    const screen = await call('GET', `${pk}/screens/${login.screen_id}`);
    const btn = screen.data.anchors.find((a) => a.hotspot_id === 'login_submit');
    assert.ok(btn, '登录按钮热区应存在');

    const r = await gen(call, pk, login.screen_id, {
      prompt: '把按钮文案改为「立即登录」',
      node_id: btn.node_id,
    });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.route.route_layer, 'explicit');
    assert.equal(r.data.route.change_source, 'builtin_rule');
    assert.equal(r.data.route.ai_cost, 0);

    const applied = await apply(call, pk, login.screen_id);
    const versions = await call('GET', `${pk}/screens/${login.screen_id}/versions`);
    const cur = versions.data.versions.find((v) => v.version === applied.version);
    assert.equal(cur.change_source, 'builtin_rule');
    assert.equal(cur.ai_cost, 0);
    assert.equal(cur.route_layer, 'explicit');
    assert.match(cur.change_summary, /立即登录/);

    const rec = await call('GET', `${pk}/screens/${login.screen_id}/versions/${applied.version}`);
    assert.ok(JSON.stringify(rec.data.doc).includes('立即登录'));
    assert.equal(project.project_id, pk.split('/').pop());
  });
});

test('AC-203（自然语言）：命中规则句式的文案替换不调用大模型', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const r = await gen(call, pk, login.screen_id, { prompt: '把「欢迎回来」改成「晚上好」' });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.route.route_layer, 'rule');
    assert.equal(r.data.route.change_source, 'builtin_rule');
    assert.equal(r.data.route.ai_cost, 0);
    await apply(call, pk, login.screen_id);
    const v = await call('GET', `${pk}/screens/${login.screen_id}/versions`);
    assert.equal(v.data.versions[0].change_source, 'builtin_rule');
  });
});

test('AC-204：创作型指令不降级，进入大模型流程（假网关被真实调用）', async () => {
  const gw = await fakeGateway({
    target_screen_id: null,
    edit_scope: 'screen',
    mode: 'patch',
    ops: [],
  });
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    await useGateway(call, gw.base);
    const before = gw.hits.length;
    const r = await gen(call, pk, login.screen_id, { prompt: '把按钮文案改得更有紧迫感' });
    // 网关返回了空 ops：说明确实交给了大模型，且没有走内置生成器
    assert.equal(r.status, 422);
    assert.equal(r.error.code, 'UNPROCESSABLE');
    assert.equal(gw.hits.length, before + 1);
    const logs = await call('GET', `${pk}/screens/${login.screen_id}/route-logs`);
    assert.equal(logs.status, 200);
    assert.equal(logs.data[0].reason, 'detect_creative_intent');
    assert.equal(logs.data[0].is_deterministic, false);
  });
  gw.server.close();
});

test('AC-205：否定语义被保留，"不要改标题只改副标题"不会误降级为改标题', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const r = await gen(call, pk, login.screen_id, { prompt: '不要改标题，只把副标题改为「登录后继续」' });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    assert.equal(r.data.route.change_source, 'builtin_rule');
    const doc = JSON.stringify(r.raw);
    assert.ok(doc.includes('登录后继续'));
    // 原主标题未被改动
    assert.ok(doc.includes('欢迎回来'));
  });
});

test('AC-211：关闭内置生成器后，确定性请求也走大模型', async () => {
  const gw = await fakeGateway({
    target_screen_id: null,
    edit_scope: 'screen',
    mode: 'patch',
    ops: [],
  });
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    await useGateway(call, gw.base);
    const off = await call('PATCH', '/api/generator', { scope: 'off' });
    assert.equal(off.status, 200);
    const before = gw.hits.length;
    const r = await gen(call, pk, login.screen_id, { prompt: '把「欢迎回来」改成「晚上好」' });
    assert.equal(r.status, 422);
    assert.equal(gw.hits.length, before + 1, '关闭后必须调用大模型');
    const logs = await call('GET', `${pk}/screens/${login.screen_id}/route-logs`);
    assert.equal(logs.data[0].reason, 'generator_disabled');
  });
  gw.server.close();
});

test('关闭单条规则后，该类请求回落大模型，其他规则不受影响', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    await call('PATCH', '/api/generator', { rules: ['bold'] });
    const r = await gen(call, pk, login.screen_id, { prompt: '把「欢迎回来」改成「晚上好」' });
    assert.equal(r.status, 422);
    const logs = await call('GET', `${pk}/screens/${login.screen_id}/route-logs`);
    assert.equal(logs.data[0].reason, 'no_rule_matched');
    assert.equal(logs.data[0].route_layer, 'llm');

    // 仍启用的 bold 规则正常短路
    const b = await gen(call, pk, login.screen_id, { prompt: '把标题加粗' });
    assert.equal(b.status, 200, JSON.stringify(b.raw));
    assert.equal(b.data.route.change_source, 'builtin_rule');
  });
});

test('显式结构化指令：anchor 定位同样生效，且不存在的目标不落库', async () => {
  await withServer({}, async ({ call }) => {
    const { pk, login } = await seedProject(call);
    const ok = await gen(call, pk, login.screen_id, {
      prompt: '改成「立即进入」',
      anchor: 'login_submit',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.raw));
    assert.equal(ok.data.route.route_layer, 'explicit');

    const miss = await gen(call, pk, login.screen_id, {
      prompt: '改成「不存在」',
      node_id: 'node_does_not_exist',
    });
    assert.equal(miss.status, 422);
    assert.equal(miss.error.code, 'UNPROCESSABLE');
  });
});
