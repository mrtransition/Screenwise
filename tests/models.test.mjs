import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshServer, client, listen } from './helpers.mjs';
import { buildScreenDoc } from '../apps/server/src/ai/local.js';

/**
 * AI 模型维护 / 选择验收：
 *  - 内置生成器永远存在且不可删除 / 停用；
 *  - 模型 CRUD 校验、密钥只写不读、更新留空保留原密钥；
 *  - 切换 / 停用 / 删除当前模型时的回退；
 *  - 生成任务必须使用当前选中模型，并记录在 jobs 里。
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

async function makeProjectAndScreen(call, name = '模型测试') {
  const p = (await call('POST', '/api/projects', { name })).data;
  const s = (await call('POST', `/api/projects/${p.project_id}/screens`, { title: '登录页' })).data;
  return { p, s };
}

test('模型目录：默认只有内置生成器，健康检查与列表都不泄漏密钥', async () => {
  await withServer({}, async ({ call }) => {
    const list = await call('GET', '/api/models');
    assert.equal(list.status, 200);
    assert.equal(list.data.models.length, 1);
    const builtin = list.data.models[0];
    assert.equal(builtin.model_id, 'mdl_local');
    assert.equal(builtin.provider, 'local');
    assert.equal(builtin.builtin, true);
    assert.equal(builtin.active, true);
    assert.equal(list.data.active_model_id, 'mdl_local');

    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.provider.provider, 'local');
    assert.equal(health.data.provider.name, '内置生成器');
    assert.ok(!JSON.stringify(health.raw).includes('api_key'));
  });
});

test('新增 / 更新模型：必填校验、密钥脱敏、留空保留、显式清除', async () => {
  await withServer({}, async ({ call }) => {
    const bad = await call('POST', '/api/models', {
      name: '缺地址',
      provider: 'openai-compatible',
      model: 'gpt-4o',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.error.code, 'BAD_REQUEST');

    const local = await call('POST', '/api/models', { name: '重复本地', provider: 'local', model: 'x' });
    assert.equal(local.status, 400);

    const created = await call('POST', '/api/models', {
      name: 'GPT-4o',
      provider: 'openai-compatible',
      model: 'gpt-4o',
      base_url: 'https://api.example.com/v1/',
      api_key: 'sk-test-abcd1234',
      timeout_ms: 45000,
    });
    assert.equal(created.status, 200, JSON.stringify(created.raw));
    const model = created.data;
    assert.match(model.model_id, /^mdl_/);
    assert.equal(model.provider, 'openai-compatible');
    assert.equal(model.base_url, 'https://api.example.com/v1', '末尾斜杠应被归一化');
    assert.equal(model.has_api_key, true);
    assert.equal(model.api_key_hint, '••••1234');
    assert.equal(model.api_key, undefined, '响应不得包含 api_key');
    assert.ok(!JSON.stringify(created.raw).includes('sk-test-abcd1234'), '响应不得回显明文密钥');

    // 更新时 api_key 留空 = 保持原密钥
    const renamed = await call('PATCH', `/api/models/${model.model_id}`, { name: 'GPT-4o 生产' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.raw));
    assert.equal(renamed.data.name, 'GPT-4o 生产');
    assert.equal(renamed.data.has_api_key, true);
    assert.equal(renamed.data.api_key_hint, '••••1234');

    // 显式清除
    const cleared = await call('PATCH', `/api/models/${model.model_id}`, { clear_api_key: true });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.raw));
    assert.equal(cleared.data.has_api_key, false);
    assert.equal(cleared.data.api_key_hint, '');

    // 非法超时
    const badTimeout = await call('PATCH', `/api/models/${model.model_id}`, { timeout_ms: 10 });
    assert.equal(badTimeout.status, 400);

    // 非法 Base URL
    const badUrl = await call('PATCH', `/api/models/${model.model_id}`, { base_url: 'ftp://x' });
    assert.equal(badUrl.status, 400);
  });
});

test('激活 / 停用 / 删除：当前模型失效时回退到内置生成器', async () => {
  await withServer({}, async ({ call }) => {
    const a = (await call('POST', '/api/models', {
      name: '模型 A',
      provider: 'openai-compatible',
      model: 'a',
      base_url: 'https://a.example.com/v1',
    })).data;
    const b = (await call('POST', '/api/models', {
      name: '模型 B',
      provider: 'openai-compatible',
      model: 'b',
      base_url: 'https://b.example.com/v1',
    })).data;

    const act = await call('POST', `/api/models/${a.model_id}/activate`, {});
    assert.equal(act.status, 200);
    assert.equal(act.data.active, true);

    let health = await call('GET', '/api/health');
    assert.equal(health.data.provider.name, '模型 A');
    assert.equal(health.data.provider.model, 'a');

    // 激活停用模型被拒绝
    await call('PATCH', `/api/models/${b.model_id}`, { enabled: false });
    const actDisabled = await call('POST', `/api/models/${b.model_id}/activate`, {});
    assert.equal(actDisabled.status, 400);

    // 停用当前模型 → 回退内置
    const stop = await call('PATCH', `/api/models/${a.model_id}`, { enabled: false });
    assert.equal(stop.status, 200);
    assert.equal(stop.data.active, false);
    let list = (await call('GET', '/api/models')).data;
    assert.equal(list.active_model_id, 'mdl_local');

    // 重新启用并激活，再删除 → 回退内置
    await call('PATCH', `/api/models/${a.model_id}`, { enabled: true });
    await call('POST', `/api/models/${a.model_id}/activate`, {});
    const del = await call('DELETE', `/api/models/${a.model_id}`, {});
    assert.equal(del.status, 200);
    assert.equal(del.data.active_model_id, 'mdl_local');
    list = (await call('GET', '/api/models')).data;
    assert.equal(list.active_model_id, 'mdl_local');
    assert.equal(list.models.some((m) => m.model_id === a.model_id), false);

    const missing = await call('POST', '/api/models/mdl_not_exist/activate', {});
    assert.equal(missing.status, 404);
  });
});

test('内置生成器不可删除、不可停用、provider 不可修改；名称可改', async () => {
  await withServer({}, async ({ call }) => {
    const del = await call('DELETE', '/api/models/mdl_local', {});
    assert.equal(del.status, 400);

    const disable = await call('PATCH', '/api/models/mdl_local', { enabled: false });
    assert.equal(disable.status, 400);

    const provider = await call('PATCH', '/api/models/mdl_local', {
      provider: 'openai-compatible',
      model: 'gpt-4o',
      base_url: 'https://api.example.com/v1',
    });
    assert.equal(provider.status, 400);

    const rename = await call('PATCH', '/api/models/mdl_local', { name: '确定性生成器' });
    assert.equal(rename.status, 200, JSON.stringify(rename.raw));
    assert.equal(rename.data.name, '确定性生成器');
    assert.equal(rename.data.provider, 'local');
    assert.equal(rename.data.builtin, true);
    assert.equal(rename.data.active, true);
  });
});

test('生成任务使用当前选中模型，并在 jobs 中留下模型快照', async () => {
  let captured = null;
  const ai = {
    generateFull: async ({ ctx, screen, project, model }) => {
      captured = model;
      const { doc } = buildScreenDoc({ instruction: ctx?.payload?.instruction || '', screen, project });
      return { mode: 'full', doc };
    },
    generatePatch: async () => ({ mode: 'patch', ops: [] }),
  };

  await withServer({ ai }, async ({ call }) => {
    const remote = (await call('POST', '/api/models', {
      name: '远端模型',
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-secret-9876',
    })).data;
    await call('POST', `/api/models/${remote.model_id}/activate`, {});

    const { p, s } = await makeProjectAndScreen(call);
    const gen = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`, {
      prompt: '登录页，手机号验证码登录',
      edit_scope: 'screen',
    });
    assert.equal(gen.status, 200, JSON.stringify(gen.raw));

    assert.ok(captured, 'provider 应收到当前选中的模型配置');
    assert.equal(captured.model_id, remote.model_id);
    assert.equal(captured.provider, 'openai-compatible');
    assert.equal(captured.model, 'gpt-4o-mini');
    assert.equal(captured.api_key, 'sk-secret-9876', '密钥只在服务端内部传递给 provider');

    const jobs = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}/jobs`)).data;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].model.model_id, remote.model_id);
    assert.equal(jobs[0].model.name, '远端模型');
    assert.equal(jobs[0].model.provider, 'openai-compatible');
    assert.equal(jobs[0].model.model, 'gpt-4o-mini');
    assert.equal(jobs[0].model.api_key, undefined, 'jobs 快照不得包含密钥');
    assert.ok(!JSON.stringify(jobs).includes('sk-secret-9876'));

    // 回退内置后，后续任务使用本地确定性生成器
    await call('POST', '/api/models/mdl_local/activate', {});
    const s2 = (await call('POST', `/api/projects/${p.project_id}/screens`, { title: '列表页' })).data;
    const gen2 = await call('POST', `/api/projects/${p.project_id}/screens/${s2.screen_id}/generations`, {
      prompt: '审批列表',
      edit_scope: 'screen',
    });
    assert.equal(gen2.status, 200, JSON.stringify(gen2.raw));
    assert.equal(captured.model_id, 'mdl_local');
    assert.equal(captured.provider, 'local');
  });
});

test('OpenAI 兼容接口：按选中模型发起 /chat/completions，并携带服务端密钥', async () => {
  let received = null;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    const doc = { version: 1, root: { id: 'remote_root', tag: 'div', props: {}, children: [] } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(doc) } }] }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;

  try {
    await withServer({}, async ({ call }) => {
      const remote = (await call('POST', '/api/models', {
        name: '自建网关',
        provider: 'openai-compatible',
        model: 'internal-1',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'sk-gateway-key',
      })).data;
      await call('POST', `/api/models/${remote.model_id}/activate`, {});

      const { p, s } = await makeProjectAndScreen(call);
      const gen = await call('POST', `/api/projects/${p.project_id}/screens/${s.screen_id}/generations`, {
        prompt: '登录页',
        edit_scope: 'screen',
      });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));

      assert.equal(received.method, 'POST');
      assert.equal(received.url, '/v1/chat/completions');
      assert.equal(received.auth, 'Bearer sk-gateway-key');
      assert.equal(received.body.model, 'internal-1');
      assert.equal(received.body.messages.length, 2);
      assert.equal(gen.data.mode, 'full');

      // 模型返回的文档确实被采用为待确认版本
      const meta = (await call('GET', `/api/projects/${p.project_id}/screens/${s.screen_id}`)).data;
      assert.equal(meta.status, 'pending');
    });
  } finally {
    await new Promise((r) => fake.close(r));
  }
});
