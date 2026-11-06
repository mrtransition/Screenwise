import { createHash } from 'node:crypto';
import { deriveDesignTokens } from '../domain/m3/convert.js';

/**
 * Prompt 交付（FR-PROMPT-001~012 / AI-021~029）。
 *
 * 设计原则：
 *  - 只吃项目设计 + ScreenDoc + 已确认 FlowEdge，不读存储路径、模型配置或密钥；
 *  - 输出完全确定：屏幕/分组/边按稳定顺序遍历，不含时间戳与随机 id；
 *  - 单屏模式只嵌入目标屏正文，其它屏只保留标题级导航提示（C-021）；
 *  - 语言只影响说明文字与分节标题，不影响设计数据本身。
 */

export const PROMPT_LANGS = Object.freeze(['zh', 'en', 'ja', 'ko']);
export const PROMPT_MAX_BYTES = 60 * 1024;

const L = {
  zh: {
    title: '编码 Agent Prompt',
    intro: '以下 brief 由项目设计数据自动生成，可直接交给编码 Agent 实现可运行原型。',
    goal: '目标',
    colors: '颜色',
    theme: '主题',
    layout: '布局',
    behavior: '行为',
    style: '风格',
    general: '通用要求',
    options: '选项',
    screens: '屏幕',
    scopeProject: '全项目',
    scopeScreen: '单屏',
    project: '项目',
    brief: '需求简述',
    platform: '平台',
    device: '设备',
    palette: '色板',
    primary: '主色',
    dynamicColor: '动态取色',
    dark: '暗色模式',
    bothModes: '同时支持明暗',
    contrast: '对比度',
    shape: '形状',
    font: '字体',
    emphasized: '强调字体',
    motion: '动效',
    screen: '屏幕',
    group: '分组',
    item: '部件',
    note: '备注',
    hidden: '隐藏',
    size: '尺寸',
    scroll: '滚动长度',
    background: '背景',
    navHints: '其它屏幕（仅标题，不得读取其正文）',
    noEdges: '暂无已确认的关联边。',
    edgeFrom: '从',
    edgeTo: '到',
    edgeLink: '打开链接',
    edgeBack: '返回上一屏',
    edgeTrigger: '触发',
    edgeTransition: '转场',
    edgeNote: '备注',
    noScreens: '项目还没有屏幕。',
    language: '输出语言',
    optionsEmpty: '未选择额外选项。',
    generalItems: [
      '使用 Material 3 组件与语义色角色，不要硬编码品牌色之外的随机色值。',
      '保持屏幕标题、部件文案与下方设计数据一致，不要自行改写业务文案。',
      '可点击元素必须有明确的交互目标；不要生成死链或不可返回的页面。',
      '优先使用项目级设计 token（颜色、圆角、字体）保证跨屏一致。',
      '不要包含 API Key、服务端路径、环境变量值或其它项目的数据。',
    ],
    optionLabels: {
      deliverable: '交付可运行的生产级代码（含构建说明）。',
      tests: '为关键交互补充自动化测试（至少覆盖主流程）。',
      darkMode: '同时实现亮色与暗色主题，并保证对比度。',
      languages: '界面文案支持多语言（至少中文与英文）。',
      offline: '应用在离线状态下仍可打开并浏览已加载内容。',
    },
    tooLarge: 'Prompt 超过 60KB，请使用单屏模式或精简项目内容。',
    redacted: '检测到疑似密钥/路径内容，已在 Prompt 中脱敏。',
  },
  en: {
    title: 'Coding Agent Prompt',
    intro: 'This brief is generated from the project design data and can be handed directly to a coding agent.',
    goal: 'Goal',
    colors: 'Colors',
    theme: 'Theme',
    layout: 'Layout',
    behavior: 'Behavior',
    style: 'Style',
    general: 'General requirements',
    options: 'Options',
    screens: 'Screens',
    scopeProject: 'Full project',
    scopeScreen: 'Single screen',
    project: 'Project',
    brief: 'Brief',
    platform: 'Platform',
    device: 'Device',
    palette: 'Palette',
    primary: 'Primary',
    dynamicColor: 'Dynamic color',
    dark: 'Dark mode',
    bothModes: 'Light and dark',
    contrast: 'Contrast',
    shape: 'Shape',
    font: 'Font',
    emphasized: 'Emphasized type',
    motion: 'Motion',
    screen: 'Screen',
    group: 'Group',
    item: 'Item',
    note: 'Note',
    hidden: 'Hidden',
    size: 'Size',
    scroll: 'Scroll length',
    background: 'Background',
    navHints: 'Other screens (titles only; do not read their content)',
    noEdges: 'No confirmed flow edges yet.',
    edgeFrom: 'From',
    edgeTo: 'to',
    edgeLink: 'Open link',
    edgeBack: 'Go back',
    edgeTrigger: 'Trigger',
    edgeTransition: 'Transition',
    edgeNote: 'Note',
    noScreens: 'The project has no screens yet.',
    language: 'Output language',
    optionsEmpty: 'No extra options selected.',
    generalItems: [
      'Use Material 3 components and semantic color roles; do not invent random colors outside the brand palette.',
      'Keep screen titles and component copy exactly consistent with the design data below.',
      'Every clickable element must have a real interaction target; do not create dead links or pages with no way back.',
      'Prefer project-level design tokens (color, radius, typography) for cross-screen consistency.',
      'Never include API keys, server paths, environment values, or data from other projects.',
    ],
    optionLabels: {
      deliverable: 'Deliver runnable production-ready code with build instructions.',
      tests: 'Add automated tests for key interactions (at least the main flow).',
      darkMode: 'Implement both light and dark themes with accessible contrast.',
      languages: 'Support multiple UI languages (at least Chinese and English).',
      offline: 'The app must open and browse loaded content while offline.',
    },
    tooLarge: 'Prompt exceeds 60KB. Use single-screen mode or trim the project.',
    redacted: 'Suspected secret/path content was redacted from the prompt.',
  },
  ja: {
    title: 'コーディングエージェント向け Prompt',
    intro: 'この brief はプロジェクト設計データから自動生成され、そのままコーディングエージェントに渡せます。',
    goal: '目標',
    colors: 'カラー',
    theme: 'テーマ',
    layout: 'レイアウト',
    behavior: '動作',
    style: 'スタイル',
    general: '共通要件',
    options: 'オプション',
    screens: '画面',
    scopeProject: 'プロジェクト全体',
    scopeScreen: '単一画面',
    project: 'プロジェクト',
    brief: '概要',
    platform: 'プラットフォーム',
    device: 'デバイス',
    palette: 'パレット',
    primary: 'プライマリ',
    dynamicColor: 'ダイナミックカラー',
    dark: 'ダークモード',
    bothModes: 'ライト/ダーク両対応',
    contrast: 'コントラスト',
    shape: '形状',
    font: 'フォント',
    emphasized: '強調タイプ',
    motion: 'モーション',
    screen: '画面',
    group: 'グループ',
    item: '部品',
    note: 'メモ',
    hidden: '非表示',
    size: 'サイズ',
    scroll: 'スクロール長',
    background: '背景',
    navHints: 'その他の画面（タイトルのみ。本文は参照しない）',
    noEdges: '確定済みの遷移はありません。',
    edgeFrom: '起点',
    edgeTo: '終点',
    edgeLink: 'リンクを開く',
    edgeBack: '前の画面に戻る',
    edgeTrigger: 'トリガー',
    edgeTransition: 'トランジション',
    edgeNote: 'メモ',
    noScreens: '画面がまだありません。',
    language: '出力言語',
    optionsEmpty: '追加オプションはありません。',
    generalItems: [
      'Material 3 のコンポーネントとセマンティックカラーを使用し、ランダムな色を追加しない。',
      '画面タイトルと部品の文言は下の設計データと完全に一致させる。',
      'クリック可能な要素には必ず実際の遷移先を設定し、デッドリンクを作らない。',
      'プロジェクト共通のデザイントークン（色・角丸・書体）で画面間の一貫性を保つ。',
      'API キー、サーバーパス、環境変数、他プロジェクトのデータを含めない。',
    ],
    optionLabels: {
      deliverable: 'ビルド手順を含む実行可能な本番品質コードを納品する。',
      tests: '主要なインタラクションの自動テストを追加する。',
      darkMode: 'ライト/ダーク両テーマを実装し、コントラストを確保する。',
      languages: 'UI を多言語対応にする（少なくとも中国語と英語）。',
      offline: 'オフラインでも読み込み済みコンテンツを開けるようにする。',
    },
    tooLarge: 'Prompt が 60KB を超えました。単一画面モードにするか内容を削減してください。',
    redacted: 'キー/パスの可能性がある内容を Prompt 内でマスクしました。',
  },
  ko: {
    title: '코딩 에이전트 Prompt',
    intro: '이 brief는 프로젝트 설계 데이터에서 자동 생성되었으며 코딩 에이전트에 바로 전달할 수 있습니다.',
    goal: '목표',
    colors: '색상',
    theme: '테마',
    layout: '레이아웃',
    behavior: '동작',
    style: '스타일',
    general: '공통 요구사항',
    options: '옵션',
    screens: '화면',
    scopeProject: '전체 프로젝트',
    scopeScreen: '단일 화면',
    project: '프로젝트',
    brief: '요약',
    platform: '플랫폼',
    device: '기기',
    palette: '팔레트',
    primary: '기본색',
    dynamicColor: '다이내믹 컬러',
    dark: '다크 모드',
    bothModes: '라이트/다크 지원',
    contrast: '대비',
    shape: '형태',
    font: '글꼴',
    emphasized: '강조 글꼴',
    motion: '모션',
    screen: '화면',
    group: '그룹',
    item: '구성 요소',
    note: '메모',
    hidden: '숨김',
    size: '크기',
    scroll: '스크롤 길이',
    background: '배경',
    navHints: '다른 화면(제목만 제공, 본문은 읽지 않음)',
    noEdges: '확정된 연결선이 없습니다.',
    edgeFrom: '출발',
    edgeTo: '도착',
    edgeLink: '링크 열기',
    edgeBack: '이전 화면으로',
    edgeTrigger: '트리거',
    edgeTransition: '전환',
    edgeNote: '메모',
    noScreens: '아직 화면이 없습니다.',
    language: '출력 언어',
    optionsEmpty: '추가 옵션이 없습니다.',
    generalItems: [
      'Material 3 구성 요소와 시맨틱 색상 역할을 사용하고 임의의 색을 추가하지 않는다.',
      '화면 제목과 구성 요소 문구는 아래 설계 데이터와 정확히 일치시킨다.',
      '클릭 가능한 요소에는 반드시 실제 이동 대상이 있어야 하며 죽은 링크를 만들지 않는다.',
      '프로젝트 공통 디자인 토큰(색상, 모서리, 글꼴)으로 화면 간 일관성을 유지한다.',
      'API 키, 서버 경로, 환경 변수 값, 다른 프로젝트 데이터를 포함하지 않는다.',
    ],
    optionLabels: {
      deliverable: '빌드 안내가 포함된 실행 가능한 프로덕션 수준 코드를 제공한다.',
      tests: '핵심 인터랙션에 대한 자동화 테스트를 추가한다.',
      darkMode: '라이트/다크 테마를 모두 구현하고 대비를 확보한다.',
      languages: 'UI를 다국어로 지원한다(최소 중국어와 영어).',
      offline: '오프라인에서도 로드된 콘텐츠를 열람할 수 있어야 한다.',
    },
    tooLarge: 'Prompt가 60KB를 초과했습니다. 단일 화면 모드로 전환하거나 내용을 줄이세요.',
    redacted: '키/경로로 의심되는 내용이 Prompt에서 마스킹되었습니다.',
  },
};

