/**
 * 内置生成器规则表（FR-ROUTE-002 / FR-ROUTE-005 / FR-ROUTE-006）
 *
 * 单一事实来源：路由判定（哪些请求可交给内置生成器）与生成器执行（生成哪些 ops）
 * 共用这份规则，避免"路由认为能处理、生成器却没解析出"的两套口径。
 *
 * 每条规则声明：
 *   id      规则标识，可在模型目录里单独启停（generator.rules）
 *   label   可读名称
 *   match   输入为剥离元信息后的用户指令，返回是否命中
 *   note    命中后用于生成可读摘要的说明
 *
 * 规则本身不做节点定位——定位在 local.js 里按当前屏节点树进行。
 */

/** 创作 / 语义类意图词：命中即视为不可唯一确定，必须升级大模型（FR-ROUTE-005） */
export const CREATIVE_INTENT = /(优化|美化|润色|改得|写得|更有|更佳|更专业|更具|更活泼|更有冲击|更有紧迫|风格|语气|调性|氛围|高级感|设计感|吸引|打动人|生动|有趣|创意|重写|重构|排版调整)/;

/** 否定粘连检测用：紧贴在新值前的否定词表示"用户否定的正是这个值" */
const VALUE_END = String.raw`[「"'”]?([^，,。；;「」"'”]{1,40})[」"'”]?`;

