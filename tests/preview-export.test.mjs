import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { freshServer, client, listen, seedProject } from './helpers.mjs';

/**
 * 预览与导出（FR-PREVIEW-001/002、FR-EXPORT-001/002、AC-009/010）
 * 以及自然语言建边（FR-FLOW-002）
 */

let ctx;
before(async () => {
  ctx = freshServer();
  await listen(ctx.server);
  ctx.call = client(ctx.server);
  ctx.seed = await seedProject(ctx.call);
  const { pk, login, list, detail } = ctx.seed;
  // 登录 → 列表 → 详情
  const e1 = await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: login.screen_id,
    source_hotspot_id: 'login_submit',
    target_screen_id: list.screen_id,
  });
  assert.equal(e1.status, 200, JSON.stringify(e1.raw));
  const e2 = await ctx.call('POST', `${pk}/flow/edges`, {
    source_screen_id: list.screen_id,
    source_hotspot_id: 'open_detail',
    target_screen_id: detail.screen_id,
  });
  assert.equal(e2.status, 200, JSON.stringify(e2.raw));
  ctx.edges = [e1.data, e2.data];
});
after(() => ctx.server.close());

test('FR-PREVIEW-001 / AC-009：预览数据按 FlowEdge 正确路由', async () => {
  const { pk, login, list, detail } = ctx.seed;
  const res = await ctx.call('GET', `${pk}/preview?start=${login.screen_id}`);
  assert.equal(res.status, 200);
  const d = res.data;
  assert.equal(d.start, login.screen_id);
  assert.equal(d.screens.length, 3);
  const e1 = d.edges.find((e) => e.source_screen_id === login.screen_id);
  assert.equal(e1.source_hotspot_id, 'login_submit');
  assert.equal(e1.target_screen_id, list.screen_id);
  const e2 = d.edges.find((e) => e.source_screen_id === list.screen_id);
  assert.equal(e2.target_screen_id, detail.screen_id);
  // 预览只读：不该附带 pending 等可写字段
  assert.ok(!('pending' in d.screens[0]));
});

test('FR-PREVIEW-005：热区缺失的边被标记为 orphan，而不是丢弃', async () => {
  const { pk, login, detail } = ctx.seed;
  const before = (await ctx.call('GET', `${pk}/flow`)).data.edges.length;
  // 改登录屏内容但不保留 login_submit（用 removeNode 删掉按钮）
  const full = (await ctx.call('GET', `${pk}/screens/${login.screen_id}`)).data;
  let btnId = null;
  const walk = (n) => {
    if (n.props?.attrs?.['data-anchor'] === 'login_submit') btnId = n.id;
    (n.children || []).forEach(walk);
  };
  walk(full.doc.root);
  assert.ok(btnId);
  // 直接用手动 patch 删掉按钮
  const mp = await ctx.call('POST', `${pk}/screens/${login.screen_id}/manual-patch`, {
    ops: [{ op: 'removeNode', target: { node_id: btnId } }],
  });
  assert.equal(mp.status, 200);

  const flow = (await ctx.call('GET', `${pk}/flow`)).data;
  const edge = flow.edges.find((e) => e.source_screen_id === login.screen_id);
  assert.ok(edge, '边不应被自动删除（连线属于用户资产）');
  assert.equal(edge.orphan.hotspot_missing, true);
  assert.equal(flow.edges.length, before, '边数量不变');
});

test('FR-FLOW-002：自然语言建边只产出候选，需确认后落库', async () => {
  const { pk, detail, login } = ctx.seed;
  // 先补一个热区到详情屏，便于建边
  const prop = await ctx.call('POST', `${pk}/flow/propose`, { text: '在审批详情页点通过按钮跳到登录页' });
  assert.equal(prop.status, 200, JSON.stringify(prop.raw));
  assert.equal(prop.data.status, 'candidate');
  assert.equal(prop.data.source_screen_id, detail.screen_id);
  assert.equal(prop.data.target_screen_id, login.screen_id);

  // 候选未确认前不应出现在 flow 中
  const flow0 = (await ctx.call('GET', `${pk}/flow`)).data;
  assert.ok(!flow0.edges.some((e) => e.edge_id === prop.data.edge_id), '候选边不应自动落库');

  const conf = await ctx.call('POST', `${pk}/flow/confirm`, prop.data);
  assert.equal(conf.status, 200);
  assert.equal(conf.data.status, 'confirmed');
  const flow1 = (await ctx.call('GET', `${pk}/flow`)).data;
  assert.ok(flow1.edges.some((e) => e.edge_id === conf.data.edge_id));
});

