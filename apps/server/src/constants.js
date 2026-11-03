export const ERR = {
  BAD_REQUEST: { code: 'BAD_REQUEST', status: 400 },
  NO_PERMISSION: { code: 'NO_PERMISSION', status: 403 },
  FORBIDDEN_TARGET: { code: 'FORBIDDEN_TARGET', status: 403 },
  NOT_FOUND: { code: 'NOT_FOUND', status: 404 },
  CONFLICT: { code: 'CONFLICT', status: 409 },
  LOCKED: { code: 'SCREEN_LOCKED', status: 423 },
  MODEL_FAILED: { code: 'MODEL_FAILED', status: 502 },
  INVALID_OUTPUT: { code: 'INVALID_OUTPUT', status: 422 },
  UNPROCESSABLE: { code: 'UNPROCESSABLE', status: 422 },
};

export const EDIT_SCOPES = ['screen', 'region', 'component'];

/** 画布节点尺寸（逻辑像素） */
export const DEFAULT_NODE = { width: 375, height: 812 };
