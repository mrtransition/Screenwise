import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  renderScreenBody,
  renderScreenDocument,
  docFormat,
  SCREEN_BASE_CSS,
  LEGACY_BASE_CSS,
  themeCss,
} from '../../../web/src/screen-render.js';

/**
 * 导出可点击原型（FR-EXPORT-001 / AC-010 / FR-RENDER-001）
 *
 * 屏幕内容由共享渲染契约生成：M3 ScreenDoc 与旧 node-tree 各走自己的渲染器，
 * 与编辑器缩略图、应用内预览结构一致。产物为纯静态，双击 index.html 即可运行。
 */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export { renderScreenDocument };

const BASE_CSS = `
${SCREEN_BASE_CSS}
${LEGACY_BASE_CSS}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827;background:#f7f8fa}
html,body{margin:0;height:100%;overflow:hidden}
[data-anchor]{cursor:pointer}
button{font:inherit}
#stage{position:relative;height:100%;display:flex;align-items:center;justify-content:center}
.screen{position:absolute;inset:0;display:none;background:#fff;overflow:auto}
.screen.active{display:block}
/* 根节点的 flex 布局需要父级有确定高度才能撑满：若父级只有 min-height，
   根节点上的 height:100% 会退化成 auto，margin-top:auto 的底部栏就掉到内容末尾
   （表现为底部按钮跑到页面中间）。这里用 flex:1 0 auto 把高度撑满，
   同时内容超高时仍能自然撑开，由外层 .screen 滚动。 */
.screen-inner{min-height:100%;position:relative;display:flex;flex-direction:column}
.screen-inner > *{flex:1 0 auto}
.screen-inner .m3-screen{flex:1 0 auto;margin:0 auto}
.flash{animation:flash .35s ease}
@keyframes flash{from{opacity:.55}to{opacity:1}}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(17,24,39,.9);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
#toast.show{opacity:1}
#backbar{position:fixed;top:8px;left:8px;z-index:50;display:none}
#backbar button{border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.08)}
`;

function renderScreen(s, design) {
  return `<div class="screen" id="scr-${escapeHtml(s.screen_id)}"><div class="screen-inner">${renderScreenBody(s.doc, design, { includeHidden: false })}</div></div>`;
}

function runtime(device) {
  return `
<script>
(function(){
  var DATA = window.__PROTO__;
  var edges = DATA.edges.filter(function(e){return (e.status||'confirmed')!=='candidate';});
  var stack = [];
  var current = null;
  function show(id, push){
    var el = document.getElementById('scr-'+id);
    if(!el) return;
    document.querySelectorAll('.screen').forEach(function(s){s.classList.remove('active');});
    el.classList.add('active');
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    el.scrollTop = 0;
    if(push && current) stack.push(current);
    current = id;
    document.getElementById('backbar').style.display = stack.length ? 'block' : 'none';
    if (window.parent !== window) window.parent.postMessage({type:'proto:navigate', screen_id:id}, '*');
  }
  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 1600);
  }
  function target(hotspot){
    for(var i=0;i<edges.length;i++){
      var e = edges[i];
      if(e.source_screen_id===current && e.source_hotspot_id===hotspot) return e;
    }
    return null;
  }
  document.addEventListener('click', function(ev){
    var el = ev.target.closest('[data-anchor]');
    if(!el) return;
    ev.preventDefault(); ev.stopPropagation();
    var hs = el.getAttribute('data-anchor');
    var e = target(hs);
    if(!e){ toast('该热区（'+hs+'）尚未配置关联'); return; }
    if(e.target_kind==='back'){ if(stack.length){ var prev=stack.pop(); show(prev,false); } return; }
    if(e.target_kind==='link'){ if(e.url) window.open(e.url,'_blank','noopener'); return; }
    if(e.target_screen_id) show(e.target_screen_id, true);
  });
  document.getElementById('btn-back').addEventListener('click', function(){
    if(stack.length){ var prev = stack.pop(); current = null; show(prev, false); }
  });
  window.__protoShow = show;
  show(DATA.start, false);
  window.addEventListener('load', function(){ if(!current) show(DATA.start,false); });
})();
</script>`;
}

export async function exportStatic(payload, dir) {
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  const { project, start, screens, edges } = payload;
  const design = project.design || {};

  // 数据文件：屏幕与关联分开存，可追溯（FR-EXPORT-002）
  await fs.writeFile(path.join(dir, 'data', 'screens.json'), JSON.stringify(screens, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'data', 'flow.json'), JSON.stringify({ schema_version: 2, edges }, null, 2), 'utf8');
  await fs.writeFile(
    path.join(dir, 'data', 'project.json'),
    JSON.stringify(
      {
        ...project,
        start_screen_id: start,
        exported_at: new Date().toISOString(),
        render_contract: 'm3studio/render@1',
        formats: Object.fromEntries(screens.map((s) => [s.screen_id, docFormat(s.doc)])),
      },
      null,
      2
    ),
    'utf8'
  );

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(project.name)} · 可点击原型</title>
<style>${BASE_CSS}
:root{${themeCss(design)}}
body{background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
#device{position:relative;width:${project.device.width}px;height:${project.device.height}px;background:var(--md-surface,#fff);overflow:hidden;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
</style>
</head>
<body>
<div id="backbar"><button id="btn-back">‹ 返回</button></div>
<div id="device">
${screens.map((s) => renderScreen(s, design)).join('\n')}
</div>
<div id="toast"></div>
<script>window.__PROTO__ = ${JSON.stringify({ start, edges, project }).replace(/</g, '\\u003c')};</script>
${runtime(project.device)}
</body>
</html>`;

  await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
  return { file: path.join(dir, 'index.html'), bytes: Buffer.byteLength(html, 'utf8') };
}

export { styleToCss } from '../../../web/src/screen-render.js';
export const __internal = { renderScreen };
