import { ERR } from './constants.js';

export class AppError extends Error {
  constructor(kind, message, detail = {}) {
    super(message || kind.code);
    this.kind = kind;
    this.code = kind.code;
    this.status = kind.status;
    this.detail = detail;
  }
}

export const badRequest = (m, d) => new AppError(ERR.BAD_REQUEST, m, d);
export const noPermission = (m, d) => new AppError(ERR.NO_PERMISSION, m, d);
export const notFound = (m) => new AppError(ERR.NOT_FOUND, m);
export const conflict = (m, d) => new AppError(ERR.CONFLICT, m, d);
export const locked = (m, d) => new AppError(ERR.LOCKED, m, d);
export const forbiddenTarget = (m, d) => new AppError(ERR.FORBIDDEN_TARGET, m, d);
export const invalidOutput = (m, d) => new AppError(ERR.INVALID_OUTPUT, m, d);
/** 语义上"没能理解"，与"输出非法"区分开，前端可据此给不同引导 */
export const unprocessable = (m, d) => new AppError(ERR.UNPROCESSABLE, m, d);
export const modelFailed = (m, d) => new AppError(ERR.MODEL_FAILED, m, d);
export const schemaInvalid = (m, d) => new AppError(ERR.SCHEMA_INVALID, m, d);
export const migrationUnsupported = (m, d) => new AppError(ERR.MIGRATION_UNSUPPORTED, m, d);
export const importTooLarge = (m, d) => new AppError(ERR.IMPORT_TOO_LARGE, m, d);
