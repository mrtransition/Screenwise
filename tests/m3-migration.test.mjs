import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/server/src/index.js';
import { client, listen } from './helpers.mjs';
import { planMigration, runMigration, restoreData } from '../apps/server/src/store/migrate.js';
import { renderScreenDocument, renderM3Body, assertM3Renderable } from '../apps/web/src/screen-render.js';

/**
 * M1 数据与存储验收（SRS §11）：
 *   AC-301/315/316/601/603/604/605/607/608/609/610/611/612/613
 * 另外覆盖 ProjectDesign 权威入口、只读渲染安全与共享渲染契约。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/m3e-sample.json'), 'utf8'));
let seq = 0;

function tmpRoot(tag) {
  return `.box-agent-scratch/m3m-${tag}-${process.pid}-${Date.now()}-${seq++}`;
}

async function withServer(tag, fn) {
  const repoRoot = tmpRoot(tag);
  const { server, repo } = createServer({ repoRoot });
  await listen(server);
  try {
    await fn({ call: client(server), repoRoot, repo, base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.close();
    await fsp.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const clone = (v) => structuredClone(v);

/* ------------------------------------------------------------------ */
/* M3E 导入 / 导出                                                     */
/* ------------------------------------------------------------------ */

test('AC-301 / AC-605：导入含 3+1 屏、主题与 action 的 M3E，生成屏幕与 FlowEdge', async () => {
  await withServer('ac301', async ({ call, repoRoot }) => {
    const res = await call('POST', '/api/projects/import', clone(fixture));
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    const pid = res.data.project_id;
    assert.match(pid, /^prj_/);

    const screens = (await call('GET', `/api/projects/${pid}/screens`)).data;
    assert.equal(screens.length, 4, '3 个 frame + 1 个未放置屏');
    for (const s of screens) {
      assert.equal(s.format, 'm3');
      assert.equal(s.readonly, false);
      assert.equal(s.doc.schema, 'm3studio/screen@1');
      const text = JSON.stringify(s.doc);
      assert.equal(text.includes('"action"'), false, 'ScreenDoc 不得持久化 action');
      assert.equal(text.includes('"swipe"'), false, 'ScreenDoc 不得持久化 swipe');
    }

    const flow = (await call('GET', `/api/projects/${pid}/flow`)).data;
    assert.equal(flow.schema_version, 2);
    assert.equal(flow.edges.length, 7);
    const swipe = flow.edges.find((e) => e.trigger === 'swipe');
    assert.ok(swipe, '应存在 swipe 边');
    assert.equal(swipe.direction, 'left');
    assert.equal(swipe.target_screen_id, 'f_list');
    assert.ok(flow.edges.every((e) => e.orphan && typeof e.orphan === 'object'), 'API 返回动态 orphan');
    // DC-039：orphan 只在读取时计算，磁盘上的 flow.json 不得包含
    const diskFlow = fs.readFileSync(path.join(repoRoot, 'projects', pid, 'flow.json'), 'utf8');
    assert.equal(diskFlow.includes('"orphan"'), false);

    const project = (await call('GET', `/api/projects/${pid}`)).data;
    assert.equal(project.schema_version, 2);
    assert.equal(project.design.theme.shape, 'rounded');
    assert.ok(project.design.theme, '导入应写入 ProjectDesign');
  });
});

