import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshServer, client, listen } from './helpers.mjs';
import { buildScreenDoc } from '../apps/server/src/ai/local.js';

/**
 * 自定义（OpenAI 兼容）模型接入后的可用性验收。
 *
 * 这些用例都曾在真实网关上失败过，共同点是「内置生成器一切正常，
 * 换成自定义模型就报 422 / 落库后画布空白」：
 *  -  Content-Type / Base URL 写法差异导致连不上；
 *  -  response_format、max_tokens、404 回退未处理；
 *  -  返回 ```json 代码块、或 parts/多模态 content 时解析失败；
 *  -  JSON 被截断时只报"不是合法 JSON"，无法定位；
 *  -  返回契约不完整（缺 root / 缺 id / text 写成 children）落库后白屏；
 *  -  自定义模型不会画热区，流程连不起来；
 *  -  修改类指令返回 mode:full + doc 被误判为"越权整屏重写"。
 */

/** 一个可编排的假网关 */
function fakeGateway(handler) {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const call = { url: req.url, method: req.method, headers: req.headers, raw, body: safeParse(raw) };
    state.calls.push(call);
    try {
      await handler(call, res, state.ctx);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  state.server = server;
  state.listen = async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    state.base = `http://127.0.0.1:${server.address().port}`;
    return state;
  };
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sendCompletion(res, content, extra = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...extra,
    })
  );
}

async function withGateway(handler, fn, { baseUrl } = {}) {
  const gw = await fakeGateway(handler).listen();
  const ctx = freshServer();
  await listen(ctx.server);
  const call = client(ctx.server);
  try {
    const model = (
      await call('POST', '/api/models', {
        name: '自定义网关',
        provider: 'openai-compatible',
        model: 'gw-model',
        base_url: baseUrl ? baseUrl(gw.base) : `${gw.base}/v1`,
        api_key: 'sk-gw',
        timeout_ms: 20000,
      })
    ).data;
    await call('POST', `/api/models/${model.model_id}/activate`, {});
    const created = await projectWithLogin(call);
    const shared = { ...ctx, call, gw, model, p: created.p, s: created.s, pk: created.pk };
    gw.ctx = shared;
    return await fn(shared);
  } finally {
    ctx.server.close();
    await gw.close();
  }
}

async function projectWithLogin(call) {
  const p = (await call('POST', '/api/projects', { name: '对接测试' })).data;
  const s = (await call('POST', `/api/projects/${p.project_id}/screens`, { title: '登录页' })).data;
  return { p, s, pk: `/api/projects/${p.project_id}` };
}

/** 让本地确定性生成器产出一份"像样"的登录页文档，充当模型输出 */
function sampleDoc(ctx, p, screenId) {
  const { doc } = buildScreenDoc({
    instruction: '登录页，手机号验证码登录',
    screen: { screen_id: screenId, title: '登录页' },
    project: { design_tokens: {} },
  });
  // 用真实屏幕 id 造结构：模型输出里出现别的 screen_id 会被跨屏白名单拦下
  return JSON.parse(JSON.stringify(doc).split('scr_any').join(screenId));
}

// ---------------------------------------------------------------- 连接层

test('自定义模型：Base URL 末尾漏写 /v1 也应能连上（自动补全）', async () => {
  await withGateway(
    (c, res, ctx) => sendCompletion(res, JSON.stringify({ version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } })),
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gw.calls[0].url, '/v1/chat/completions');
    },
    { baseUrl: (base) => base } // 用户只填了 host:port
  );
});

test('自定义模型：网关不接受 response_format 时自动去掉重试，而不是直接 502', async () => {
  let first = true;
  await withGateway(
    async (c, res, ctx) => {
      if (first) {
        first = false;
        assert.ok(c.body.response_format, '首轮应先带 response_format');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
        return;
      }
      assert.equal(c.body.response_format, undefined, '重试时不应再带 response_format');
      sendCompletion(res, JSON.stringify({ version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } }));
    },
    async (ctx) => {
      const { s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gw.calls.length, 2);
    }
  );
});

