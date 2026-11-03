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

export function buildGenerationContext({ project, screen, currentDoc, instruction, editScope, selection }) {
  const tokens = project.design_tokens || {};
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
      anchors: collectAnchors(currentDoc),
      doc: currentDoc,
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
      context_fingerprint: fingerprint(currentDoc).length,
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
    if (ctx.prompt.includes(`"screen_id": "${sid}"`) || ctx.prompt.includes(`target_screen_id: ${sid}`)) {
      // 允许出现在 navigation_hints 的标题行里，这里只拦截正文级出现
      const bodyMarkers = [textOf(peer.doc.root).slice(0, 24), `"${sid}"]`];
      for (const m of bodyMarkers) {
        if (m && m.length > 6 && ctx.prompt.includes(m)) violations.push({ peer: sid, marker: m });
      }
    }
    const fp = fingerprint(peer.doc);
    for (const line of fp.split('\n')) {
      const nodeId = line.split('|')[0];
      if (nodeId && ctx.prompt.includes(`"id":"${nodeId}"`)) violations.push({ peer: sid, marker: nodeId });
    }
  }
  return violations;
}

export { collectAnchors, textOf };
