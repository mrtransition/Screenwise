import { node, makeId, findNode, walk, textOf } from '../domain/doc.js';
import { extractInstruction } from './rules.js';

/**
 * 本地确定性生成器（provider: "local"）
 *
 * 用途：在没有模型网关凭据的情况下，让整条链路（生成→预览→接受→版本→连线→预览→导出）
 * 真实可跑、可自动化测试。它遵守与真实模型完全相同的输出契约（JSON patch / 整屏 doc），
 * 因此替换 provider 时上层代码零改动（NFR-011）。
 *
 * 它不是"假 UI"：输出的节点树会被真实渲染、真实 patch、真实版本化。
 */

const DEFAULT_THEME = {
  navy: '#1b2a4a',
  accent: '#2563eb',
  text: '#111827',
  sub: '#6b7280',
  card: '#ffffff',
  line: '#e5e7eb',
  danger: '#dc2626',
  bg: '#f7f8fa',
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 14,
  fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontBase: 14,
};

/**
 * 生成器当前使用的主题。buildScreenDoc / buildPatch 是同步函数，
 * 在单次调用内临时切换，调用结束即恢复，不会串到别的项目。
 */
let C = DEFAULT_THEME;

function themeOf(tokens = {}) {
  const colors = tokens.colors || {};
  const radius = tokens.radius || {};
  const font = tokens.font || {};
  return {
    ...DEFAULT_THEME,
    navy: colors.primary || DEFAULT_THEME.navy,
    accent: colors.primary || DEFAULT_THEME.accent,
    text: colors.text || DEFAULT_THEME.text,
    sub: colors.sub || DEFAULT_THEME.sub,
    card: colors.card || DEFAULT_THEME.card,
    line: colors.border || DEFAULT_THEME.line,
    bg: colors.bg || DEFAULT_THEME.bg,
    radiusSm: numeric(radius.sm, DEFAULT_THEME.radiusSm),
    radiusMd: numeric(radius.md, DEFAULT_THEME.radiusMd),
    radiusLg: numeric(radius.lg, DEFAULT_THEME.radiusLg),
    fontFamily: font.family || DEFAULT_THEME.fontFamily,
    fontBase: numeric(font.base, DEFAULT_THEME.fontBase),
  };
}