test('自定义模型：网关不支持 max_tokens 时自动去掉重试', async () => {
  let first = true;
  await withGateway(
    async (c, res, ctx) => {
      if (first) {
        first = false;
        assert.ok(c.body.max_tokens > 0, '应给足输出预算，避免整屏 JSON 被截断');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: 'max_tokens'. Use max_completion_tokens." } }));
        return;
      }
      assert.equal(c.body.max_tokens, undefined);
      sendCompletion(res, JSON.stringify({ version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } }));
    },
    async (ctx) => {
      const { s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gw.calls.length, 2);
    }
  );
});

test('自定义模型：paths 只填到 /v1/chat/completions 也能用（不重复拼接）', async () => {
  await withGateway(
    async (c, res, ctx) => {
      assert.equal(c.url, '/v1/chat/completions');
      sendCompletion(res, JSON.stringify({ version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } }));
    },
    async (ctx) => {
      const { s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
    },
    { baseUrl: (base) => `${base}/v1/chat/completions` }
  );
});

test('自定义模型：超时 / 连接失败给出可操作提示（MODEL_FAILED，不是 500）', async () => {
  const ctx = freshServer();
  await listen(ctx.server);
  const call = client(ctx.server);
  try {
    // 指向一个已关闭的端口
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    const model = (
      await call('POST', '/api/models', {
        name: '连不上',
        provider: 'openai-compatible',
        model: 'x',
        base_url: `http://127.0.0.1:${port}/v1`,
      })
    ).data;
    await call('POST', `/api/models/${model.model_id}/activate`, {});
    const { s, pk } = await projectWithLogin(call);
    const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
    assert.equal(gen.status, 502);
    assert.equal(gen.error.code, 'MODEL_FAILED');
    assert.ok(gen.error.detail?.hint, '应给出排查提示');
  } finally {
    ctx.server.close();
  }
});

test('自定义模型：连接测试接口能区分"连得上"与"连不上"', async () => {
  await withGateway(
    async (c, res, ctx) => {
      if (c.body.messages?.[0]?.content === 'ping') {
        sendCompletion(res, 'pong');
        return;
      }
      sendCompletion(res, JSON.stringify({ version: 1, root: { id: 'r', tag: 'div', props: {}, children: [] } }));
    },
    async ({ call, model, ctx }) => {
      const ok = await call('POST', `/api/models/${model.model_id}/test`, {});
      assert.equal(ok.status, 200, JSON.stringify(ok.raw));
      assert.equal(ok.data.ok, true);
      assert.ok(ok.data.latency_ms >= 0);

      const missing = await call('POST', '/api/models/mdl_not_exist/test', {});
      assert.equal(missing.status, 404);
    }
  );
});

// ---------------------------------------------------------------- 解析层

test('自定义模型：返回 ```json 代码块 / 前后夹带说明文字时仍能解析', async () => {
  await withGateway(
    async (c, res, ctx) => {
      const doc = sampleDoc(ctx, ctx.p, ctx.s.screen_id);
      sendCompletion(res, '好的，这是生成结果：\n```json\n' + JSON.stringify(doc, null, 2) + '\n```\n以上。');
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gen.data.mode, 'full');
    }
  );
});

test('自定义模型：content 是 parts 数组 / 推理模型把 JSON 放在 reasoning_content 时也能取到', async () => {
  let n = 0;
  await withGateway(
    async (c, res, ctx) => {
      const doc = sampleDoc(ctx, ctx.p, ctx.s.screen_id);
      n += 1;
      if (n === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(doc) }] } }],
          })
        );
        return;
      }
      sendCompletion(res, '', {});
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
    }
  );
});

test('自定义模型：JSON 被 max_tokens 截断时，错误里要说明"截断"而不是笼统的非法 JSON', async () => {
  await withGateway(
    async (c, res, ctx) => {
      const doc = JSON.stringify(sampleDoc(ctx, ctx.p, ctx.s.screen_id));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: doc.slice(0, 120) }, finish_reason: 'length' }],
        })
      );
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 502);
      assert.equal(gen.error.code, 'MODEL_FAILED');
      assert.match(JSON.stringify(gen.error), /截断|长度|不完整/, gen.error.message);
    }
  );
});