test('AC-605：导出 M3E 时 action/swipe 按 FlowEdge 注回，且不含服务端字段', async () => {
  await withServer('ac605', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const out = await call('POST', `/api/projects/${pid}/export`, { format: 'm3e' });
    assert.equal(out.status, 200, JSON.stringify(out.raw));
    const doc = out.data.doc;
    assert.equal(doc.frames.length, 4);
    const home = doc.groups.find((g) => g.items.some((i) => i.id === 'itm_card_today'));
    assert.ok(home, '应包含首页卡片组');
    const card = home.items.find((i) => i.id === 'itm_card_today');
    assert.equal(card.action.to, 'f_detail');
    assert.equal(card.action.transition, 'slide');

    const listFrame = doc.frames.find((f) => f.id === 'f_list');
    assert.equal(listFrame.swipe, undefined);
    const homeFrame = doc.frames.find((f) => f.id === 'f_home');
    assert.ok(homeFrame.swipe, 'frame.swipe 应按边注回');
    assert.equal(homeFrame.swipe.left, 'f_list');
    const text = JSON.stringify(doc);
    for (const forbidden of ['project_id', 'theme_snapshot', 'prompt_digest', 'pending', '"orphan"']) {
      assert.equal(text.includes(forbidden), false, `导出不得包含 ${forbidden}`);
    }
    assert.equal(out.data.warnings.length, 0);
  });
});

test('AC-315：非法 kind / 重复 id 返回 422 SCHEMA_INVALID，且不写入任何项目', async () => {
  await withServer('ac315', async ({ call }) => {
    const before = (await call('GET', '/api/projects')).data.length;
    const bad = clone(fixture);
    bad.groups[0].items[0].kind = 'notAKind';
    bad.groups[1].items[1].id = bad.groups[1].items[0].id;
    const res = await call('POST', '/api/projects/import', bad);
    assert.equal(res.status, 422);
    assert.equal(res.error.code, 'SCHEMA_INVALID');
    assert.ok(Array.isArray(res.error.detail.issues) && res.error.detail.issues.length > 0);
    assert.ok(res.error.detail.issues.some((i) => /kind/.test(i.path)), '错误应给出 kind 路径');
    assert.ok(res.error.detail.issues.some((i) => i.code === 'DUPLICATE'), '错误应指出重复 id');
    const after = (await call('GET', '/api/projects')).data.length;
    assert.equal(after, before, '失败导入不得产生项目');
  });
});

test('AC-612：创建新项目导入返回新 project_id，屏幕/边/坐标正确', async () => {
  await withServer('ac612', async ({ call }) => {
    const res = await call('POST', '/api/projects/import', clone(fixture));
    assert.equal(res.status, 200);
    assert.equal(res.data.screen_count, 4);
    assert.equal(res.data.edge_count, 7);

    const screens = (await call('GET', `/api/projects/${res.data.project_id}/screens`)).data;
    const home = screens.find((s) => s.screen_id === 'f_home');
    assert.ok(home, '屏幕 id 应保留 frame id');
    assert.equal(home.x, 0);
    assert.equal(screens.find((s) => s.screen_id === 'f_list').x, 532, '坐标取 frame 原位置');

    const canvas = (await call('GET', `/api/projects/${res.data.project_id}/canvas`)).data;
    assert.equal(canvas.schema_version, 2);
    assert.ok(canvas.screens.f_home, 'canvas.json 是坐标唯一源（DC-018）');

    const preview = (await call('GET', `/api/projects/${res.data.project_id}/preview`)).data;
    assert.equal(preview.screens.length, 4);
    assert.equal(preview.project.design.theme.shape, 'rounded');
    assert.ok(preview.screens[0].anchors.length > 0, 'M3 屏应给出热区');
  });
});

test('AC-613：导入到现有项目时冲突 id 重映射，失败不落库', async () => {
  await withServer('ac613', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const before = (await call('GET', `/api/projects/${pid}/screens`)).data;

    const res = await call('POST', `/api/projects/${pid}/import`, clone(fixture));
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.equal(res.data.imported_screens.length, 4);
    assert.equal(res.data.edge_count, 7, '新屏的全部 7 条边都应导入');
    assert.ok(res.data.warnings.some((w) => w.code === 'SCREEN_ID_REMAPPED'));

    const after = (await call('GET', `/api/projects/${pid}/screens`)).data;
    assert.equal(after.length, before.length + 4);
    const ids = after.map((s) => s.screen_id);
    assert.equal(new Set(ids).size, ids.length, '屏幕 id 不得重复');
    for (const s of after.filter((x) => !before.some((b) => b.screen_id === x.screen_id))) {
      assert.equal(before.some((b) => b.screen_id === s.screen_id), false, '新屏幕 id 不得与已有屏冲突');
      assert.ok(res.data.id_map.screens[s.screen_id] || s.screen_id.startsWith('scr_'), '重映射应记录在 id_map 或使用新前缀');
    }

    // 失败不落库
    const bad = clone(fixture);
    bad.groups[0].items[0].kind = 'nope';
    const fail = await call('POST', `/api/projects/${pid}/import`, bad);
    assert.equal(fail.status, 422);
    assert.equal(fail.error.code, 'SCHEMA_INVALID');
    const afterFail = (await call('GET', `/api/projects/${pid}/screens`)).data;
    assert.equal(afterFail.length, after.length, '失败导入不得写入屏幕');
  });
});

