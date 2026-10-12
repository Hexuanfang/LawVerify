export function sendSuccess(response, data, meta) {
    response.json({
        success: true,
        requestId: response.locals.requestId,
        data,
        meta,
    });
}
export function sendLegacyError(response, statusCode, message) {
    response.status(statusCode).json({ message });
}