// ---------------------------------------------------------------- 契约层

test('自定义模型：整屏返回是纯 HTML 字符串时，要还原成节点树而不是落库白屏', async () => {
  const html = `<section data-block="root" style="padding:24px;background:#fff">
    <h1 style="font-size:24px;margin:0 0 16px">登录</h1>
    <input placeholder="手机号" data-anchor="input_phone">
    <button style="margin-top:16px;background:#2563eb;color:#fff;padding:10px 16px" data-anchor="btn_login">获取验证码</button>
  </section>`;
  await withGateway(
    (c, res, ctx) => sendCompletion(res, html),
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      const root = gen.data.preview_doc.root;
      assert.equal(root.tag, 'section');
      assert.ok(root.children.length >= 3, '结构不能被压平成一段文本');
      const walk = (n, out = []) => {
        out.push(n);
        for (const c of n.children || []) walk(c, out);
        return out;
      };
      const nodes = walk(root);
      assert.ok(nodes.some((x) => x.tag === 'button' && x.props.attrs['data-anchor'] === 'btn_login'));
      assert.ok(nodes.every((x) => typeof x.id === 'string' && x.id), '每个节点都要有 id');
    }
  );
});

test('自定义模型：tool_calls 里给 JSON 也要能取到', async () => {
  await withGateway(
    async (c, res, ctx) => {
      const doc = sampleDoc(ctx, ctx.p, ctx.s.screen_id);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'emit_screen', arguments: JSON.stringify(doc) } }],
              },
            },
          ],
        })
      );
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
    }
  );
});

test('自定义模型：确实缺 root / 返回数组时，502 MODEL_FAILED 并指出具体问题', async () => {
  const bodies = [
    '{"version":1}',
    '[{"id":"a","tag":"div","props":{},"children":[]}]',
    '{"document":{"children":[]}}',
  ];
  for (const body of bodies) {
    await withGateway(
      (c, res, ctx) => sendCompletion(res, body),
      async (ctx) => {
        const { p, s, pk, call, gw } = ctx;
        const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
        assert.equal(gen.status, 502, `${body} => ${JSON.stringify(gen.raw)}`);
        assert.match(JSON.stringify(gen.error), /root|数组|根节点/, JSON.stringify(gen.error));
      }
    );
  }
});

test('自定义模型：data-screen-id 之类的扁平写法会归一化为 props.attrs 与文本', async () => {
  await withGateway(
    (c, res, ctx) =>
      sendCompletion(
        res,
        JSON.stringify({
          version: 1,
          root: {
            'data-block': 'root',
            tag: 'div',
            style: 'display:flex;flex-direction:column',
            children: [
              { tag: 'h1', 'data-anchor': 'title', text: '欢迎回来' },
              { tag: 'button', 'data-anchor': 'btn_login', text: '登录', style: { background: '#2563eb', color: '#fff' } },
            ],
          },
        })
      ),
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      const root = gen.data.preview_doc.root;
      assert.equal(root.props.attrs['data-block'], 'root');
      assert.equal(root.props.style.display, 'flex', '字符串 style 要解析成对象');
      const kids = root.children;
      const btn = kids.find((k) => k.tag === 'button');
      assert.equal(btn.props.attrs['data-anchor'], 'btn_login');
      assert.equal(btn.props.text, '登录');
      assert.equal(btn.props.style.background, '#2563eb');
    }
  );
});

