import { AppError } from '../core/app-error.js';
import { verifyToken } from '../commercial/auth-service.js';
import { hasPermission } from '../commercial/rbac.js';
export function authenticate(request, _response, next) {
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
        next(new AppError('请先登录。', 401, 'UNAUTHORIZED'));
        return;
    }
    try {
        const token = authorization.slice('Bearer '.length).trim();
        const claims = verifyToken(token);
        request.actor = {
            userId: claims.sub,
            organizationId: claims.organizationId,
            membershipId: claims.membershipId,
            role: claims.role,
            email: claims.email,
        };
        next();
    }
    catch {
        next(new AppError('登录态已失效，请重新登录。', 401, 'INVALID_TOKEN'));
    }
}
export function requirePermission(permission) {
    return (request, _response, next) => {
        if (!request.actor) {
            next(new AppError('请先登录。', 401, 'UNAUTHORIZED'));
            return;
        }
        if (!hasPermission(request.actor.role, permission)) {
            next(new AppError('当前账号没有该操作权限。', 403, 'FORBIDDEN'));
            return;
        }
        next();
    };
}