test('FR-EXPORT-001 / AC-010：导出为可独立运行的静态包', async () => {
  const { pk, login, list, detail } = ctx.seed;
  const res = await ctx.call('POST', `${pk}/export`, { start: login.screen_id, name: `test-export-${Date.now()}` });
  assert.equal(res.status, 200, JSON.stringify(res.raw));
  const dir = res.data.dir;
  assert.ok(existsSync(path.join(dir, 'index.html')), '应生成 index.html');
  assert.ok(existsSync(path.join(dir, 'data', 'screens.json')));

  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  // 三屏都内联进导出包
  for (const s of [login, list, detail]) assert.ok(html.includes(`scr-${s.screen_id}`), `缺少屏幕 ${s.title}`);
  // 关联数据内联，且与页面数据分离存于 __PROTO__
  assert.ok(html.includes('__PROTO__'));
  assert.ok(html.includes('login_submit'));
  assert.ok(html.includes('open_detail'));
  // 不含任何服务端依赖
  assert.ok(!/fetch\(\s*['"]\/api/.test(html), '导出物不应依赖后端 API');
  assert.ok(!html.includes('__PROTO_FILE__'));

  // data/flow.json 与 screens.json 分开存（FR-EXPORT-002）
  const screensJson = JSON.parse(readFileSync(path.join(dir, 'data', 'screens.json'), 'utf8'));
  const flowJson = JSON.parse(readFileSync(path.join(dir, 'data', 'flow.json'), 'utf8'));
  assert.equal(screensJson.length, 3);
  assert.ok(flowJson.edges.length >= 1);
  assert.ok(!JSON.stringify(flowJson).includes('"children"'), 'flow 中不得内嵌页面内容');
});

test('导出物内联数据不破坏 HTML 结构（转义校验）', async () => {
  const { pk } = ctx.seed;
  // 造一个含 </script> 的屏幕标题，验证不会被直接注入导出 HTML
  const s = (await ctx.call('POST', `${pk}/screens`, { title: 'X</script><script>alert(1)</script>' })).data;
  const res = await ctx.call('POST', `${pk}/export`, { name: `test-escape-${Date.now()}` });
  assert.equal(res.status, 200);
  const html = readFileSync(path.join(res.data.dir, 'index.html'), 'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'), '标题中的脚本必须被转义');
  assert.ok(s.screen_id);
});

test('导出原型：屏幕容器必须撑满设备高度，否则底部操作栏会掉到页面中间', async () => {
  const { pk, login } = ctx.seed;
  const res = await ctx.call('POST', `${pk}/export`, { start: login.screen_id, name: `test-layout-${Date.now()}` });
  assert.equal(res.status, 200);
  const html = readFileSync(path.join(res.data.dir, 'index.html'), 'utf8');

  // .screen-inner 是页面根节点的父级：它必须能用 flex 把高度撑满，
  // 只有 min-height 时，根节点上的 height:100% 会退化为 auto，margin-top:auto 的底部栏随之失效。
  const innerRule = (html.match(/\.screen-inner\{[^}]*\}/) || [''])[0];
  assert.ok(innerRule.includes('display:flex'), '.screen-inner 必须是 flex 容器');
  assert.ok(/flex-direction:column/.test(innerRule), '.screen-inner 必须是竖向 flex');
  assert.ok(!/height:100%/.test(innerRule.replace(/min-height:100%/g, '')), '不能用固定 height:100%，否则长内容无法滚动');
  const childRule = (html.match(/\.screen-inner > \*\{[^}]*\}/) || [''])[0];
  assert.ok(/flex:1 0 auto/.test(childRule), '子级必须 flex:1 0 auto：撑满高度，同时允许内容撑开');
});
