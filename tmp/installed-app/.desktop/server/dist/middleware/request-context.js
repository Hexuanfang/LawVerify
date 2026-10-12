import { randomUUID } from 'node:crypto';
export function requestContext(request, response, next) {
    const requestId = request.header('x-request-id') || randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    next();
}