const normLang = (lang) => (PROMPT_LANGS.includes(lang) ? lang : 'zh');

/** 统一屏幕条目：接受 `{meta, doc}`、`{screen_id,title,doc}` 或裸 ScreenDoc */
function normalizeScreen(entry) {
  const meta = entry?.meta || entry || {};
  const doc = entry?.doc || entry?.screen_doc || (entry?.format === 'm3' || entry?.root ? entry : null);
  return {
    screen_id: meta.screen_id || doc?.frame?.id || entry?.screen_id || '',
    title: meta.title || doc?.frame?.name || entry?.title || '未命名屏幕',
    remark: meta.remark || '',
    order: meta.order ?? '',
    doc: doc || null,
  };
}

const clip = (s, n = 160) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

function itemText(item) {
  for (const k of ['label', 'text', 'value', 'placeholder']) {
    if (typeof item?.[k] === 'string' && item[k]) return item[k];
  }
  for (const k of ['supporting', 'note']) {
    if (typeof item?.[k] === 'string' && item[k]) return item[k];
  }
  for (const k of ['items', 'tabs']) {
    if (Array.isArray(item?.[k])) {
      const joined = item[k]
        .map((x) => (typeof x === 'string' ? x : x?.text ?? x?.label ?? x?.value ?? ''))
        .filter(Boolean)
        .join(' / ');
      if (joined) return joined;
    }
  }
  return '';
}