function numeric(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withTheme(tokens, fn) {
  const prev = C;
  C = themeOf(tokens);
  try {
    return fn();
  } finally {
    C = prev;
  }
}

function row(id, children, style = {}) {
  return { id, type: 'row', tag: 'div', props: { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', ...style }, attrs: {} }, children };
}

function block(id, children, style = {}, attrs = {}) {
  return { id, type: 'block', tag: 'div', props: { style: { display: 'flex', flexDirection: 'column', ...style }, attrs }, children };
}

function text(id, content, style = {}) {
  return { id, type: 'text', tag: 'span', props: { style: { fontSize: 14, color: C.text, ...style }, attrs: {}, text: content }, children: [] };
}

function button(id, label, anchor, style = {}) {
  return {
    id,
    type: 'button',
    tag: 'button',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 48,
        borderRadius: 10,
        background: C.accent,
        color: '#ffffff',
        fontSize: 16,
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
        ...style,
      },
      attrs: anchor ? { 'data-anchor': anchor, 'data-role': 'button' } : { 'data-role': 'button' },
      text: label,
    },
    children: [],
  };
}

function field(id, label, placeholder) {
  return block(id, [
    text(`${id}_label`, label, { fontSize: 13, color: C.sub, marginBottom: 6 }),
    { id: `${id}_input`, type: 'input', tag: 'div', props: { style: { height: 46, borderRadius: 10, border: `1px solid ${C.line}`, background: '#fff', display: 'flex', alignItems: 'center', paddingLeft: 14, color: '#9ca3af' }, attrs: { 'data-role': 'input' }, text: placeholder }, children: [] },
  ], { gap: 0, marginBottom: 16 });
}

const TEMPLATES = {
  login(pid, tokens) {
    const p = prefix('login');
    return block(p.root, [
      block(`${p.root}_hero`, [
        text(`${p.root}_title`, '欢迎回来', { fontSize: 28, fontWeight: 700, color: C.navy, marginTop: 72 }),
        text(`${p.root}_sub`, '登录后继续你的工作', { fontSize: 14, color: C.sub, marginTop: 8 }),
      ], { padding: '0 24px', gap: 0 }),
      block(`${p.root}_form`, [
        field(`${p.root}_f_phone`, '手机号', '请输入手机号'),
        field(`${p.root}_f_code`, '验证码', '6 位验证码'),
        button(`${p.root}_btn_login`, '登录', 'login_submit', { marginTop: 8 }),
        text(`${p.root}_btn_forgot`, '忘记密码？', { fontSize: 13, color: C.accent, marginTop: 16, textAlign: 'center' }),
      ], { padding: '32px 24px', gap: 0 }),
      block(`${p.root}_foot`, [
        text(`${p.root}_signup`, '还没有账号？立即注册', { fontSize: 13, color: C.sub }),
      ], { marginTop: 'auto', padding: '0 24px 32px', textAlign: 'center' }),
    ], { padding: 0, gap: 0, background: '#ffffff', height: '100%' });
  },

  list(pid, tokens) {
    const p = prefix('list');
    const items = [
      { title: '报销单 · 差旅', meta: '待审批 · 金额 ¥2,380', state: '待审批', color: '#f59e0b' },
      { title: '报销单 · 招待', meta: '已通过 · 金额 ¥860', state: '已通过', color: '#16a34a' },
      { title: '报销单 · 采购', meta: '已驳回 · 金额 ¥4,100', state: '已驳回', color: C.danger },
      { title: '报销单 · 打车', meta: '待审批 · 金额 ¥132', state: '待审批', color: '#f59e0b' },
    ];
    return block(p.root, [
      block(`${p.root}_hd`, [
        row(`${p.root}_hd_row`, [
          text(`${p.root}_hd_title`, '我的审批', { fontSize: 22, fontWeight: 700, color: C.navy }),
          text(`${p.root}_hd_filter`, '筛选', { fontSize: 13, color: C.accent, marginLeft: 'auto' }),
        ], { height: 56 }),
        { id: `${p.root}_search`, type: 'input', tag: 'div', props: { style: { height: 40, borderRadius: 10, background: '#f1f3f6', display: 'flex', alignItems: 'center', paddingLeft: 14, color: '#9ca3af', fontSize: 14 }, attrs: { 'data-role': 'input' }, text: '搜索单号 / 申请人' }, children: [] },
      ], { padding: '0 16px', gap: 12 }),
      block(`${p.root}_list`, items.map((it, i) =>
        block(`${p.root}_item_${i}`, [
          row(`${p.root}_item_${i}_row`, [
            block(`${p.root}_item_${i}_l`, [
              text(`${p.root}_item_${i}_t`, it.title, { fontSize: 15, fontWeight: 600 }),
              text(`${p.root}_item_${i}_m`, it.meta, { fontSize: 12, color: C.sub, marginTop: 4 }),
            ], { gap: 0 }),
            text(`${p.root}_item_${i}_s`, it.state, { fontSize: 12, color: it.color, marginLeft: 'auto', fontWeight: 600 }),
          ], { width: '100%' }),
        ], {
          background: C.card,
          borderRadius: 12,
          padding: 14,
          marginBottom: 10,
          gap: 0,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }, { 'data-anchor': i === 0 ? 'open_detail' : '', 'data-block': `item-${i}`, 'data-role': 'list-item' })
      ), { padding: '0 16px', gap: 0, overflowY: 'auto' }),
    ], { padding: 0, gap: 0, background: '#f7f8fa', height: '100%' });
  },

  detail(pid, tokens) {
    const p = prefix('detail');
    return block(p.root, [
      row(`${p.root}_nav`, [
        text(`${p.root}_back`, '‹ 返回', { fontSize: 15, color: C.accent }),
        text(`${p.root}_nav_title`, '审批详情', { fontSize: 16, fontWeight: 600, marginLeft: 12 }),
      ], { height: 52, padding: '0 16px', borderBottom: `1px solid ${C.line}`, background: '#fff' }),
      block(`${p.root}_body`, [
        block(`${p.root}_card`, [
          text(`${p.root}_amount`, '¥ 2,380.00', { fontSize: 28, fontWeight: 700, color: C.navy }),
          text(`${p.root}_status`, '待审批', { fontSize: 13, color: '#f59e0b', marginTop: 6, fontWeight: 600 }),
          block(`${p.root}_kv`, [
            kv(`${p.root}_kv1`, '申请人', '张伟'),
            kv(`${p.root}_kv2`, '单号', 'BX20261102001'),
            kv(`${p.root}_kv3`, '事由', '上海出差 3 天'),
          ], { marginTop: 18, gap: 12 }),
        ], { background: '#fff', borderRadius: 12, padding: 18, gap: 0 }),
        block(`${p.root}_timeline`, [
          text(`${p.root}_tl_title`, '审批流程', { fontSize: 15, fontWeight: 600, marginBottom: 12 }),
          ...['提交申请 · 张伟', '直属主管审批 · 李娜（进行中）', '财务复核 · 待处理'].map((t, i) =>
            row(`${p.root}_tl_${i}`, [
              { id: `${p.root}_tl_${i}_dot`, type: 'icon', tag: 'div', props: { style: { width: 8, height: 8, borderRadius: 4, background: i === 1 ? C.accent : C.line, marginTop: 5 }, attrs: {} }, children: [] },
              text(`${p.root}_tl_${i}_t`, t, { fontSize: 13, color: i === 1 ? C.text : C.sub, marginLeft: 10 }),
            ], { marginBottom: 12 })
          ),
        ], { background: '#fff', borderRadius: 12, padding: 18, marginTop: 12, gap: 0 }),
      ], { padding: 16, gap: 0, overflowY: 'auto' }),
      block(`${p.root}_foot`, [
        button(`${p.root}_btn_reject`, '驳回', 'reject', { background: '#fff', color: C.danger, border: `1px solid ${C.line}`, flex: 1 }),
        button(`${p.root}_btn_approve`, '通过', 'approve', { flex: 2, marginLeft: 10 }),
      ], { marginTop: 'auto', padding: '12px 16px 24px', background: '#fff', borderTop: `1px solid ${C.line}` }),
    ], { padding: 0, gap: 0, background: '#f7f8fa', height: '100%' });
  },

  success(pid, tokens) {
    const p = prefix('done');
    return block(p.root, [
      block(`${p.root}_box`, [
        { id: `${p.root}_icon`, type: 'icon', tag: 'div', props: { style: { width: 64, height: 64, borderRadius: 32, background: '#dcfce7', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }, attrs: {}, text: '✓' }, children: [] },
        text(`${p.root}_title`, '审批已提交', { fontSize: 22, fontWeight: 700, marginTop: 20 }),
        text(`${p.root}_sub`, '你的审批结果已通知申请人', { fontSize: 13, color: C.sub, marginTop: 8 }),
        button(`${p.root}_btn_back`, '返回列表', 'back_to_list', { marginTop: 28, width: '100%' }),
      ], { padding: '120px 24px 0', gap: 0, alignItems: 'center', textAlign: 'center' }),
    ], { padding: 0, gap: 0, background: '#fff', height: '100%' });
  },

  home(pid, tokens) {
    const p = prefix('home');
    return block(p.root, [
      block(`${p.root}_hd`, [
        text(`${p.root}_hi`, '早上好，张伟', { fontSize: 24, fontWeight: 700, color: C.navy, marginTop: 24 }),
        text(`${p.root}_date`, '11 月 2 日 · 星期一', { fontSize: 13, color: C.sub, marginTop: 6 }),
      ], { padding: '0 20px', gap: 0 }),
      block(`${p.root}_grid`, [
        row(`${p.root}_g1`, [
          tile(`${p.root}_t1`, '待我审批', '8', 'open_list'),
          tile(`${p.root}_t2`, '我发起的', '3', 'my_list'),
        ], { gap: 12 }),
        row(`${p.root}_g2`, [
          tile(`${p.root}_t3`, '报销', '12', null),
          tile(`${p.root}_t4`, '请假', '2', null),
        ], { gap: 12, marginTop: 12 }),
      ], { padding: '20px' }),
      block(`${p.root}_todo`, [
        text(`${p.root}_todo_t`, '最近动态', { fontSize: 15, fontWeight: 600, marginBottom: 10 }),
        ...[0, 1, 2].map((i) =>
          row(`${p.root}_dyn_${i}`, [
            text(`${p.root}_dyn_${i}_a`, ['李娜 通过了你的报销单', '王强 提交了新的请假申请', '系统 提醒你完成月度审核'][i], { fontSize: 13, color: C.sub }),
          ], { padding: '10px 0', borderBottom: `1px solid ${C.line}` })
        ),
      ], { background: '#fff', margin: '0 16px', borderRadius: 12, padding: 16 }),
    ], { padding: 0, gap: 0, background: '#f7f8fa', height: '100%' });
  },
};

function prefix(p) {
  return { root: `blk_${p}` };
}

function kv(id, k, v) {
  return row(id, [
    text(`${id}_k`, k, { fontSize: 13, color: C.sub, width: 64 }),
    text(`${id}_v`, v, { fontSize: 13, color: C.text }),
  ]);
}

function tile(id, label, count, anchor) {
  return block(id, [
    text(`${id}_n`, count, { fontSize: 26, fontWeight: 700, color: C.navy }),
    text(`${id}_l`, label, { fontSize: 13, color: C.sub, marginTop: 4 }),
  ], { background: '#fff', borderRadius: 12, padding: 16, flex: 1, gap: 0 }, anchor ? { 'data-anchor': anchor, 'data-role': 'tile' } : { 'data-role': 'tile' });
}

function detectTemplate(instruction, screen) {
  // 明确指令优先于标题，标题优先于兜底
  const main = stripInstruction(instruction);
  const title = String(screen.title || '');
  for (const src of [main, title]) {
    if (!src) continue;
    if (/登录|登陆|login/i.test(src)) return 'login';
    if (/详情|detail/i.test(src)) return 'detail';
    if (/成功|完成|提交后|success|done/i.test(src)) return 'success';
    if (/列表|清单|审批单|list/i.test(src)) return 'list';
    if (/首页|主页|home|工作台|dashboard/i.test(src)) return 'home';
  }
  return 'home';
}

/**
 * 从完整 prompt 中剥离元信息，只留用户自然语言指令。
 * 关键：prompt 里包含 "# 输出格式" 之类的模板标题，直接做关键词匹配会误判。
 * 实现已收敛到 ai/rules.js（路由与生成器共用同一口径）。
 */
function stripInstruction(instruction) {
  return extractInstruction(instruction);
}

/**
 * 显式结构化指令 → patch（FR-ROUTE-001 / DC-008）。
 * 目标由 node_id 或 data-anchor 唯一指定，新值来自 text_replace → tone_adjust 规则，
 * 不依赖列举屏内文案，因此即使原文与用户描述不一致也能精确落到目标节点。
 *
 * 返回值与 buildPatch 保持同一契约，调用方零改动。
 */
export function buildExplicitPatch({ instruction, currentDoc, editScope, selection, tokens, target }) {
  return withTheme(tokens, () => {
    const text = extractInstruction(instruction);
    const root = currentDoc?.root;
    const ops = [];
    let hit = null;
    if (root && target?.node_id) hit = findNode(root, target.node_id) || null;
    if (root && !hit && target?.anchor) {
      const norm = normalizeAnchor(target.anchor);
      let exact = null;
      walk(root, (n) => {
        const a = n.props?.attrs?.['data-anchor'];
        if (!a) return;
        if (a === target.anchor) exact = n;
        else if (!exact && normalizeAnchor(a) === norm) hit = hit || n;
      });
      hit = exact || hit;
    }

    if (hit) {
      const picked = pickValue(text);
      if (picked) {
        const patch = { text: picked.value };
        if (target?.style && typeof target.style === 'object') patch.style = target.style;
        if (target?.attrs && typeof target.attrs === 'object') patch.attrs = target.attrs;
        ops.push({ op: 'updateProps', target: { node_id: hit.id }, value: patch });
      }
    }

    // 选区收敛：显式 target 不在选区里时，不产生任何 op（避免越界改屏）
    // M3 屏传进来的是 Item 视图：选中的 item 就是作用域根，其自身也属于允许集合。
    if (editScope !== 'screen' && selection?.node_ids?.length) {
      const allowed = new Set();
      for (const id of selection.node_ids) {
        allowed.add(id);
        const n = findNode(root, id);
        if (n) walk(n, (c) => allowed.add(c.id));
      }
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i].target?.node_id && !allowed.has(ops[i].target.node_id)) ops.splice(i, 1);
      }
    }

    return {
      target_screen_id: null,
      edit_scope: editScope,
      mode: ops.length ? 'patch' : 'noop',
      ops,
      note: ops.length ? null : hit ? '结构化指令未给出可用的新值' : '指定的节点不在当前屏',
    };
  });
}