test('AC-611：multipart 大文件导入可用，超过 50MB 返回 413 IMPORT_TOO_LARGE', async () => {
  await withServer('ac611', async ({ base, call, repoRoot }) => {
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(clone(fixture))], { type: 'application/json' }), 'sample.m3e.json');
    const res = await fetch(`${base}/api/projects/import`, { method: 'POST', body: form });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.data.screen_count, 4);

    const big = path.join(repoRoot, 'oversize.json');
    const fh = await fsp.open(big, 'w');
    await fh.truncate(51 * 1024 * 1024);
    await fh.close();
    const over = await call('POST', '/api/projects/import', { file_path: big });
    assert.equal(over.status, 413);
    assert.equal(over.error.code, 'IMPORT_TOO_LARGE');
  });
});

test('AC-611 回归：multipart 文件名含中文时不得变成 latin1 乱码', async () => {
  await withServer('ac611b', async ({ base }) => {
    // 浏览器发送的 filename 是 UTF-8，手工拼字节以免依赖 FormData 的平台差异
    const send = (filename, body) => {
      const boundary = 'BOUNDARY_CN';
      const raw = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: application/json\r\n\r\n${body}\r\n--${boundary}--\r\n`,
        'utf8'
      );
      return fetch(`${base}/api/projects/import`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: raw,
      });
    };

    const ok = await (await send('项目文件.json', JSON.stringify(clone(fixture)))).json();
    assert.equal(ok.ok, true, JSON.stringify(ok));

    // JSON 非法时错误信息会回显文件名，这里能直接观察解码结果
    const bad = await (await send('项目文件.json', '{ broken ')).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /^项目文件\.json /, '文件名应按 UTF-8 解码，而不是 é¡¹ç®…');
  });
});

/* ------------------------------------------------------------------ */
/* 旧项目 / 迁移                                                       */
/* ------------------------------------------------------------------ */

const LEGACY_DOC = {
  version: 1,
  root: {
    id: 'scr_login_root',
    tag: 'section',
    props: { style: { padding: 16 } },
    children: [
      { id: 'n_title', tag: 'h1', props: { text: '登录', style: { fontSize: 28 } }, children: [] },
      {
        id: 'n_submit',
        tag: 'button',
        props: { text: '提交', attrs: { 'data-anchor': 'hs_submit', onclick: 'alert(1)' } },
        children: [],
      },
      { id: 'n_video', tag: 'video', props: { text: '' }, children: [] },
    ],
  },
};

async function writeLegacyProject(root, { pid = 'prj_old', brokenRevisions = false } = {}) {
  const projDir = path.join(root, 'projects', pid);
  await fsp.mkdir(path.join(projDir, 'screens', 'scr_login', 'versions'), { recursive: true });
  await fsp.mkdir(path.join(projDir, 'screens', 'scr_list', 'versions'), { recursive: true });
  const project = {
    project_id: pid,
    name: '旧项目',
    device: { width: 375, height: 812 },
    design_tokens: {
      colors: { primary: '#ff6600', text: '#222222' },
      radius: { sm: 16, md: 20, lg: 24 },
      font: { base: 16, family: 'Georgia, serif' },
    },
    members: [{ user: 'local-user', role: 'owner' }],
    screen_titles: [],
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
  await fsp.writeFile(path.join(projDir, 'project.json'), JSON.stringify(project));
  const docs = {
    scr_login: { title: '登录页', doc: LEGACY_DOC, order: '0001', x: 120, y: 140 },
    scr_list: {
      title: '列表页',
      order: '0002',
      x: 600,
      y: 140,
      doc: { version: 1, root: { id: 'scr_list_root', tag: 'div', props: {}, children: [{ id: 'n_list', tag: 'p', props: { text: '列表' }, children: [] }] } },
    },
  };
  for (const [sid, v] of Object.entries(docs)) {
    await fsp.writeFile(
      path.join(projDir, 'screens', sid, 'meta.json'),
      JSON.stringify({
        screen_id: sid,
        project_id: pid,
        title: v.title,
        order: v.order,
        status: 'applied',
        locked: false,
        current_version: 1,
        versions: [{ version: 1, created_at: '2025-01-01T00:00:00.000Z', kind: 'generate', label: '旧版' }],
        pending: null,
        x: v.x,
        y: v.y,
        width: 375,
        height: 812,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      })
    );
    await fsp.writeFile(
      path.join(projDir, 'screens', sid, 'versions', 'v1.json'),
      JSON.stringify({
        screen_id: sid,
        version: 1,
        version_id: `${sid}@v1`,
        created_at: '2025-01-01T00:00:00.000Z',
        source: { kind: 'generate' },
        change_source: 'ai_patch',
        doc: v.doc,
      })
    );
  }
  await fsp.writeFile(
    path.join(projDir, 'flow.json'),
    JSON.stringify({
      schema_version: 1,
      edges: [
        {
          edge_id: 'e1',
          source_screen_id: 'scr_login',
          source_hotspot_id: 'hs_submit',
          target_screen_id: 'scr_list',
          trigger: 'click',
          status: 'confirmed',
          animation: 'slide',
          orphan: false,
        },
      ],
    })
  );
  await fsp.writeFile(path.join(projDir, 'canvas.json'), JSON.stringify({ schema_version: 1, viewport: { x: 10, y: 10, zoom: 1 } }));
  if (brokenRevisions) await fsp.mkdir(path.join(projDir, 'design-revisions.json'), { recursive: true });
  return { pid, projDir };
}

test('AC-604 / AC-603 / AC-607：迁移把 design_tokens 映射为 ProjectDesign，保留旧边且幂等', async () => {
  const root = tmpRoot('mig');
  try {
    await writeLegacyProject(root);
    const plan = await planMigration(root);
    assert.equal(plan.summary.pending, 1);
    assert.ok(plan.projects[0].actions.some((a) => /schema_version/.test(a)));

    const first = await runMigration(root);
    assert.ok(first.backup && fs.existsSync(first.backup), '迁移前必须备份');

    const proj = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'project.json'), 'utf8'));
    assert.equal(proj.schema_version, 2);
    assert.equal(proj.design.platform, 'android');
    assert.equal(proj.design.customPalette.primary, '#ff6600', 'AC-604：主色进入 customPalette');
    assert.equal(proj.design_tokens.colors.primary, '#ff6600', 'AC-604：原 tokens 必须原样保留');

    const meta = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'screens', 'scr_login', 'meta.json'), 'utf8'));
    assert.equal(meta.format, 'node-tree');
    assert.equal(meta.x, undefined, 'DC-018：meta 不得再持有坐标');

    const canvas = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'canvas.json'), 'utf8'));
    assert.equal(canvas.screens.scr_login.x, 120);
    assert.equal(canvas.screens.scr_login.y, 140);

    const flow = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'flow.json'), 'utf8'));
    assert.equal(flow.schema_version, 2);
    assert.equal(flow.edges.length, 1, 'AC-603：旧边必须保留');
    assert.equal(flow.edges[0].source_item_id, 'hs_submit', 'AC-603：source_hotspot_id → source_item_id');
    assert.equal(flow.edges[0].orphan, undefined, 'DC-039：orphan 不持久化');
    assert.equal(flow.edges[0].transition, 'slide');

    const second = await runMigration(root);
    assert.equal(second.summary.pending, 0, 'AC-607：重复执行应跳过');
    const screensAfter = (await fsp.readdir(path.join(root, 'projects', 'prj_old', 'screens'))).sort();
    assert.deepEqual(screensAfter, ['scr_list', 'scr_login'], 'AC-607：不得重复建屏');
    const flowAfter = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'flow.json'), 'utf8'));
    assert.equal(flowAfter.edges.length, 1, 'AC-607：不得重复建边');
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('AC-608 / AC-610：迁移失败自动恢复备份，--restore 可回到迁移前', async () => {
  const root = tmpRoot('migfail');
  try {
    await writeLegacyProject(root, { brokenRevisions: true });
    await assert.rejects(() => runMigration(root), /恢复/);

    const proj = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'project.json'), 'utf8'));
    assert.equal(proj.schema_version, undefined, 'AC-608：失败后原 project.json 不变');
    const meta = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'screens', 'scr_login', 'meta.json'), 'utf8'));
    assert.equal(meta.x, 120, 'AC-608：失败后原 meta 坐标仍在');

    // AC-610：显式恢复
    const backups = (await fsp.readdir(path.dirname(path.resolve(root)))).filter((n) => n.startsWith(`${path.basename(root)}.backup-`));
    assert.ok(backups.length >= 1, '应存在迁移备份');
    const restored = await restoreData(root, path.join(path.dirname(path.resolve(root)), backups.sort().at(-1)));
    assert.ok(restored.restored_from);
    const after = JSON.parse(await fsp.readFile(path.join(root, 'projects', 'prj_old', 'project.json'), 'utf8'));
    assert.equal(after.schema_version, undefined, 'AC-610：恢复后回到迁移前');
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    const dir = path.dirname(path.resolve(root));
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.startsWith(`${path.basename(root)}.backup-`) || name.startsWith(`${path.basename(root)}.pre-restore-`)) {
        await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
});

test('AC-601 / AC-316：旧项目可只读预览/导出，M3 渲染器拒绝 node-tree', async () => {
  const root = tmpRoot('legacy');
  try {
    await writeLegacyProject(root);
    await runMigration(root);
    const { server } = createServer({ repoRoot: root });
    await listen(server);
    const call = client(server);
    try {
      const screens = (await call('GET', '/api/projects/prj_old/screens')).data;
      assert.ok(screens.every((s) => s.format === 'node-tree' && s.readonly === true));

      const preview = (await call('GET', '/api/projects/prj_old/preview')).data;
      assert.equal(preview.screens.length, 2);
      assert.ok(preview.screens.every((s) => s.format === 'node-tree' && s.readonly === true));
      assert.equal(preview.edges[0].source_hotspot_id, 'hs_submit');
      assert.equal(preview.screens[0].theme_snapshot.shape, 'rounded');

      const exp = await call('POST', '/api/projects/prj_old/export', { name: 'legacy-export' });
      assert.equal(exp.status, 200, JSON.stringify(exp.raw));
      const html = fs.readFileSync(path.join(root, '..', 'exports', 'legacy-export', 'index.html'), 'utf8');
      assert.ok(html.includes('scr_login'));
      assert.equal(/onclick=/i.test(html), false, '只读渲染必须剥离事件属性');
      fs.rmSync(path.join(root, '..', 'exports', 'legacy-export'), { recursive: true, force: true });

      // 旧屏转换：不提交，返回损失报告
      const conv = await call('POST', '/api/projects/prj_old/screens/scr_login/convert', {});
      assert.equal(conv.status, 200, JSON.stringify(conv.raw));
      assert.equal(conv.data.saved, false);
      assert.equal(conv.data.doc.format, 'm3');
      assert.ok(conv.data.doc.groups[0].items.some((i) => i.id === 'hs_submit'), 'data-anchor 应映射为 Item id');
      assert.ok(conv.data.report.loss.some((l) => l.tag === 'video'), '无法映射节点必须进入损失报告（AC-609）');

      // 只读渲染器安全
      const legacyHtml = renderScreenDocument({ format: 'node-tree', ...LEGACY_DOC }, {});
      assert.equal(/onclick/i.test(legacyHtml), false);
      assert.equal(/javascript:/i.test(legacyHtml), false);
      assert.ok(legacyHtml.includes('data-anchor="hs_submit"'));
      assert.throws(() => assertM3Renderable({ format: 'node-tree', root: LEGACY_DOC.root }));
      const m3html = renderM3Body(conv.data.doc, { theme: { shape: 'rounded' } });
      assert.ok(m3html.includes('m3-screen'));
      assert.ok(m3html.includes('data-anchor="hs_submit"'));
    } finally {
      server.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('AC-609：转换把无法映射的节点降级为 box/text 并列出损失', async () => {
  const doc = {
    version: 1,
    root: {
      id: 'r',
      tag: 'section',
      props: {},
      children: [
        { id: 'a', tag: 'h2', props: { text: '标题' }, children: [] },
        { id: 'b', tag: 'marquee', props: { text: '滚动' }, children: [] },
        { id: 'c', tag: 'span', props: { text: '正文' }, children: [] },
      ],
    },
  };
  const { convertLegacyToM3 } = await import('../apps/server/src/domain/legacy.js');
  const out = convertLegacyToM3(doc, { screenId: 'scr_x', title: '旧屏' });
  assert.ok(out.report.loss.some((l) => l.tag === 'marquee' && l.fallback === 'text'));
  assert.ok(out.doc.groups[0].items.some((i) => i.kind === 'text' && i.label === '标题'));
  assert.ok(out.doc.groups[0].items.some((i) => i.kind === 'text' && i.label === '正文'));
});

/* ------------------------------------------------------------------ */
/* ProjectDesign 权威入口                                              */
/* ------------------------------------------------------------------ */

test('API-015/016：/design 是权威入口，主题变更只记项目修订、不递增屏幕版本', async () => {
  await withServer('design', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const screen = (await call('GET', `/api/projects/${pid}/screens`)).data[0];
    const beforeVersion = screen.current_version;

    const res = await call('PATCH', `/api/projects/${pid}/design`, {
      design: { paletteKey: 'green', theme: { shape: 'full', dark: true, contrast: 'high', font: 'robotoSerif', motion: 'expressive' } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.raw));
    assert.equal(res.data.design.paletteKey, 'green');
    assert.equal(res.data.design.theme.shape, 'full');

    const detail = (await call('GET', `/api/projects/${pid}/design`)).data;
    assert.ok(detail.revisions.length >= 2, '应记录项目修订');
    assert.equal(detail.revisions[0].change_summary, '更新项目设计规范');

    const after = (await call('GET', `/api/projects/${pid}/screens`)).data[0];
    assert.equal(after.current_version, beforeVersion, 'FR-THEME-008：主题变更不递增屏幕版本');
  });
});

test('UI 状态与测量缓存：可持久化，且测量不产生版本', async () => {
  await withServer('uistate', async ({ call }) => {
    const pid = (await call('POST', '/api/projects/import', clone(fixture))).data.project_id;
    const sid = (await call('GET', `/api/projects/${pid}/screens`)).data[0].screen_id;
    const put = await call('PUT', `/api/projects/${pid}/ui-state`, { panelWidths: { left: 260 }, favorites: ['card'] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.data.favorites, ['card']);

    const before = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data.current_version;
    const m = await call('POST', `/api/projects/${pid}/screens/${sid}/measurements`, { items: { itm_card_today: 320 } });
    assert.equal(m.status, 200, JSON.stringify(m.raw));
    const after = (await call('GET', `/api/projects/${pid}/screens/${sid}`)).data.current_version;
    assert.equal(after, before, 'DC-033：测量缓存不产生版本');
  });
});