function themeSummary(theme) {
  const t = theme || {};
  return {
    dark: !!t.dark,
    bothModes: !!t.bothModes,
    contrast: t.contrast || 'standard',
    shape: t.shape || 'rounded',
    font: t.font || 'roboto',
    emphasized: !!t.emphasized,
    motion: t.motion || 'standard',
  };
}

function screensSorted(screens) {
  return [...screens].sort((a, b) => {
    const oa = String(a.order || '');
    const ob = String(b.order || '');
    if (oa && ob && oa !== ob) return oa.localeCompare(ob);
    return String(a.screen_id).localeCompare(String(b.screen_id));
  });
}

/** 单屏/全项目作用域下的屏幕集合：单屏只保留目标屏正文 */
function scopedScreens(all, screenId) {
  if (!screenId) return { body: all, navHints: [] };
  const target = all.filter((s) => s.screen_id === screenId);
  const others = all.filter((s) => s.screen_id !== screenId);
  return { body: target, navHints: others.map((s) => ({ screen_id: s.screen_id, title: s.title })) };
}

function m3Lines(screen, t, out) {
  const doc = screen.doc;
  const frame = doc.frame || {};
  out.push(`- ${t.size}: ${frame.w ?? '?'}×${frame.h ?? '?'}`);
  if (frame.bg) out.push(`- ${t.background}: ${frame.bg}`);
  if (frame.length !== undefined && Number(frame.length) > Number(frame.h || 0)) {
    out.push(`- ${t.scroll}: ${frame.length}`);
  }
  if (frame.note) out.push(`- ${t.note}: ${clip(frame.note, 200)}`);
  for (const group of doc.groups ?? []) {
    const name = group.name || group.id || 'group';
    const axis = group.axis || (group.free ? 'free' : 'x');
    out.push(`- ${t.group} ${group.id ? `\`${group.id}\`` : ''} ${clip(name, 60)} (axis=${axis})`);
    for (const item of group.items ?? []) {
      if (item?.hidden) continue;
      const bits = [`${t.item} \`${item.id}\``, `kind=${item.kind || 'box'}`];
      const text = itemText(item);
      if (text) bits.push(`text="${clip(text)}"`);
      if (item.variant) bits.push(`variant=${item.variant}`);
      if (item.fill) bits.push(`fill=${item.fill}`);
      if (item.icon) bits.push(`icon=${item.icon}`);
      if (item.note) bits.push(`note="${clip(item.note, 120)}"`);
      out.push(`  - ${bits.join(' · ')}`);
    }
  }
  if (!(doc.groups ?? []).length) out.push(`- ${t.group}: —`);
}

