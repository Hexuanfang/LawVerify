import { sendLegacyError } from '../core/api-response.js';
import { toAppError } from '../core/app-error.js';
export function notFound(_request, response) {
    sendLegacyError(response, 404, '接口不存在');
}
export function errorHandler(error, _request, response, _next) {
    const appError = toAppError(error);
    response.status(appError.statusCode).json({
        success: false,
        requestId: response.locals.requestId,
        error: {
            code: appError.code,
            message: appError.message,
            details: appError.details,
        },
    });
}