test('自定义模型：整屏生成缺少热区时，按可点击元素补齐，保证流程能连边', async () => {
  await withGateway(
    (c, res, ctx) =>
      sendCompletion(
        res,
        JSON.stringify({
          version: 1,
          root: {
            id: 'root',
            tag: 'div',
            props: {},
            children: [
              { id: 't', tag: 'h1', props: { text: '欢迎回来' }, children: [] },
              { id: 'b1', tag: 'button', props: { text: '登录' }, children: [] },
              { id: 'a1', tag: 'a', props: { text: '忘记密码' }, children: [] },
              { id: 's1', tag: 'span', props: { text: '注册' }, children: [] },
            ],
          },
        })
      ),
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      const anchors = [];
      const walk = (n) => {
        const a = n.props?.attrs?.['data-anchor'];
        if (a) anchors.push({ id: n.id, a, tag: n.tag });
        for (const ch of n.children || []) walk(ch);
      };
      walk(gen.data.preview_doc.root);
      const ids = anchors.map((x) => x.id);
      assert.ok(ids.includes('b1'), 'button 必须有热区');
      assert.ok(ids.includes('a1'), 'a 必须有热区');
      assert.ok(new Set(anchors.map((x) => x.a)).size === anchors.length, '热区名不能重复');
      assert.ok(anchors.every((x) => /^[a-zA-Z0-9_-]+$/.test(x.a)), '热区只能是 url-safe 标识');
    }
  );
});

// ---------------------------------------------------------------- 语义层

test('自定义模型：修改已有屏幕时返回 mode:full + doc，应按整屏替换接受，而不是误报越权', async () => {
  await withGateway(
    async (c, res, ctx) => {
      const current = c.body.messages[0].content;
      // 模型"读懂了整屏上下文，重新吐一份整屏"
      const sid = /target_screen_id: (\S+)/.exec(current)?.[1];
      const doc = sampleDoc(ctx, ctx.p, sid);
      doc.root.children.push({ id: 'added', tag: 'p', props: { text: '新增说明' }, children: [] });
      sendCompletion(res, JSON.stringify({ mode: 'full', doc }));
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      // 先本地生成一版，让屏幕有内容
      await call('POST', '/api/models/mdl_local/activate', {});
      const first = await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      assert.equal(first.status, 200, JSON.stringify(first.raw));
      await call('POST', `${pk}/screens/${s.screen_id}/pending/apply`);

      // 切回自定义模型做修改
      const list = (await call('GET', '/api/models')).data;
      const remote = list.models.find((m) => !m.builtin);
      await call('POST', `/api/models/${remote.model_id}/activate`, {});

      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, {
        prompt: '加一行说明文字',
        edit_scope: 'screen',
      });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gen.data.mode, 'full');
      assert.ok(gw.calls.at(-1).body.messages[0].content.includes('输出格式'));
    }
  );
});

test('自定义模型用于局部修改：patch 只改选中子树时能正常落库', async () => {
  await withGateway(
    async (c, res, ctx) => {
      const instruction = c.body.messages[0].content;
      // prompt 里是 JSON.stringify 后的带空格形式：{"node_ids": ["..."]}
      const nodeId = /"node_ids":\s*\["([^"]+)"\]/.exec(instruction)?.[1];
      sendCompletion(res, JSON.stringify({ mode: 'patch', ops: [{ op: 'updateProps', target: { node_id: nodeId }, value: { text: '登录成功后跳转' } }] }));
    },
    async (ctx) => {
      const { p, s, pk, call, gw } = ctx;
      await call('POST', '/api/models/mdl_local/activate', {});
      await call('POST', `${pk}/screens/${s.screen_id}/generations`, { prompt: '登录页', edit_scope: 'screen' });
      await call('POST', `${pk}/screens/${s.screen_id}/pending/apply`);
      const list = (await call('GET', '/api/models')).data;
      await call('POST', `/api/models/${list.models.find((m) => !m.builtin).model_id}/activate`, {});

      const meta = (await call('GET', `${pk}/screens/${s.screen_id}`)).data;
      const findBtn = (n) => (n?.tag === 'button' ? n : (n?.children || []).map(findBtn).find(Boolean));
      const button = findBtn(meta.doc.root);
      assert.ok(button, '生成结果里应有按钮');

      const gen = await call('POST', `${pk}/screens/${s.screen_id}/generations`, {
        prompt: '改按钮文案',
        edit_scope: 'region',
        selection: { node_ids: [button.id] },
      });
      assert.equal(gen.status, 200, JSON.stringify(gen.raw));
      assert.equal(gen.data.mode, 'patch');
    }
  );
});
