import { classifyInstruction, extractInstruction, readExplicitTarget, RULE_IDS } from './rules.js';

/**
 * 内置生成器路由（FR-ROUTE-001～009）
 *
 * 目标：把"可唯一确定变更值"的文字类请求短路到内置生成器，减少大模型调用与 token 消耗；
 * 但要严格守住边界——理解不了、带创作意图、带否定约束的请求一律升级到大模型（FR-ROUTE-005）。
 *
 * 路由层级：
 *   explicit    请求自带结构化目标（node_id / anchor）       → 内置生成器
 *   rule        命中本地规则且新值唯一                        → 内置生成器
 *   llm         其余（含 creative / negation / constraint）    → 大模型原流程
 *   disabled    内置生成器被关闭 / 当前模型不是内置生成器      → 大模型原流程
 *
 * 本模块只做判定，不落库、不读写屏幕；服务层据 decision 决定是否调用内置生成器。
 */

export const ROUTE_LAYERS = ['explicit', 'rule', 'classifier', 'llm'];

/**
 * @param {object} input
 * @param {string} input.prompt            原始 prompt（可能带上下文元信息）
 * @param {object} input.body              请求体（读取 node_id / anchor 等结构化字段）
 * @param {string} input.editScope         screen / region / component
 * @param {object|null} input.generator    内置生成器维护配置（generatorConfig() 的返回值）
 * @param {boolean} input.hasContent       屏幕是否已有实质内容（空屏必须整屏生成）
 * @param {boolean} input.forceFull        是否显式要求整屏重生成
 * @param {boolean} input.isBuiltinActive  当前选中的模型是否为内置生成器
 * @param {string} input.modelId           当前模型 id（仅用于日志）
 * @returns {{ layer:'explicit'|'rule'|'classifier'|'llm', rule_id:string|null, target:object|null, value:string|null, reason:string, requested:boolean, hit_rule:string|null, summary:string|null }}
 */
export function routeIntent({ prompt, body = {}, editScope = 'screen', generator = null, hasContent = false, forceFull = false, isBuiltinActive = true, modelId = null }) {
  const instruction = extractInstruction(prompt);
  const base = { rule_id: null, target: null, value: null, requested: true, hit_rule: null, summary: null, instruction_chars: instruction.length };

  const off = (reason) => ({ ...base, layer: 'llm', requested: false, reason });

  // ① 内置生成器是否可用：先判断显式开关（关闭 / 路由关闭 / 不可用），再判断当前模型是否指向内置生成器
  if (generator && generator.scope === 'off') return off('generator_disabled');
  if (!generator) return off('generator_unavailable');
  if (!generator.router_enabled) return off('router_disabled');
  if (!isBuiltinActive) return off('model_not_builtin');

  // ② 空屏 / 显式整屏重生成：只能整屏生成，不存在"确定性局部变更"
  if (!hasContent) return off('empty_screen_needs_full');
  if (forceFull) return off('explicit_full');

  const explicit = readExplicitTarget(body);
  // 仅显式模式：没有结构化目标就不参与
  if (generator.scope === 'explicit_only' && !explicit) return off('scope_explicit_only');

  // ②' 区域 / 组件范围：必须有选区；显式目标必须落在选区内（FR-GEN-004 / DC-008）
  const selectedIds = Array.isArray(body?.selection?.node_ids) ? body.selection.node_ids : [];
  if (editScope !== 'screen') {
    if (!selectedIds.length) return off('no_selection');
    if (explicit && explicit.node_id && !selectedIds.includes(explicit.node_id)) {
      return off('target_outside_selection');
    }
  }

  const enabledRules = Array.isArray(generator.rules) ? generator.rules : RULE_IDS;
  if (!enabledRules.length && !explicit) return off('no_rule_enabled');

  const cls = classifyInstruction(instruction, {
    enabledRules,
    explicit: explicit && (explicit.node_id || explicit.anchor) ? { ...explicit } : null,
    editScope,
  });

  // ③ 创作意图 / 否定值 / 只有限定语：明确升级大模型，并记录原因（AI-014）
  if (!cls) return off('no_rule_matched');
  if (cls.layer === 'llm') return off(cls.reason);

  // ④ 选区越界防护：region / component 下只保留落在选区内的 op（DC-008 + 只改选区）
  const target = explicit || null;
  const value = cls.value || null;

  // 文字替换但没有可写入的值：视为未命中，让大模型或原有 422 语义兜底
  if (!value && /^(text_replace|button_label|tone_adjust)$/.test(cls.rule_id || '')) {
    return off('rule_matched_without_value');
  }

  return {
    ...base,
    // explicit：请求自带结构化目标，且规则产出的是"可写入该目标的文字值"
    layer: cls.node_id && value ? 'explicit' : cls.layer,
    rule_id: cls.rule_id,
    hit_rule: cls.rule_id,
    target,
    value,
    reason: 'deterministic_change',
    summary: cls.note || (value ? `→ ${value}` : null) || cls.rule_id,
    edit_scope: editScope,
  };
}

/** 写入 job / 版本的决策日志字段（NFR-017：不含 prompt 正文与密钥） */
export function routeLog(decision) {
  if (!decision) return null;
  return {
    route_layer: decision.layer,
    rule_id: decision.rule_id || null,
    is_deterministic: decision.layer === 'explicit' || decision.layer === 'rule',
    reason: decision.reason,
    instruction_chars: decision.instruction_chars ?? null,
    ai_cost: decision.layer === 'explicit' || decision.layer === 'rule' ? 0 : null,
  };
}