function legacyLines(screen, t, out) {
  const doc = screen.doc;
  out.push(`- format: node-tree (legacy readonly source)`);
  if (!doc?.root) {
    out.push(`- ${t.group}: —`);
    return;
  }
  let count = 0;
  const visit = (node, depth) => {
    if (!node || count >= 400) return;
    count++;
    const text = typeof node.props?.text === 'string' ? clip(node.props.text, 120) : '';
    const anchor = node.props?.attrs?.['data-anchor'];
    const bits = [`tag=${node.tag || 'div'}`];
    if (node.id) bits.push(`node=${node.id}`);
    if (anchor) bits.push(`anchor=${anchor}`);
    if (text) bits.push(`text="${text}"`);
    out.push(`${'  '.repeat(Math.min(depth, 8))}- ${bits.join(' · ')}`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(doc.root, 1);
}

function describeEdge(edge, t, titles, labelOf) {
  const src = titles.get(edge.source_screen_id) || edge.source_screen_id;
  const hot = edge.source_item_id ? labelOf.get(`${edge.source_screen_id}\u0000${edge.source_item_id}`) : edge.source_slot;
  const from = hot ? `${src} / ${clip(hot, 80)}` : src;
  let to;
  if (edge.target_kind === 'link') to = `${t.edgeLink} ${edge.url || ''}`.trim();
  else if (edge.target_kind === 'back') to = t.edgeBack;
  else if (edge.target_screen_id) to = `${titles.get(edge.target_screen_id) || edge.target_screen_id}`;
  else to = edge.target_kind || 'screen';
  const bits = [`${t.edgeFrom} ${from} → ${to}`];
  bits.push(`${t.edgeTrigger}=${edge.trigger || 'click'}`);
  if (edge.trigger === 'swipe' && edge.direction) bits.push(`direction=${edge.direction}`);
  if (edge.transition && edge.transition !== 'none') bits.push(`${t.edgeTransition}=${edge.transition}`);
  if (edge.note) bits.push(`${t.edgeNote}="${clip(edge.note, 120)}"`);
  return bits.join(' · ');
}

/**
 * 生成自动 Prompt。
 *
 * @param {{
 *   project: object,
 *   screens: Array<object>,
 *   edges?: object[],
 *   lang?: string,
 *   screenId?: string|null,
 *   options?: string[],
 * }} input
 */
export function buildProjectPrompt({ project, screens = [], edges = [], lang = 'zh', screenId = null, options } = {}) {
  const l = normLang(lang);
  const t = L[l];
  const design = project?.design || {};
  const all = screensSorted(screens.map(normalizeScreen));
  const targetExists = screenId && all.some((s) => s.screen_id === screenId);
  const scope = targetExists ? 'screen' : 'project';
  const { body, navHints } = scopedScreens(all, targetExists ? screenId : null);
  const optionsList = Array.isArray(options) ? options : Array.isArray(design.promptOptions) ? design.promptOptions : [];

  const tokens = deriveDesignTokens(design);
  const theme = themeSummary(design.theme);
  const hasDesktop = all.some((s) => Number(s.doc?.frame?.w) >= 1000);
  const platform = hasDesktop ? 'web' : design.platform || 'android';

  const lines = [];
  const marks = [];
  const mark = (kind, id, title) => marks.push({ kind, id, title, line: lines.length + 1 });
  const push = (...xs) => lines.push(...xs);
  const section = (label) => {
    if (lines.length) push('');
    push(`## ${label}`);
    mark('section', label, label);
  };

  push(`# ${t.title}`);
  push('');
  push(`> ${t.intro}`);
  push('');
  push(`- ${t.scopeProject} / ${t.scopeScreen}: ${scope === 'screen' ? t.scopeScreen : t.scopeProject}`);
  push(`- ${t.language}: ${l}`);
  push(`- ${t.platform}: ${platform}`);
  push(`- ${t.project}: ${clip(design.title || project?.name || 'Untitled', 120)}`);

  section(t.goal);
  if (design.title) push(`- ${t.project}: ${clip(design.title, 120)}`);
  if (project?.name) push(`- ${t.brief}: ${clip(design.brief || project.name, 400)}`);
  else if (design.brief) push(`- ${t.brief}: ${clip(design.brief, 400)}`);
  push(`- ${t.platform}: ${platform}`);
  if (scope === 'screen' && targetExists) {
    const s = body[0];
    push(`- ${t.scopeScreen}: ${clip(s?.title || screenId, 120)}`);
  }

  section(t.colors);
  push(`- ${t.palette}: ${design.paletteKey || 'purple'}`);
  if (design.customPalette?.primary) push(`- ${t.primary}: ${design.customPalette.primary}`);
  if (tokens?.colors?.primary) push(`- primary token: ${tokens.colors.primary}`);
  if (tokens?.colors?.surface) push(`- surface token: ${tokens.colors.surface}`);
  if (tokens?.radius) push(`- radius: sm=${tokens.radius.sm} / md=${tokens.radius.md} / lg=${tokens.radius.lg}`);
  if (tokens?.font?.family) push(`- font family: ${tokens.font.family}`);
  push(`- ${t.dynamicColor}: ${design.dynamicColor ? 'on' : 'off'}`);

  section(t.theme);
  push(`- ${t.dark}: ${theme.dark ? 'on' : 'off'}`);
  push(`- ${t.bothModes}: ${theme.bothModes ? 'on' : 'off'}`);
  push(`- ${t.contrast}: ${theme.contrast}`);
  push(`- ${t.shape}: ${theme.shape}`);
  push(`- ${t.font}: ${theme.font}`);
  push(`- ${t.emphasized}: ${theme.emphasized ? 'on' : 'off'}`);
  push(`- ${t.motion}: ${theme.motion}`);

  section(t.layout);
  if (!body.length) {
    push(`- ${t.noScreens}`);
  } else {
    for (const s of body) {
      push('');
      push(`### ${t.screen}: ${clip(s.title, 120)}`);
      mark('screen', s.screen_id, s.title);
      if (s.remark) push(`- ${t.note}: ${clip(s.remark, 200)}`);
      if (s.doc?.format === 'm3') m3Lines(s, t, lines);
      else if (s.doc?.root) legacyLines(s, t, lines);
      else {
        push(`- ${t.size}: ${project?.device?.width ?? '?'}×${project?.device?.height ?? '?'}`);
        push(`- ${t.group}: —`);
      }
    }
  }
  if (scope === 'screen' && navHints.length) {
    push('');
    push(`#### ${t.navHints}`);
    for (const h of navHints) push(`- ${clip(h.title, 60)}`);
  }

  section(t.behavior);
  const titles = new Map(all.map((s) => [s.screen_id, s.title]));
  const labelOf = new Map();
  for (const s of all) {
    for (const g of s.doc?.groups ?? []) {
      for (const i of g.items ?? []) if (i?.id) labelOf.set(`${s.screen_id}\u0000${i.id}`, itemText(i));
    }
  }
  const confirmed = edges.filter((e) => !e.status || e.status === 'confirmed');
  const relevant = scope === 'screen' ? confirmed.filter((e) => e.source_screen_id === screenId) : confirmed;
  if (!relevant.length) {
    push(`- ${t.noEdges}`);
  } else {
    for (const edge of relevant) push(`- ${describeEdge(edge, t, titles, labelOf)}`);
  }

  section(t.style);
  push(`- Material 3 · ${t.shape}=${theme.shape} · ${t.font}=${theme.font} · ${t.motion}=${theme.motion}`);
  push(
    `- ${platform === 'web' ? 'Responsive web layout with keyboard navigation and hover/focus states.' : 'Android-style touch layout with 48dp minimum hit targets.'}`
  );
  if (theme.bothModes) push('- Provide both light and dark color schemes.');
  if (theme.emphasized) push('- Use emphasized typography for primary headings.');
  if (design.dynamicColor) push('- Apply dynamic color from the platform wallpaper when available, with the project palette as fallback.');

  section(t.general);
  for (const item of t.generalItems) push(`- ${item}`);

  section(t.options);
  if (!optionsList.length) push(`- ${t.optionsEmpty}`);
  else {
    optionsList.forEach((opt, i) => {
      const key = String(opt);
      const text = t.optionLabels[key] || key;
      push(`${i + 1}. ${text} \`${key}\``);
    });
  }

  let markdown = redactSecrets(lines.join('\n'));
  const redacted = markdown.redacted;
  markdown = markdown.text;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  const warnings = [];
  if (bytes > PROMPT_MAX_BYTES) {
    warnings.push({
      code: 'PROMPT_TOO_LARGE',
      message: t.tooLarge,
      bytes,
      limit: PROMPT_MAX_BYTES,
    });
  }
  if (redacted) warnings.push({ code: 'PROMPT_REDACTED', message: t.redacted });

  return {
    lang: l,
    scope,
    screen_id: scope === 'screen' ? screenId : null,
    platform,
    edited: false,
    markdown,
    digest: sha256(markdown),
    chars: markdown.length,
    bytes,
    marks,
    warnings,
  };
}

/** promptEdit 优先（AI-025）；重置 = 传 null，恢复自动生成 */
export function applyPromptEdit(auto, promptEdit, lang = 'zh') {
  if (typeof promptEdit !== 'string' || !promptEdit.trim()) return auto;
  const text = redactSecrets(promptEdit).text;
  const bytes = Buffer.byteLength(text, 'utf8');
  const l = normLang(lang);
  const warnings = [];
  if (bytes > PROMPT_MAX_BYTES) warnings.push({ code: 'PROMPT_TOO_LARGE', message: L[l].tooLarge, bytes, limit: PROMPT_MAX_BYTES });
  return {
    ...auto,
    edited: true,
    markdown: text,
    digest: sha256(text),
    chars: text.length,
    bytes,
    // 手工编辑后自动行号标记不再可信（FR-PROMPT-007）
    marks: [],
    warnings,
  };
}

/**
 * Agent 指南（FR-PROMPT-008 / AI-028）：把约束、schema 与交付要求写成可执行说明。
 * 与 Prompt 包里的 design.json 配合使用。
 */
export function buildAgentGuide({ project, lang = 'zh' } = {}) {
  const design = project?.design || {};
  const name = clip(design.title || project?.name || 'Project', 120);
  const l = normLang(lang);
  const title = { zh: '编码 Agent 指南', en: 'Coding Agent Guide', ja: 'コーディングエージェントガイド', ko: '코딩 에이전트 가이드' }[l];
  return `# ${title}

## Context

- Project: ${name}
- Platform: ${design.platform === 'web' ? 'web' : 'android'}
- Design language: Material 3

## Inputs in this pack

- \`prompt.md\` — the implementation brief. Treat it as the source of truth.
- \`design.json\` — M3E-compatible project document (\`m3studio/project@1\`) with frames, groups, items and actions.
- \`README.md\` — how to consume this pack.

## Hard constraints

1. Do not read or invent screens, items or links that are absent from \`design.json\`.
2. Keep every \`frame.id\`, \`group.id\` and \`item.id\` stable when mapping design to code.
3. A clickable item may have \`action\` (single target) or \`actions\` (slot → target). Targets are one of \`{to: screenId}\`, \`{to: "back"}\` or \`{to: "link", url}\`.
4. Screen transitions must preserve browser/app back behavior. Never create a dead end.
5. Use the theme tokens from \`design.json\` (\`paletteKey\`, \`customPalette\`, \`dynamicColor\`, \`theme\`). Do not hardcode unrelated colors.
6. Never include API keys, server paths, environment values or other project data in generated code.

## Suggested implementation order

1. Create the app shell and theme provider from \`theme\` + palette.
2. Render frames in project order; use the frame size as the viewport contract.
3. Map groups to layout containers and items to Material 3 components.
4. Wire confirmed edges to navigation actions.
5. Add responsive behavior for web / touch behavior for Android.
6. Verify every screen is reachable from the start screen and can go back.

## Minimal action example

\`\`\`json
{
  "id": "login_button",
  "kind": "button",
  "label": "Sign in",
  "variant": "filled",
  "action": { "to": "scr_home", "transition": "slide" }
}
\`\`\`
`;
}

/** Prompt 包 README（FR-EXPORT-006） */
export function buildReadme({ project, lang = 'zh', files = [] } = {}) {
  const name = clip(project?.design?.title || project?.name || 'Project', 120);
  const l = normLang(lang);
  const title = { zh: 'Prompt 包说明', en: 'Prompt Pack', ja: 'Prompt パッケージ', ko: 'Prompt 패키지' }[l];
  return `# ${title}

- Project: ${name}
- Language: ${l}
- Files: ${files.map((f) => `\`${f}\``).join(', ')}

## Usage

1. Give \`prompt.md\` and \`agent.md\` to your coding agent.
2. Keep \`design.json\` as the machine-readable contract; it follows the M3E project schema and can be opened by M3E-compatible tools.
3. Do not modify ids in \`design.json\` when generating code; map them to components instead.

## Notes

- The pack is deterministic for the same design data and options.
- Single-screen packs intentionally omit other screens' bodies.
- No API keys, server paths or other project data are included.
`;
}

/** 安全过滤：明显密钥、环境变量与本地绝对路径不进入 Prompt/包 */
export function redactSecrets(input) {
  let text = String(input ?? '');
  let redacted = false;
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
    /\b(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}["']?/gi,
  ];
  for (const re of patterns) {
    text = text.replace(re, (m) => {
      redacted = true;
      return m.includes(':') || m.includes('=') ? m.replace(/[:=].*$/, ': [REDACTED]') : '[REDACTED]';
    });
  }
  // Windows / POSIX 绝对路径（只处理明显包含用户目录或盘符的片段）
  const pathRe = /\b[A-Za-z]:\\(?:[^\\\s]+\\){1,}[^\\\s]*|\/(?:home|Users|root|var|opt)\/[^\s"'`]+/g;
  text = text.replace(pathRe, () => {
    redacted = true;
    return '[REDACTED_PATH]';
  });
  return { text, redacted };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}
