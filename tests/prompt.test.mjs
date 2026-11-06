import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, client, listen } from './helpers.mjs';

/**
 * Prompt 交付（API-020 / FR-PROMPT-001~012 / FR-EXPORT-006 / AC-501~503）。
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

async function seed(call) {
  const p = (await call('POST', '/api/projects', { name: 'Prompt 测试项目' })).data;
  const pid = p.project_id;

  const design = await call('PATCH', `/api/projects/${pid}/design`, {
    design: {
      title: '送货 App',
      brief: '给同城配送员的订单处理工具。密钥 sk-1234567890abcdef 不应进入 Prompt。',
      platform: 'android',
      paletteKey: 'custom',
      customPalette: { label: '品牌橙', primary: '#ff6600' },
      dynamicColor: true,
      theme: { dark: false, bothModes: true, contrast: 'medium', shape: 'rounded', font: 'robotoSerif' },
      promptOptions: ['tests', 'offline'],
    },
  });
  assert.equal(design.status, 200, JSON.stringify(design.raw));

  const mk = async (title) => {
    const r = await call('POST', `/api/projects/${pid}/screens`, { title, format: 'm3' });
    assert.equal(r.status, 200, JSON.stringify(r.raw));
    const det = await call('GET', `/api/projects/${pid}/screens/${r.data.screen_id}`);
    return { meta: r.data, doc: det.data.doc, version: det.data.current_version };
  };

  const login = await mk('登录页');
  const home = await mk('首页');

  const loginDoc = structuredClone(login.doc);
  loginDoc.groups = [
    {
      id: 'g_login',
      x: 16,
      y: 16,
      axis: 'y',
      items: [item('login_submit', 'button', '立即登录'), item('login_help', 'text', '登录页独有的帮助文案')],
    },
  ];
  const saveLogin = await call('POST', `/api/projects/${pid}/screens/${login.meta.screen_id}/doc`, {
    doc: loginDoc,
    base_version: login.version,
  });
  assert.equal(saveLogin.status, 200, JSON.stringify(saveLogin.raw));

  const homeDoc = structuredClone(home.doc);
  homeDoc.groups = [
    {
      id: 'g_home',
      x: 16,
      y: 16,
      axis: 'y',
      items: [item('home_secret', 'text', '首页机密内容'), item('home_open', 'button', '查看订单')],
    },
  ];
  const saveHome = await call('POST', `/api/projects/${pid}/screens/${home.meta.screen_id}/doc`, {
    doc: homeDoc,
    base_version: home.version,
  });
  assert.equal(saveHome.status, 200, JSON.stringify(saveHome.raw));

  const edge = await call('POST', `/api/projects/${pid}/flow/edges`, {
    source_screen_id: login.meta.screen_id,
    source_item_id: 'login_submit',
    target_screen_id: home.meta.screen_id,
    transition: 'slide',
  });
  assert.equal(edge.status, 200, JSON.stringify(edge.raw));

  return { pid, login, home, edge: edge.data };
}

test('API-020 / FR-PROMPT-002：四种语言都能生成结构化 Prompt，且可重复', async () => {
  await withServer(async ({ call }) => {
    const { pid } = await seed(call);
    const expectedTitle = {
      zh: '编码 Agent Prompt',
      en: 'Coding Agent Prompt',
      ja: 'コーディングエージェント向け Prompt',
      ko: '코딩 에이전트 Prompt',
    };
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const res = await call('GET', `/api/projects/${pid}/prompt?lang=${lang}`);
      assert.equal(res.status, 200, JSON.stringify(res.raw));
      assert.equal(res.data.lang, lang);
      assert.equal(res.data.scope, 'project');
      assert.ok(res.data.markdown.startsWith(`# ${expectedTitle[lang]}`), `${lang} 标题不正确`);
      assert.match(res.data.digest, /^sha256:/);
      assert.ok(res.data.bytes > 0);
      assert.ok(Array.isArray(res.data.marks) && res.data.marks.some((m) => m.kind === 'screen'));
      // 同一输入同一输出（C-027 / AI-023）
      const again = await call('GET', `/api/projects/${pid}/prompt?lang=${lang}`);
      assert.equal(again.data.markdown, res.data.markdown);
      assert.equal(again.data.digest, res.data.digest);
    }

    const bad = await call('GET', `/api/projects/${pid}/prompt?lang=fr`);
    assert.equal(bad.status, 400);
  });
});

test('FR-PROMPT-001/003/010/011：结构、选项顺序、平台与安全过滤', async () => {
  await withServer(async ({ call }) => {
    const { pid } = await seed(call);
    const res = await call('GET', `/api/projects/${pid}/prompt?lang=en`);
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    const md = res.data.markdown;

    for (const heading of ['## Goal', '## Colors', '## Theme', '## Layout', '## Behavior', '## Style', '## General requirements', '## Options']) {
      assert.ok(md.includes(heading), `缺少分节：${heading}`);
    }
    assert.ok(md.includes('#ff6600'), '颜色必须来自项目设计');
    assert.ok(md.includes('robotoSerif'), '字体必须写入 Prompt');
    assert.ok(md.includes('platform') || md.includes('Platform'), '需要平台信息');
    assert.ok(md.includes('登录页') && md.includes('首页'), '全项目 Prompt 应包含各屏标题');
    assert.ok(md.includes('login_submit') && md.includes('立即登录'), '应包含部件 id 与文案');
    assert.ok(md.includes('登录页独有的帮助文案') && md.includes('首页机密内容'), '全项目 Prompt 应包含各屏正文');

    const testsAt = md.indexOf('Add automated tests');
    const offlineAt = md.indexOf('offline');
    assert.ok(testsAt > 0 && offlineAt > testsAt, 'Prompt 选项必须按项目配置顺序追加');
    assert.ok(!md.includes('sk-1234567890abcdef'), 'Prompt 不得包含 API Key');
    assert.ok(!md.includes('E:\\workspace'), 'Prompt 不得包含服务端路径');
    assert.equal(res.data.platform, 'android');
  });
});

test('FR-PROMPT-005 / C-021：单屏 Prompt 只嵌入目标屏正文，其它屏仅标题', async () => {
  await withServer(async ({ call }) => {
    const { pid, login, home } = await seed(call);
    const res = await call('GET', `/api/projects/${pid}/prompt?lang=en&screen_id=${login.meta.screen_id}`);
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.equal(res.data.scope, 'screen');
    assert.equal(res.data.screen_id, login.meta.screen_id);
    assert.equal(res.data.editable, false);

    const md = res.data.markdown;
    assert.ok(md.includes('登录页独有的帮助文案'), '目标屏正文必须存在');
    assert.ok(!md.includes('首页机密内容'), '其它屏正文不得出现');
    assert.ok(md.includes('Other screens (titles only'), '应提供标题级导航提示');
    assert.ok(md.includes('首页'), '其它屏标题可作为导航提示');

    const missing = await call('GET', `/api/projects/${pid}/prompt?lang=en&screen_id=scr_missing`);
    assert.equal(missing.status, 404);
    assert.equal(home.meta.screen_id.length > 0, true);
  });
});

test('FR-PROMPT-004 / AC-503：promptEdit 优先，重置恢复自动生成', async () => {
  await withServer(async ({ call }) => {
    const { pid, login } = await seed(call);
    const auto = (await call('GET', `/api/projects/${pid}/prompt?lang=en`)).data;

    const save = await call('PATCH', `/api/projects/${pid}/design`, {
      design: { promptEdit: '# 手工 Prompt\n\n只实现登录页。' },
      change_summary: '保存手工 Prompt',
    });
    assert.equal(save.status, 200, JSON.stringify(save.raw));

    const edited = (await call('GET', `/api/projects/${pid}/prompt?lang=en`)).data;
    assert.equal(edited.edited, true);
    assert.equal(edited.markdown, '# 手工 Prompt\n\n只实现登录页。');
    assert.deepEqual(edited.marks, [], '手工编辑后自动行号标记失效');
    assert.notEqual(edited.digest, auto.digest);

    // 单屏 Prompt 不受项目级手工编辑影响
    const single = (await call('GET', `/api/projects/${pid}/prompt?lang=en&screen_id=${login.meta.screen_id}`)).data;
    assert.equal(single.edited, false);
    assert.ok(single.markdown.includes('登录页独有的帮助文案'));

    const reset = await call('PATCH', `/api/projects/${pid}/design`, {
      design: { promptEdit: null },
      change_summary: '重置 Prompt',
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.raw));
    assert.equal(reset.data.design.promptEdit, null);

    const restored = (await call('GET', `/api/projects/${pid}/prompt?lang=en`)).data;
    assert.equal(restored.edited, false);
    assert.equal(restored.markdown, auto.markdown);
  });
});

test('FR-EXPORT-006 / FR-PROMPT-008：Prompt 包包含 prompt/design/agent/README 并可下载', async () => {
  await withServer(async ({ call, server }) => {
    const { pid } = await seed(call);

    const res = await call('POST', `/api/projects/${pid}/export`, { format: 'prompt', lang: 'en' });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.deepEqual(res.data.file_names, ['prompt.md', 'design.json', 'agent.md', 'README.md']);
    assert.ok(res.data.prompt.includes('Coding Agent Prompt'));
    assert.match(res.data.zip_base64, /^UEsDB/); // ZIP 本地文件头 PK\x03\x04

    const zip = Buffer.from(res.data.zip_base64, 'base64');
    const raw = zip.toString('utf8');
    for (const name of ['prompt.md', 'design.json', 'agent.md', 'README.md']) assert.ok(raw.includes(name), `ZIP 缺少 ${name}`);
    const design = JSON.parse(res.data.files['design.json']);
    assert.equal(design.schema, 'm3studio/project@1');
    assert.ok(design.frames.some((f) => f.name === '登录页'));
    assert.ok(design.groups.some((g) => g.items.some((i) => i.id === 'login_submit' && i.action?.to)));

    // 直接下载 ZIP
    const base = `http://127.0.0.1:${server.address().port}`;
    const dl = await fetch(`${base}/api/projects/${pid}/export/prompt?lang=en`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-type') || '', /application\/zip/);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');
  });
});

test('FR-PROMPT-005：单屏 Prompt 包的 design.json 不包含其它屏正文', async () => {
  await withServer(async ({ call }) => {
    const { pid, login } = await seed(call);
    const res = await call('POST', `/api/projects/${pid}/export`, {
      format: 'prompt',
      lang: 'en',
      screen_id: login.meta.screen_id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.ok(!res.data.files['design.json'].includes('首页机密内容'));
    assert.ok(res.data.files['design.json'].includes('登录页独有的帮助文案'));
  });
});
