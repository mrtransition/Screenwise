import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../apps/server/src/index.js';

let seq = 0;
export function freshServer(opts = {}) {
  const repoRoot = `.box-agent-scratch/test-${process.pid}-${Date.now()}-${seq++}`;
  const { server, repo, service } = createServer({ repoRoot, ...opts });
  return { server, repo, service, repoRoot };
}

export function client(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: json.ok, data: json.data, error: json.error, raw: json };
  };
}

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

/** 搭一个三屏项目：登录页 / 审批列表 / 审批详情，并各生成一次 */
export async function seedProject(call) {
  const p = (await call('POST', '/api/projects', { name: '报销审批原型' })).data;
  const pk = `/api/projects/${p.project_id}`;
  // 这些夹具覆盖旧 node-tree 只读渲染与兼容链路；新建屏默认 M3 的用例见 m2-editor.test.mjs
  const mk = async (title) => (await call('POST', `${pk}/screens`, { title, format: 'node-tree' })).data;
  const login = await mk('登录页');
  const list = await mk('审批列表');
  const detail = await mk('审批详情');

  const generate = async (sid, prompt) => {
    const g = await call('POST', `${pk}/screens/${sid}/generations`, { prompt, edit_scope: 'screen' });
    assert.equal(g.status, 200, `生成失败: ${JSON.stringify(g.raw)}`);
    const a = await call('POST', `${pk}/screens/${sid}/pending/apply`);
    assert.equal(a.status, 200, `应用失败: ${JSON.stringify(a.raw)}`);
    return a.data.version;
  };

  await generate(login.screen_id, '登录页，手机号验证码登录');
  await generate(list.screen_id, '审批列表，展示待审批单据');
  await generate(detail.screen_id, '审批详情，金额和审批流程');
  return { project: p, pk, login, list, detail };
}