export const RULES = [
  {
    id: 'text_replace',
    label: '文案替换',
    // 把 X 改成 Y / 将「X」改为「Y」/ X 文案换成 Y
    re: /(?:把|将)?\s*[「"'“”]([^，,。\s「」"'”]{1,16})[」"'”]\s*(?:文案|文字|文本)?\s*(?:改|换|替换)(?:成|为)\s*[「"'“]?([^，,。；;「」"'”]{1,40})[」"'”]?/g,
    note: (m) => `${m[1]} → ${m[2]}`,
  },
  {
    id: 'button_label',
    label: '按钮文案',
    re: /(?:按钮|button)\s*(?:文案|文字)?\s*(?:改|换|替换)(?:成|为)\s*[「"'“]?([^，,。；;「」"'”]{1,20})/,
    note: (m) => `按钮 → ${m[1]}`,
  },
  {
    id: 'tone_adjust',
    label: '措辞微调',
    // 改成"已完成" / 改成通过 / 换成确定  —— 裸动词式换词，值可唯一确定
    re: /(?:改成|改为|换成|换为)\s*[「"'“]?([^，,。；;「」"'”]{1,12})[」"'”]?\s*$/,
    note: (m) => `→ ${m[1]}`,
  },
  {
    id: 'font_scale',
    label: '字号调整',
    re: /(字号|字体|标题|文字|字).{0,8}(变大|放大|大一点|大一些|改大|调大|变小|缩小|小一点|小一些|改小|调小)|(改|调)(大|小)(一点|一些|点)?$/,
    note: () => '字号调整',
  },
  {
    id: 'align_center',
    label: '居中',
    re: /(居中|居中对齐)/,
    note: () => '居中',
  },
  {
    id: 'radius',
    label: '圆角',
    re: /圆角/,
    note: () => '圆角调整',
  },
  {
    id: 'color',
    label: '颜色',
    // 颜色作用于整屏根块，只在「整屏」范围成立；区域 / 组件范围内不应由规则处理
    screen_only: true,
    re: /(主色|背景|底色|颜色|配色).{0,6}(蓝|深|暗|黑|白|灰|红|绿|品牌)|换成(蓝色|深色|黑色)/,
    note: () => '颜色调整',
  },
  {
    id: 'bold',
    label: '加粗',
    re: /(加粗|粗体|加黑|加粗一点)/,
    note: () => '加粗',
  },
  {
    id: 'add_element',
    label: '新增元素',
    re: /(?:增加|加一个|添加|新增)\s*(?:一个)?\s*[「"'“]?([^，,。；;]{1,20})/,
    note: (m) => `新增 ${m[1]}`,
  },
  {
    id: 'remove_element',
    label: '删除元素',
    re: /(?:删除|去掉|移除)\s*[「"'“]?([^，,。；;「」"'”]{1,16})/,
    note: (m) => `删除 ${m[1]}`,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

/**
 * 剥离 prompt 中的元信息，只留用户自然语言指令。
 * prompt 里带有 "# 用户指令" 模板标题与示例，直接做关键词匹配会误判。
 */
export function extractInstruction(prompt) {
  const raw = String(prompt || '');
  const marker = '# 用户指令';
  const idx = raw.indexOf(marker);
  const body = idx >= 0 ? raw.slice(idx + marker.length).trim() : raw.trim();
  // 只看第一句（含换行首行），避免把示例文案里的词也算进去
  return body.split(/\r?\n/)[0].trim();
}

/** 单条规则是否命中（全局正则以 lastIndex 前进，这里用 clone 保证多次调用结果一致） */
export function matchRule(rule, text) {
  const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
  const m = re.exec(text);
  return m ? m : null;
}

/**
 * 新值是否粘带了否定语义（FR-ROUTE-005 / AI-011）。
 * 例："把标题改成不要超过 20 字" —— 新值里本身是否定表述，不能直接写入屏幕。
 */
export function hasNegationInValue(text, match) {
  if (!match || !match[1]) return false;
  return /^(不要|别|不|非|禁止|勿)/.test(String(match[1]).trim());
}

/**
 * 指令是否只是限定语，无法确定要改什么（如"不要改标题"）。
 * 注意：必须先把「去掉否定限定后仍带有变更动词」的句子识别为可执行，
 * 否则"不要改标题，只把副标题改为 X"会被整体误判成纯限定语。
 */
const CHANGE_VERB = /(改成|改为|换成|换为|替换成|设置为|设为|加粗|居中|删除|去掉|移除|新增|添加|增加|放大|缩小|变大|变小|大一点|小一点|大一些|小一些)/;

export function isConstraintOnly(text) {
  const src = String(text || '').trim();
  if (!src) return true;
  const stripped = src.replace(/(不要|别|无需|不用|禁止)\s*(改|动|变|调整|修改)[^，,。；;]*/g, '').trim();
  // 去掉否定限定后仍有变更动词 → 可执行（否定只保护被点名的对象）
  if (CHANGE_VERB.test(stripped)) return false;
  return stripped.length === 0 || /^[，,。；;、\s]*$/.test(stripped);
}

/**
 * 规则判定（纯函数，不注入节点树）：返回 { rule_id, layer, value } 或 null。
 * - explicit：指令显式携带 target（node_id / anchor），值来自 text_replace→tone_adjust
 * - rule：文本命中 enabledRules 中的一条规则
 */
export function classifyInstruction(text, { enabledRules = RULE_IDS, explicit = null, editScope = 'screen' } = {}) {
  const src = String(text || '').trim();
  if (!src) return null;
  if (isConstraintOnly(src)) return null;

  if (CREATIVE_INTENT.test(src)) {
    // 创作意图优先于任何规则：哪怕同时含"改成"，也交给大模型理解
    return { rule_id: null, layer: 'llm', value: null, reason: 'detect_creative_intent' };
  }

  // 样式对象不该被当成文案：'把背景改成蓝色' 的目标不是文字节点
  const STYLE_OBJECT = /(背景|底色|主色|配色|圆角|字号|字体|颜色)/;
  const COLOR_VALUE = /^(蓝|红|绿|黑|白|灰|深蓝|深色|浅色|蓝色|红色|绿色|黑色|白色|灰色)/;

  const hits = [];
  for (const rule of RULES) {
    if (!enabledRules.includes(rule.id)) continue;
    // 整屏级样式规则（如换背景色）：区域 / 组件范围不适用，避免产生被丢弃的越界 op
    if (rule.screen_only && editScope !== 'screen') continue;
    const m = matchRule(rule, src);
    if (!m) continue;
    if (hasNegationInValue(src, m)) return { rule_id: rule.id, layer: 'llm', value: null, reason: 'negation_in_value' };
    const value = m[1] ? String(m[1]).trim().replace(/[」"'”]+$/, '') : null;
    // '把背景改成蓝色'：由 color 规则处理样式，而不是把某个文本节点改成"蓝色"
    if (rule.id === 'tone_adjust' && value && STYLE_OBJECT.test(src) && COLOR_VALUE.test(value)) continue;
    hits.push({ rule_id: rule.id, value, note: rule.note(m) });
  }

  // 显式结构化目标 + 明确的"改为 X"：目标已由请求唯一指定，
  // 即使文案类规则被逐条关闭，也不该退化成"没听懂"——值是唯一确定的，直接产出。
  if (explicit && (explicit.node_id || explicit.anchor)) {
    const picked = pickExplicitValue(src);
    if (picked) {
      return { rule_id: 'tone_adjust', layer: 'explicit', value: picked, node_id: explicit.node_id || null, anchor: explicit.anchor || null, note: `→ ${picked}`, hits };
    }
  }
  if (!hits.length) return null;

  // 同时命中"新增/删除"等结构性规则：仍然确定性可做，但显式 target 只用于文字替换
  // anchor 与 node_id 等价：都是稳定目标（DC-008 禁止位置索引，anchor 由页面声明）
  if (explicit && (explicit.node_id || explicit.anchor) && /^(text_replace|button_label|tone_adjust)$/.test(hits[0].rule_id)) {
    return { rule_id: hits[0].rule_id, layer: 'explicit', value: hits[0].value, node_id: explicit.node_id || null, anchor: explicit.anchor || null, note: hits[0].note, hits };
  }
  return { rule_id: hits[0].rule_id, layer: 'rule', value: hits[0].value, note: hits[0].note, hits };
}

/**
 * 显式模式下的取值：只认"改为/换成「X」"这类唯一确定的新值。
 * 返回值缺失或本身带否定（"改成不要超过 20 字"）时返回 null，交由大模型处理。
 */
export function pickExplicitValue(text) {
  const patterns = [
    /(?:改|换|替换|设置|设为|写成)(?:成|为)\s*[「"']([^「」"']{1,40})[」"']/,
    /(?:改成|改为|换成|换为)\s*([^，,。；;「」"']{1,40})\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(String(text || ''));
    if (!m) continue;
    const value = m[1].trim();
    if (!value) continue;
    if (/^(不要|别|不|非|禁止|勿)/.test(value)) return null;
    return value;
  }
  return null;
}

/**
 * 从显式结构化指令里取出目标节点：只认 node_id / anchor，不认位置索引（DC-008）。
 */
export function readExplicitTarget(body = {}) {
  const raw = body.node_id ?? body.target?.node_id ?? body.anchor ?? body.target?.anchor;
  if (!raw || typeof raw !== 'string') return null;
  if (/^(nth-child|#|\.|\[)/i.test(raw) || /\s>\s/.test(raw)) return null;
  if (body.node_id || body.target?.node_id) return { node_id: raw };
  return { anchor: raw };
}
