export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(message, statusCode = 400, code = 'APP_ERROR', details) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}
function resolveErrorStatusCode(error) {
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600) {
        return error.statusCode;
    }
    if (typeof error.status === 'number' && error.status >= 400 && error.status < 600) {
        return error.status;
    }
    return 400;
}
export function toAppError(error, fallbackMessage = '服务器处理失败') {
    if (error instanceof AppError) {
        return error;
    }
    if (error instanceof Error) {
        const typedError = error;
        if (typedError.type === 'entity.too.large'
            || typedError.status === 413
            || typedError.statusCode === 413) {
            return new AppError('所选文件夹内容过大，请拆分后再导入。', 413, 'PAYLOAD_TOO_LARGE');
        }
        return new AppError(error.message || fallbackMessage, resolveErrorStatusCode(typedError), 'BUSINESS_ERROR');
    }
    return new AppError(fallbackMessage, 500, 'UNKNOWN_ERROR');
}