/** 从指令里取出"改成什么"：优先带引号的确定值，其次裸换词 */
function pickValue(text) {
  const patterns = [
    /(?:改|换|替换|设置|设为|写成)(?:成|为)\s*[「"'“]([^「」"'”]{1,40})[」"'”]/,
    /(?:改成|改为|换成|换为)\s*([^，,。；;「」"'”]{1,40})\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1].trim()) {
      const value = m[1].trim();
      if (/^(不要|别|不|非|禁止|勿)/.test(value)) return null;
      return { value };
    }
  }
  return null;
}

/** anchor 归一：大小写、空白、连字符/下划线不敏感，避免 "Login Submit" 与 "login_submit" 对不上 */
function normalizeAnchor(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-]+/g, '_');
}

export function buildScreenDoc({ instruction, screen, project }) {
  return withTheme(project?.design_tokens, () => {
    const tpl = detectTemplate(instruction, screen);
    const root = TEMPLATES[tpl];
    const next = root(screen.screen_id, project?.design_tokens);
    const doc = { version: 1, root: { ...next, id: `${screen.screen_id}_root` } };
    // 让根节点尺寸跟随设备，并让设计规范里的字体真正作用到整屏
    doc.root.props.style.width = '100%';
    doc.root.props.style.height = '100%';
    doc.root.props.style.fontFamily = C.fontFamily;
    doc.root.props.style.fontSize = C.fontBase;
    doc.root.props.style.color = C.text;
    doc.root.props.attrs = { ...(doc.root.props.attrs || {}), 'data-block': 'root' };
    return { doc, template: tpl };
  });
}

