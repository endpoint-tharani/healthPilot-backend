import { Request } from 'express';
import { BranchScopeType, UserRole } from '@prisma/client';
import { PermissionValue } from '../constants/permissions';
import { unauthorized } from '../utils/errors';

/**
 * Server-derived request identity. Every field comes from the verified access
 * token plus a fresh database read - never from client input.
 */
export interface AuthContext {
  userId: string;
  companyId: string;
  role: UserRole;
  scopeType: BranchScopeType;
  /** Empty when scopeType is ALL_BRANCHES; callers must check hasAllBranches first. */
  allowedBranchIds: string[];
  hasAllBranches: boolean;
  /** Drives the procurement-document read rule in the authorization service. */
  hasCentralWarehouseAccess: boolean;
  permissions: PermissionValue[];
}

export function setAuthContext(req: Request, context: AuthContext): void {
  req.auth = context;
}

export function getAuthContext(req: Request): AuthContext | undefined {
  return req.auth;
}

/** Use inside controllers, where authentication middleware has already run. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw unauthorized();
  }
  return req.auth;
}

export function hasPermission(auth: AuthContext, permission: PermissionValue): boolean {
  return auth.permissions.includes(permission);
}
