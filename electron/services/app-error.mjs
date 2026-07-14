export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "客户端内部错误，请查看本地日志后重试。",
  };
}
