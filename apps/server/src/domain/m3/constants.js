/**
 * M3 语义模型常量（M0 spike）
 *
 * 这里的白名单直接对齐 m3e-canvas v0.1 的 `lib/tokens.ts`：
 *  - 36 种 Kind
 *  - 5 种 Variant
 *  - 10 个 ColorToken
 *  - 4 种 Place / 7 种 Transition
 *
 * M0 只做契约与往返验证，不引入 React / TypeScript 依赖。
 */

export const SCREEN_SCHEMA = 'm3studio/screen@1';
export const PROJECT_SCHEMA = 'm3studio/project@1';
export const FLOW_SCHEMA_VERSION = 2;
export const BRIDGE_PROTOCOL = 'm3studio/editor@1';
export const BRIDGE_VERSION = 1;

/** m3e-canvas `Kind` 联合类型，顺序与 tokens.ts 保持一致 */
export const KINDS = Object.freeze([
  'box',
  'bottomSheet',
  'button',
  'iconButton',
  'fab',
  'extendedFab',
  'chip',
  'topAppBar',
  'bottomNav',
  'navRail',
  'searchBar',
  'card',
  'listItem',
  'dialog',
  'snackbar',
  'textField',
  'select',
  'switch',
  'checkbox',
  'slider',
  'text',
  'image',
  'camera',
  'map',
  'divider',
  'loadingIndicator',
  'linearProgress',
  'circularProgress',
  'splitButton',
  'fabMenu',
  'toolbar',
  'tabs',
  'radio',
  'carousel',
  'datePicker',
  'timePicker',
]);

export const KIND_SET = new Set(KINDS);

export const VARIANTS = Object.freeze(['filled', 'tonal', 'elevated', 'outlined', 'text']);
export const VARIANT_SET = new Set(VARIANTS);

/** 只允许持久化主题角色名，不持久化具体色值（主题在项目级维护） */
export const COLOR_TOKENS = Object.freeze([
  'surface',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'primaryContainer',
  'secondaryContainer',
  'tertiaryContainer',
  'primary',
  'inverseSurface',
]);
export const COLOR_TOKEN_SET = new Set(COLOR_TOKENS);

export const TEXT_TOKENS = Object.freeze([
  'primary',
  'secondary',
  'onSurface',
  'onSurfaceVariant',
  'onPrimaryContainer',
  'onSecondaryContainer',
  'onTertiaryContainer',
  'inverseOnSurface',
]);
export const TEXT_TOKEN_SET = new Set(TEXT_TOKENS);

export const CARD_IMAGE_POSITIONS = Object.freeze(['top', 'bottom', 'leading', 'trailing', 'background']);
export const CARD_IMAGE_POSITION_SET = new Set(CARD_IMAGE_POSITIONS);

export const CARD_ALIGNS = Object.freeze(['start', 'center', 'end']);
export const CARD_ALIGN_SET = new Set(CARD_ALIGNS);

/** carousel / date picker / time picker 的布局取值 */
export const PART_LAYOUTS = Object.freeze([
  'multiBrowse',
  'uncontained',
  'hero',
  'fullScreen',
  'modal',
  'docked',
  'input',
  'dial',
]);
export const PART_LAYOUT_SET = new Set(PART_LAYOUTS);

export const PLACES = Object.freeze(['top', 'center', 'bottom', 'spread']);
export const PLACE_SET = new Set(PLACES);

export const TRANSITIONS = Object.freeze(['slide', 'slideLeft', 'slideUp', 'slideDown', 'fade', 'expand', 'none']);
export const TRANSITION_SET = new Set(TRANSITIONS);

export const TARGET_KINDS = Object.freeze(['screen', 'back', 'link', 'menu', 'toggle']);
export const TARGET_KIND_SET = new Set(TARGET_KINDS);

export const EDGE_STATUS = Object.freeze(['candidate', 'confirmed']);
export const EDGE_STATUS_SET = new Set(EDGE_STATUS);

/**
 * V4.1：trigger 只表达“如何触发”，不再承载目标类型。
 * menu/toggle 属于 target_kind；swipe 通过 trigger + direction 表达。
 */
export const TRIGGERS = Object.freeze(['click', 'swipe', 'auto']);
export const TRIGGER_SET = new Set(TRIGGERS);

export const SWIPE_DIRS = Object.freeze(['left', 'right', 'up', 'down']);
export const SWIPE_DIR_SET = new Set(SWIPE_DIRS);

/** Group.axis：V4.1 新增 "free"，自由组内 Item 使用独立坐标 */
export const GROUP_AXES = Object.freeze(['x', 'y', 'free']);
export const GROUP_AXIS_SET = new Set(GROUP_AXES);

/** 热区 slot 命名：导入/导出与孤儿边 slot_missing 判定共用 */
export const SLOT_PATTERN = /^(?:icon2?|trailing|main|menu|action(?::\d+)?|tab:\d+|item:\d+|seg:\d+|crumb:\d+)$/;

/** 孤儿边动态计算原因（FR-FLOW-007 / DC-039），不写入 flow.json */
export const ORPHAN_REASONS = Object.freeze([
  'source_missing',
  'target_missing',
  'item_missing',
  'slot_missing',
]);

export const SWIPE_TRANSITION = Object.freeze({
  left: 'slide',
  right: 'slideLeft',
  up: 'slideUp',
  down: 'slideDown',
});

export const PLATFORMS = Object.freeze(['android', 'web']);
export const PLATFORM_SET = new Set(PLATFORMS);

export const DEFAULT_THEME = Object.freeze({
  dark: false,
  bothModes: false,
  contrast: 'standard',
  shape: 'rounded',
  font: 'roboto',
  emphasized: false,
  motion: 'standard',
});

export const THEME_VALUES = Object.freeze({
  contrast: ['standard', 'medium', 'high'],
  shape: ['square', 'rounded', 'full'],
  font: ['roboto', 'robotoFlex', 'robotoSerif', 'system'],
  motion: ['standard', 'expressive'],
});

/** M3E 默认设备尺寸（dp） */
export const PHONE = Object.freeze({ w: 412, h: 892 });
export const DESKTOP = Object.freeze({ w: 1280, h: 800 });

/** 错误码：M0 不接 HTTP，只给后续 API 层复用 */
export const M3_ERR = Object.freeze({
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  BRIDGE_PROTOCOL_MISMATCH: 'BRIDGE_PROTOCOL_MISMATCH',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  BRIDGE_CONFLICT: 'BRIDGE_CONFLICT',
});
