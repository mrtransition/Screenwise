import { textOf, collectAnchors, fingerprint } from '../domain/doc.js';

/**
 * ★ 上下文构造器（NFR-003 / C-005 / AI-001 / AI-004 / AI-005）
 *
 * 这是整个系统的"隔离闸门"：发给模型的上下文只能由这里的白名单字段拼成。
 * 上游调用方无法通过传参塞入其它屏正文——本函数只接收 currentDoc，
 * 其他屏的信息只能以「标题」形式传入（navigation_hints），且会被二次裁剪。
 *
 * 产出对象保留 sources 与 redacted_peers，供审计日志逐条比对（FR-AUDIT-002）。
 */

const MAX_NAV_HINT = 40;

export function buildGenerationContext({
  project,
  screen,
  currentDoc,
  instruction,
  editScope,
  selection,
  itemView = false,
  toNodes = null,
  anchors = null,
}) {
  const tokens = project.design_tokens || {};
  // M3 屏没有 root：调用方传入把 Item 还原成节点树的函数，模型侧看到的仍是同一套 node-tree 契约
  const docForModel = itemView && currentDoc?.format === 'm3' && typeof toNodes === 'function' ? toNodes(currentDoc) : currentDoc;
  // M3 的 collectAnchors 只认 node-tree，直接调用会得到空数组；调用方统一传 anchorsOfDoc 的结果，
  // 保证模型在两种格式下都能看到真实热区（AI-004 / AI-006）。
  const anchorList = Array.isArray(anchors) ? anchors : collectAnchors(currentDoc);
  const navHints = (project.screen_titles || [])
    .filter((t) => t.screen_id !== screen.screen_id)
    .map((t) => ({ screen_id: t.screen_id, title: truncate(t.title, MAX_NAV_HINT) }));

  const payload = {
    request: {
      target_screen_id: screen.screen_id,
      edit_scope: editScope,
      device: project.device,
    },
    // C-006：跨屏一致性只通过 token / 组件定义共享
    design_tokens: tokens,
    screen: {
      screen_id: screen.screen_id,
      title: screen.title,
      anchors: anchorList,
      // M3 屏没有 root：给模型的是按 Item 还原的节点视图，item_id 就是画布上的 data-item-id。
      // 原始 ScreenDoc 与节点视图一起给出，模型据此知道能改哪些字段。
      doc: docForModel,
      ...(itemView && currentDoc?.format === 'm3'
        ? {
            item_ids: (currentDoc.groups ?? []).flatMap((g) => (g.items ?? []).map((i) => i.id)).filter(Boolean),
          }
        : {}),
    },
    selection: selection || null,
    navigation_hints: navHints,
    instruction,
  };

  const prompt = renderPrompt(payload);

  return {
    payload,
    prompt,
    // 审计用：证明上下文里只出现了 target 屏
    audit: {
      target_screen_id: screen.screen_id,
      edit_scope: editScope,
      embedded_screen_ids: [screen.screen_id],
      peer_screen_titles_only: navHints.map((h) => h.title),
      context_fingerprint: (currentDoc?.format === 'm3'
        ? JSON.stringify(currentDoc.groups ?? [])
        : fingerprint(currentDoc)
      ).length,
      prompt_chars: prompt.length,
    },
  };
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function renderPrompt(p) {
  const lines = [];
  lines.push('# 角色');
  lines.push('你是单屏原型生成器。你只能操作 target_screen_id 指定的这一张屏幕，禁止提及或修改任何其他屏幕。');
  lines.push('');
  lines.push('# 目标');
  lines.push(`- target_screen_id: ${p.request.target_screen_id}`);
  lines.push(`- edit_scope: ${p.request.edit_scope}`);
  lines.push(`- device: ${p.request.device?.width}×${p.request.device?.height}`);
  lines.push('');
  lines.push('# 设计 token（跨屏唯一共享物）');
  lines.push(JSON.stringify(p.design_tokens, null, 2));
  lines.push('');
  lines.push('# 当前屏幕（仅此屏）');
  lines.push(`标题：${truncate(p.screen.title, 60)}`);
  lines.push('已有热区：' + (p.screen.anchors.map((a) => a.hotspot_id).join(', ') || '无'));
  lines.push('节点树：');
  lines.push(JSON.stringify(p.screen.doc));
  if (p.selection) {
    lines.push('');
    lines.push('# 选中区域（只可改该子树）');
    lines.push(JSON.stringify(p.selection));
  }
  if (p.navigation_hints.length) {
    lines.push('');
    lines.push('# 其它屏幕（仅标题，不含正文，用于文案风格统一，禁止引用其内容）');
    for (const h of p.navigation_hints) lines.push(`- ${h.title}`);
  }
  lines.push('');
  lines.push('# 输出格式');
  lines.push('只输出 JSON：{ "target_screen_id": "...", "edit_scope": "...", "mode": "full"|"patch", "ops": [...] }');
  lines.push('patch 只能用 target.node_id 或 target.selector.type=anchor|block，禁止 nth-child / 位置索引。');
  lines.push('可点击元素必须带 data-anchor；不得出现其它 screen_id。');
  lines.push('');
  lines.push('# 用户指令');
  lines.push(p.instruction);
  return lines.join('\n');
}

/**
 * 审计校验：确认 prompt 中不含任何"其他屏正文"片段。
 * 用法：把其它屏的指纹切片传进来，断言一个都匹配不到。
 */
export function assertContextIsolation(ctx, peerDocs) {
  const violations = [];
  for (const peer of peerDocs) {
    const sid = peer.screen_id;
    const doc = peer.doc;
    // M3 ScreenDoc 没有 root：用组/Item 文本作为正文标记，避免这里抛错让隔离校验形同虚设。
    const bodyText = doc?.root
      ? textOf(doc.root)
      : (doc?.groups ?? [])
          .flatMap((g) => (g.items ?? []).map((i) => [i.label, i.supporting, i.text, i.value].filter(Boolean).join(' ')))
          .join(' ');
    const fp = doc?.root
      ? fingerprint(doc)
      : JSON.stringify((doc?.groups ?? []).map((g) => [g.id, g.name, ...(g.items ?? []).map((i) => i.id)]));
    if (ctx.prompt.includes(`"screen_id": "${sid}"`) || ctx.prompt.includes(`target_screen_id: ${sid}`)) {
      // 允许出现在 navigation_hints 的标题行里，这里只拦截正文级出现
      const bodyMarkers = [bodyText.slice(0, 24), `"${sid}"]`];
      for (const m of bodyMarkers) {
        if (m && m.length > 6 && ctx.prompt.includes(m)) violations.push({ peer: sid, marker: m });
      }
    }
    if (!doc?.root) {
      for (const g of doc?.groups ?? []) {
        for (const item of g.items ?? []) {
          if (item?.id && ctx.prompt.includes(`"id":"${item.id}"`)) violations.push({ peer: sid, marker: item.id });
        }
      }
      continue;
    }
    for (const line of fp.split('\n')) {
      const nodeId = line.split('|')[0];
      if (nodeId && ctx.prompt.includes(`"id":"${nodeId}"`)) violations.push({ peer: sid, marker: nodeId });
    }
  }
  return violations;
}

export { collectAnchors, textOf };
