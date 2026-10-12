import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../core/app-error.js'
import { verifyToken } from '../commercial/auth-service.js'
import { hasPermission, type Permission } from '../commercial/rbac.js'
import type { AuthenticatedActor } from '../commercial/types.js'

declare module 'express-serve-static-core' {
  interface Request {
    actor?: AuthenticatedActor
  }
}

export function authenticate(request: Request, _response: Response, next: NextFunction) {
  const authorization = request.header('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    next(new AppError('请先登录。', 401, 'UNAUTHORIZED'))
    return
  }

  try {
    const token = authorization.slice('Bearer '.length).trim()
    const claims = verifyToken(token)
    request.actor = {
      userId: claims.sub,
      organizationId: claims.organizationId,
      membershipId: claims.membershipId,
      role: claims.role,
      email: claims.email,
    }
    next()
  } catch {
    next(new AppError('登录态已失效，请重新登录。', 401, 'INVALID_TOKEN'))
  }
}

export function requirePermission(permission: Permission) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.actor) {
      next(new AppError('请先登录。', 401, 'UNAUTHORIZED'))
      return
    }

    if (!hasPermission(request.actor.role, permission)) {
      next(new AppError('当前账号没有该操作权限。', 403, 'FORBIDDEN'))
      return
    }

    next()
  }
}
