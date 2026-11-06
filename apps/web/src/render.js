import {
  esc,
  styleToCss,
  legacyNodeToHtml,
  renderM3Body,
  docFormat,
  SCREEN_BASE_CSS,
  LEGACY_BASE_CSS,
  themeCss,
  anchorOf,
} from './screen-render.js';

/**
 * 节点树 → HTML 渲染器（前端版）
 * 旧 node-tree 走 screen-render 的只读安全渲染；M3 ScreenDoc 走共享 M3 渲染器。
 * 两者与服务端导出使用同一份实现（FR-RENDER-001）。
 */
export { esc, styleToCss, anchorOf };

/** 兼容旧调用：只渲染 node-tree 节点 */
export function nodeToHtml(n, { editable = false } = {}) {
  return legacyNodeToHtml(n, { editable });
}


/**
 * 交互模式：点击热区 → 高亮/派发；
 * 选择模式：点击节点 → 回传 node_id；
 * 空间编辑模式（editable）：双击文字叶子节点就地编辑，失焦 / Enter 提交一次，Esc 放弃。
 */
export function docToSrcdoc(
  doc,
  {
    interactive = false,
    hotspots = false,
    measure = false,
    selectable = false,
    editable = false,
    selectedNodeIds = [],
    highlightMap = {},
    screenId = '',
    design = null,
  } = {}
) {
  const fmt = docFormat(doc);
  const isM3 = fmt === 'm3';
  const BASE = isM3 ? `${SCREEN_BASE_CSS}\n:root{${themeCss(design || {})}}` : LEGACY_BASE_CSS;
  const extra = `
${hotspots ? '[data-anchor]{outline:2px dashed rgba(37,99,235,.55);outline-offset:2px;border-radius:6px}' : ''}
${selectable ? '[data-node-id],[data-item-id]{cursor:crosshair}[data-node-id]:hover,[data-item-id]:hover{outline:1px dashed rgba(37,99,235,.45);outline-offset:2px}' : ''}
${editable ? '[data-editable]{cursor:text;border-radius:4px}[data-editable]:hover{outline:1px dashed rgba(37,99,235,.55);outline-offset:2px}[contenteditable="true"]{outline:2px solid #2563eb !important;outline-offset:2px;background:rgba(37,99,235,.06);cursor:text;user-select:text}' : ''}
${highlightCss(selectedNodeIds, highlightMap)}
${interactive || selectable || editable ? '' : 'body{pointer-events:none}'}
${editable ? 'body{user-select:none}' : ''}
`;
  // 热区坐标用"完全不受画布缩放影响"的方式测量：
  // iframe 里的 getBoundingClientRect 会带上父页面 transform:scale 的结果，
  // 若再按 zoom 做除法，浏览器取整/边框/滚动差的零头会被放大成几十上百像素（关联模式热区漂移的根因）。
  // clientLeft/clientTop/clientWidth 是布局像素，一开始就与缩放无关。
  const measureScript = measure
    ? `<script>
(function(){
  function report(){
    var de=document.documentElement, body=document.body;
    var sx=de.clientLeft||0, sy=de.clientTop||0;
    var cx=de.clientLeft+(body?body.clientLeft:0), cy=de.clientTop+(body?body.clientTop:0);
    var out=[];
    document.querySelectorAll('[data-anchor]').forEach(function(el){
      var x=0, y=0, w=0, h=0, n=el;
      while(n && n.nodeType===1){
        x+=n.offsetLeft+n.clientLeft; y+=n.offsetTop+n.clientTop;
        if(n===body||n===de) break;
        n=n.offsetParent;
      }
      w=el.offsetWidth||0; h=el.offsetHeight||0;
      if(!w || !h){ // display:contents 等无盒元素退回 rect，但同样不做缩放补偿
        var r=el.getBoundingClientRect();
        out.push({hotspot_id:el.getAttribute('data-anchor'), x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height, rect:true});
        return;
      }
      // 累加得到的是相对 body 的布局坐标；减去 iframe 文档自身滚动后的可视原点
      out.push({hotspot_id:el.getAttribute('data-anchor'), x:x-cx+w/2, y:y-cy+h/2, w:w, h:h});
    });
    window.parent.postMessage({type:'proto:anchors', screen_id: ${JSON.stringify(String(screenId || ''))}, anchors: out}, '*');
  }
  function remeasure(){ requestAnimationFrame(function(){ requestAnimationFrame(report); }); }
  window.addEventListener('message', function(ev){
    if(ev.data && ev.data.type==='proto:remeasure') remeasure();
  });
  // 等布局与字体就绪再测，避免首帧尺寸为 0
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(report).catch(report); } else { setTimeout(report, 30); }
  window.addEventListener('load', remeasure);
  // 图片 / 异步内容撑开布局后尺寸会变，观察 DOM 尺寸变化再补测
  if(window.ResizeObserver){
    var ro = new ResizeObserver(function(){ remeasure(); });
    ro.observe(document.documentElement);
    if(document.body) ro.observe(document.body);
  }
})();
</script>`
    : '';
  // 选择 / 编辑的点击目标：旧 node-tree 是 data-node-id，M3 ScreenDoc 是 data-item-id（含 slot 的 data-anchor）。
  // 之前只认 data-node-id，M3 屏幕上所有组件都点不中，区域 / 组件范围永远拿不到选区。
  const hostAttrs = 'data-node-id, data-item-id, [data-anchor]';
  // 选择器必须嵌成 JS 字符串字面量（JSON.stringify 会给整串加双引号，closest() 会抛 SyntaxError 并吞掉点击）
  const hostAttrSel = `'${hostAttrs.replace(/'/g, "\\'")}'`;
  const idScript = `function protoId(el){
    if (!el) return null;
    var id = el.getAttribute('data-node-id') || el.getAttribute('data-item-id');
    if (id) return id;
    var a = el.getAttribute('data-anchor');
    if (!a) return null;
    var i = a.indexOf('::');
    return i < 0 ? a : a.slice(0, i);
  }`;
  const selectScript = selectable
    ? `<script>
${idScript}
document.addEventListener('click', function(ev){
  var el = ev.target.closest ? ev.target.closest(${hostAttrSel}) : null;
  var id = protoId(el);
  if(!id) return;
  ev.preventDefault(); ev.stopPropagation();
  window.parent.postMessage({type:'proto:select', node_id: id, screen_id: ${JSON.stringify(String(screenId || ''))}}, '*');
}, true);
</script>`
    : '';
  // 空间编辑（FR-SPACE-001/003/005）：一次编辑会话只提交一次，逐键不落库。
  const editScript = editable
    ? `<script>
(function(){
  var SID = ${JSON.stringify(String(screenId || ''))};
  ${idScript}
  var editing = null;
  var original = '';
  var editingId = null;
  function post(type, extra){
    var msg = { type: type, screen_id: SID };
    for (var k in (extra || {})) msg[k] = extra[k];
    window.parent.postMessage(msg, '*');
  }
  function normalize(text){
    return String(text || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function stopEditing(){
    if (!editing) return null;
    var el = editing;
    editing = null;
    el.removeAttribute('contenteditable');
    el.classList.remove('proto-editing');
    return el;
  }
  function commit(save){
    if (!editing) return;
    var el = editing;
    var text = normalize(el.textContent);
    stopEditing();
    if (!save || text === original) { el.textContent = original; return; }
    if (!text) {
      el.textContent = original;
      post('proto:edit-cancel', { node_id: editingId, reason: 'empty' });
      return;
    }
    el.textContent = text;
    // 只有值真正变化才提交；提交按钮 / 失焦 / Enter 共用这一次
    post('proto:edit', { node_id: editingId, text: text, original: original });
  }
  document.addEventListener('dblclick', function(ev){
    var el = ev.target.closest ? ev.target.closest('[data-editable]') : null;
    if (!el) return;
    ev.preventDefault(); ev.stopPropagation();
    if (editing === el) return;
    if (editing) commit(true);
    editing = el;
    editingId = protoId(el);
    original = normalize(el.textContent);
    el.setAttribute('contenteditable', 'true');
    el.classList.add('proto-editing');
    el.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* 选择失败不影响编辑 */ }
  }, true);
  document.addEventListener('keydown', function(ev){
    if (!editing) return;
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      var el = stopEditing();
      if (el) el.textContent = original;
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault(); ev.stopPropagation();
      commit(true);
    }
  }, true);
  document.addEventListener('blur', function(ev){
    if (editing && ev.target === editing) commit(true);
  }, true);
  document.addEventListener('click', function(ev){
    if (editing) return;
    var el = ev.target.closest ? ev.target.closest(${hostAttrSel}) : null;
    var id = protoId(el);
    ev.preventDefault(); ev.stopPropagation();
    if (id) post('proto:node-focus', { node_id: id });
  }, true);
})();
</script>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE}${extra}</style></head><body>${
    isM3
      ? renderM3Body(doc, design || {}, {})
      : doc?.root
        ? nodeToHtml(doc.root, { editable })
        : '<div style="padding:24px;color:#9ca3af">（空屏）</div>'
  }${measureScript}${selectScript}${editScript}</body></html>`;
}

/** 选中 / 差异高亮的 CSS。id 来自 AI，必须做 CSS 字符串转义，避免破坏样式表。 */
function highlightCss(selectedNodeIds = [], highlightMap = {}) {
  const rules = [];
  for (const id of selectedNodeIds || []) {
    rules.push(`[data-node-id="${cssString(id)}"]{outline:2px solid #2563eb;outline-offset:2px;border-radius:4px}`);
  }
  for (const [id, color] of Object.entries(highlightMap || {})) {
    rules.push(`[data-node-id="${cssString(id)}"]{outline:2px dashed ${color};outline-offset:2px;border-radius:4px}`);
  }
  return rules.join('\n');
}

function cssString(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // 换行/回车会终止 CSS 字符串，必须转成十六进制转义
    .replace(/[\n\r\f]/g, '\\a ');
}