/**
 * 生成补丁：分析指令关键词，翻译成节点级 patch。
 * 真实模型直接产出同样的结构；这里用规则保证确定性，便于测试。
 */
export function buildPatch({ instruction, currentDoc, editScope, selection, tokens }) {
  return withTheme(tokens, () => {
  const ops = [];
  const lower = instruction || '';
  const root = currentDoc.root;
  // 区域 / 组件范围：以选区节点为"作用域根"扫描与定位。
  // 之前是"全屏找 → 再按选区过滤"，命中几乎必然在选区外，op 被清空后整体退化成 noop，
  // 用户看到的就是"填了需求描述却不起作用"。改为先收敛作用域，定位天然落在选区内。
  const scopeRoots = resolveScopeRoots(root, editScope, selection);
  const scopeRoot = scopeRoots[0] || root;
  const anchors = [];
  for (const r of scopeRoots) {
    walk(r, (n) => {
      if (n.props?.attrs?.['data-anchor']) anchors.push(n);
    });
  }
  const inScope = (n) => {
    if (!n) return false;
    if (editScope === 'screen') return true;
    return scopeRoots.some((r) => r.id === n.id || descendant(r, n.id));
  };

  // 1) 文案替换：支持 "把 X 改成 Y" / "X 改为 Y" / "标题改成 Y"
  //    先锚定旧文案（唯一确定）；没有旧文案时，按用户点名的对象（标题/副标题/正文）定位。
  //    旧文案只允许引号内或短名词，避免把"不要改标题，只把副标题"整串吞掉。
  const replaceRe = /(?:把|将)?\s*(?:[「"']([^，,。\s「」"']{1,16})[」"']|([^，,。\s「」"']{1,6}))\s*(?:文案|文字|文本)?\s*(?:改|换|替换)(?:成|为)\s*[「"']?([^，,。；;「」"']{1,40})[」"']?/g;
  let m;
  while ((m = replaceRe.exec(lower))) {
    const oldText = (m[1] || m[2] || '').replace(/^(只|仅|并|再|然后|请|帮我|麻烦)/, '');
    const newText = (m[3] || '').trim();
    if (!oldText || !newText) continue;
    if (/^(不要|别|无需|不用|禁止)/.test(newText)) continue;
    let hit = null;
    for (const r of scopeRoots) {
      walk(r, (n) => {
        if (!hit && n.tag !== 'button' && n.props?.text && String(n.props.text).includes(oldText)) hit = n;
      });
    }
    // 旧文案不在屏内：说明 X 是"对哪块的称呼"（标题 / 副标题 / 正文），按称呼在工作域内定位
    if (!hit && isRoleWord(oldText)) hit = findTextTarget(scopeRoot, oldText);
    if (!hit && oldText.length >= 2) {
      for (const r of scopeRoots) {
        walk(r, (n) => {
          if (!hit && n.props?.text && String(n.props.text).includes(oldText.slice(0, 2))) hit = n;
        });
      }
    }
    if (hit) ops.push({ op: 'updateProps', target: { node_id: hit.id }, value: { text: newText } });
  }

  // 1.b) 换词式文案（"把副标题改为 X"/"改成 X"）：没有旧文案时按对象称呼定位，
  //      这是最常见的"确定性文案修改"，必须能落到具体节点，否则会退化成 noop。
  //      "不要改标题，只把副标题改为 X"：被否定的对象（标题）不参与定位。
  if (!ops.length) {
    const tone = /(?:改成|改为|换成|换为)\s*[「"']?([^，,。；;「」"']{1,40})[」"']?\s*$/.exec(lower);
    if (tone) {
      const newText = tone[1].trim();
      const head = lower.slice(0, tone.index);
      const protectedWords = [...head.matchAll(/(?:不要|别|无需|不用|禁止)\s*(?:改|动|变|调整|修改)?\s*([^\s，,。；;、]{1,6})/g)]
        .map((x) => x[1])
        .filter(Boolean);
      if (!/(不要|别|无需|不用|禁止)/.test(newText)) {
        const t = pickTarget(scopeRoot, head, protectedWords);
        if (t) ops.push({ op: 'updateProps', target: { node_id: t.id }, value: { text: newText } });
      }
    }
  }

  // 2) 按钮文案：'按钮改为 X' / '登录按钮改成 X'
  const btnRe = /(?:按钮|button)\s*(?:文案)?\s*(?:改|换)(?:成|为)\s*[「"']?([^，,。「」"']{1,20})/;
  const bm = btnRe.exec(lower);
  if (bm && !ops.length) {
    const btn = anchors.find((n) => n.tag === 'button');
    if (btn) ops.push({ op: 'updateProps', target: { node_id: btn.id }, value: { text: bm[1].trim() } });
  }

  // 3) 颜色/样式调整
  if (/(主色|背景|底色).*(蓝|深|暗)/.test(lower) || /换成蓝色/.test(lower)) {
    ops.push({ op: 'setStyle', target: { selector: { type: 'block', value: 'root' } }, value: { style: { background: '#1e293b' } } });
  }
  if (/(加粗|粗体|加黑)/.test(lower)) {
    const t = pickTarget(scopeRoot, lower);
    if (t) ops.push({ op: 'updateProps', target: { node_id: t.id }, value: { style: { fontWeight: 700 } } });
  }
  // 3.b) 字号调整：'标题改大一点' / '字体小一些'
  if (/(改|调|变)?(大|小)(一点|一些|点)?$/.test(lower.trim()) || /(字号|字体|标题|文字).*(变大|变大一些|放大|缩小|大一点|小一点|大一些|小一些)/.test(lower)) {
    const bigger = /(变大|放大|大一点|大一些|改大|调大)/.test(lower);
    const t = pickTarget(scopeRoot, lower);
    if (t) {
      const curSize = Number(t.props?.style?.fontSize) || 14;
      ops.push({
        op: 'updateProps',
        target: { node_id: t.id },
        value: { style: { fontSize: Math.max(10, Math.min(48, bigger ? curSize + 4 : curSize - 2)) } },
      });
    }
  }
  // 3.c) 对齐 / 居中
  if (/(居中|居中对齐)/.test(lower)) {
    const t = pickTarget(scopeRoot, lower);
    if (t) ops.push({ op: 'updateProps', target: { node_id: t.id }, value: { style: { textAlign: 'center', alignSelf: 'center' } } });
  }
  // 3.d) 圆角
  if (/圆角/.test(lower)) {
    const btn = anchors.find((n) => n.tag === 'button');
    if (btn) ops.push({ op: 'updateProps', target: { node_id: btn.id }, value: { style: { borderRadius: 24 } } });
  }

  // 4) 新增元素：'加一个 ... 按钮' / '增加 ...'
  const addRe = /(?:增加|加一个|添加|新增)\s*(?:一个)?\s*[「"']?([^，,。]{1,20})/;
  const am = addRe.exec(lower);
  if (am) {
    const label = am[1];
    const isBtn = /按钮|btn|button/.test(label);
    const anchorName = `extra_${ops.length}`;
    const newNode = isBtn
      ? button(`${root.id}_extra_${makeId().slice(-6)}`, label.replace(/按钮|btn|button/g, '').trim() || '继续', anchorName, { marginTop: 16 })
      : text(`${root.id}_extra_${makeId().slice(-6)}`, label, { fontSize: 13, color: C.sub, marginTop: 12 });
    const container = findDeepestContainer(scopeRoot);
    ops.push({ op: 'insertChild', target: { node_id: container.id }, value: { node: newNode } });
  }

  // 5) 删除元素：'删除 X' / '去掉 X'
  const delRe = /(?:删除|去掉|移除)\s*[「"']?([^，,。]{1,16})/;
  const dm = delRe.exec(lower);
  if (dm) {
    const kw = dm[1];
    let hit = null;
    for (const r of scopeRoots) {
      walk(r, (n) => {
        if (!hit && n.props?.text && String(n.props.text).includes(kw) && n.tag !== 'button') hit = n;
      });
    }
    if (hit) {
      const parent = findParent(root, hit.id);
      // 如果父节点只有这一个非根子节点相关，删除父级整块更稳妥
      ops.push({ op: 'removeNode', target: { node_id: parent && parent.id !== root.id && parent.children.length <= 2 ? parent.id : hit.id } });
    }
  }

  // 6) 兜底收敛：定位已限定在作用域根内，这里再防御一次，
  //    拦截 setStyle(selector:block=root) 这类"不是 node_id 但会越界"的 op。
  if (editScope !== 'screen') {
    for (let i = ops.length - 1; i >= 0; i--) {
      const t = ops[i].target || {};
      const nid = t.node_id || (t.selector?.type === 'node_id' ? t.selector.value : null);
      if (nid && !inScope(findNode(root, nid))) {
        ops.splice(i, 1);
        continue;
      }
      // 样式类 op 指向整屏根块：在区域内修改等于改整屏，直接丢弃
      if (t.selector && (t.selector.type === 'block' || t.selector.type === 'anchor')) {
        if (t.selector.type === 'block' && t.selector.value === 'root') ops.splice(i, 1);
      }
    }
  }

  // mode 必须如实反映"发生了什么"：
  //  - 有 ops → patch
  //  - 没解析出任何变更 → noop（绝不是 full，否则上层会误判成"模型试图整屏重写"并报 422）
  return {
    target_screen_id: null,
    edit_scope: editScope,
    mode: ops.length ? 'patch' : 'noop',
    ops,
    note: ops.length ? null : '未从指令中解析出可执行的局部变更',
  };
  });
}

/**
 * 选出"用户说的那一块"：先从话里找名词（标题/副标题/正文/具体的文案），
 * 找不到具体名词时才退回文档顺序第一个文本节点。
 * protectedWords：被"不要改 X"明确保护的对象，定位时必须跳过。
 */
function pickTarget(root, instruction, protectedWords = []) {
  const texts = allTexts(root);
  if (!texts.length) return null;
  const bySize = texts.slice().sort((a, b) => fsOf(b) - fsOf(a));
  const phraseOf = (n) => String(n.props?.text || '');

  // 被"不要改标题"点名保护的位置：按字号名次（标题=最大，副标题=第二大）
  const blockedRoles = new Set();
  for (const w of protectedWords) {
    if (/^(副标题|小标题)$/.test(w)) blockedRoles.add('sub');
    else if (/^标题$/.test(w)) blockedRoles.add('title');
  }
  const pickRank = (role) => {
    if (blockedRoles.has(role)) return null;
    return role === 'sub' ? bySize[1] || bySize[0] : bySize[0];
  };

  // 先找"副标题"这类更具体的名词，避免"副标题"被"标题"抢先匹配
  const kwMatch = /(副标题|小标题|标题|说明|描述|正文|内容|文字)/.exec(instruction);
  if (kwMatch) {
    if (/^(副标题|小标题)$/.test(kwMatch[1])) {
      const sub = pickRank('sub');
      if (sub) return sub;
    } else if (kwMatch[1] === '标题') {
      const t = pickRank('title');
      // 标题被保护时，不再退回到"字号最大的那个"
      if (t && !protectedWords.some((w) => phraseOf(t).includes(w))) return t;
    } else {
      const t = findTextTarget(root, kwMatch[1]);
      if (t) return t;
    }
  }
  // 引号里的原文
  const quoted = /[「"']([^「」"']{1,16})[」"']/.exec(instruction);
  if (quoted) {
    const t = findTextTarget(root, quoted[1]);
    if (t) return t;
  }
  // 兜底：第一个非标题文本（标题通常字号最大，已在上面按角色处理过）
  const first = texts.find((n) => n !== bySize[0]) || texts[0];
  const isBlocked =
    (first === bySize[0] && blockedRoles.has('title')) || (first === bySize[1] && blockedRoles.has('sub'));
  return isBlocked ? null : first;
}

function allTexts(root) {
  const texts = [];
  walk(root, (n) => {
    if (n.props?.text && n.tag !== 'button') texts.push(n);
  });
  return texts;
}

function fsOf(n) {
  return Number(n.props?.style?.fontSize) || 14;
}

function findFirstText(root) {
  let hit = null;
  walk(root, (n) => {
    if (!hit && n.tag === 'span' && n.props?.text && String(n.props.text).length > 4) hit = n;
  });
  return hit;
}

/** 屏内没有这段原文时，判断 X 是不是"对某块的称呼"（标题 / 副标题 / 正文…） */
function isRoleWord(word) {
  return /^(标题|副标题|小标题|说明|描述|正文|内容|文字|文案|按钮|数字|金额|状态)$/.test(String(word || '').trim());
}

/**
 * 按用户话里的名词定位节点。
 * 用户说"标题"，指的是"最像标题的那个"，而不是文档顺序第一个 span——
 * 之前"把标题改大一点"会命中副标题，这是真实的错位。
 */
export function findTextTarget(root, keyword) {
  const kw = String(keyword || '');
  const texts = [];
  walk(root, (n) => {
    const t = n.props?.text;
    if (t && n.tag !== 'button') texts.push(n);
  });
  if (!texts.length) return null;

  const sizeOf = (n) => Number(n.props?.style?.fontSize) || 14;
  const weightOf = (n) => Number(n.props?.style?.fontWeight) || 400;
  const isHeading = (n) => sizeOf(n) >= 20 || weightOf(n) >= 600;

  if (/标题|title/i.test(kw)) {
    // 标题 = 字号最大的那个文本节点（同级里最像 H1）
    return texts.slice().sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  }
  if (/副标题|说明|描述|subtitle/i.test(kw)) {
    const sorted = texts.slice().sort((a, b) => sizeOf(b) - sizeOf(a));
    return sorted[1] || sorted[0];
  }
  if (/正文|内容|文字/.test(kw)) {
    return texts.find((n) => !isHeading(n)) || texts[0];
  }
  // 其它名词：先按原文包含匹配
  const byText = texts.find((n) => String(n.props.text).includes(kw));
  if (byText) return byText;
  // 再按前两个字匹配
  if (kw.length >= 2) {
    const byPrefix = texts.find((n) => String(n.props.text).includes(kw.slice(0, 2)));
    if (byPrefix) return byPrefix;
  }
  return null;
}

function findParent(root, id) {
  let p = null;
  walk(root, (n) => {
    const kids = Array.isArray(n.children) ? n.children : [];
    if (!p && kids.some((c) => c.id === id)) p = n;
  });
  return p;
}

/**
 * 区域 / 组件范围的作用域根。
 * - screen：整屏根
 * - region / component：选区节点自身（多选时为多个根，取第一个作为主作用域）
 * 选区节点不存在时退回整屏，让上层的 SELECTION_NOT_FOUND 校验先给出可操作错误。
 */
function resolveScopeRoots(root, editScope, selection) {
  if (editScope === 'screen') return [root];
  const ids = Array.isArray(selection?.node_ids) ? selection.node_ids : [];
  const roots = ids.map((id) => findNode(root, id)).filter(Boolean);
  return roots.length ? roots : [root];
}

/** id 是否为 node 的后代（用于兜底收敛） */
function descendant(node, id) {
  let hit = false;
  walk(node, (c) => {
    if (c.id === id) hit = true;
  });
  return hit && node.id !== id;
}

function findDeepestContainer(root) {
  let best = root;
  walk(root, (n) => {
    if (Array.isArray(n.children) && n.children.length && n.id !== root.id) {
      best = n;
    }
  });
  return best;
}

export { textOf };
