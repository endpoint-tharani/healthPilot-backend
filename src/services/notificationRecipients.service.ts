import { BranchScopeType, BranchType, Prisma, UserRole } from '@prisma/client';
import { Database, prisma } from '../database/prisma';
import { PermissionValue, ROLE_PERMISSIONS } from '../constants/permissions';

/**
 * Who should be told about a business event.
 *
 * Recipients are never hard-coded to a role or a named user. They are derived
 * from the same two rules the API already authorises reads with - does this user
 * hold the permission that makes the event actionable, and is the branch the
 * event happened at inside their scope - so a permission change or a branch
 * reassignment moves notifications with it and no rule is written down twice.
 */

/** Roles whose permission set contains every one of the required permissions. */
function rolesWith(permissions: PermissionValue[]): UserRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((role) =>
    permissions.every((permission) => ROLE_PERMISSIONS[role].includes(permission))
  );
}

export interface RecipientQuery {
  companyId: string;
  /** The event is only actionable by users holding all of these. */
  permissions: PermissionValue[];
  /** Branches the event touched. Empty means company-wide within the permission. */
  branchIds?: string[];
  /**
   * Also reach users who hold the central warehouse in scope. This mirrors the
   * procurement read rule: a requirement raised by a branch is addressed to
   * central procurement, who do not have that branch in their own scope.
   */
  includeCentralWarehouse?: boolean;
  /** The actor, and anyone already notified by a more specific rule. */
  excludeUserIds?: string[];
}

/**
 * Resolves a query to user ids. Inactive users are skipped - a deactivated
 * account cannot act on anything - and the caller's own id is excluded so nobody
 * is notified of their own action.
 */
export async function resolveRecipients(
  query: RecipientQuery,
  db: Database = prisma
): Promise<string[]> {
  const roles = rolesWith(query.permissions);
  if (roles.length === 0) {
    return [];
  }

  const branchIds = (query.branchIds ?? []).filter(Boolean);
  const scopeClauses: Prisma.UserWhereInput[] = [];

  if (branchIds.length > 0) {
    scopeClauses.push(
      { branchId: { in: branchIds } },
      { branchAccess: { some: { branchId: { in: branchIds } } } }
    );
  }
  if (query.includeCentralWarehouse) {
    scopeClauses.push(
      { branch: { type: BranchType.CENTRAL_WAREHOUSE } },
      { branchAccess: { some: { branch: { type: BranchType.CENTRAL_WAREHOUSE } } } }
    );
  }
  // A user who can already read every branch is in scope for any branch, so the
  // ALL_BRANCHES clause joins whatever branch restriction the caller asked for.
  if (scopeClauses.length > 0) {
    scopeClauses.push({ branchScope: BranchScopeType.ALL_BRANCHES });
  }

  const users = await db.user.findMany({
    where: {
      companyId: query.companyId,
      isActive: true,
      role: { in: roles },
      ...(query.excludeUserIds?.length ? { id: { notIn: query.excludeUserIds } } : {}),
      // No branch restriction at all: the event concerns everyone who holds the
      // permission, and branch scope adds nothing to decide.
      ...(scopeClauses.length > 0 ? { OR: scopeClauses } : {}),
    },
    select: { id: true },
  });

  return users.map((user) => user.id);
}

/**
 * A specific user, kept only if they may still act: active, in the company, and
 * holding the permission the notification is about. Used for the "tell the person
 * who raised it" rules, where the recipient is known but must still be checked.
 */
export async function resolveNamedRecipient(
  companyId: string,
  userId: string | null | undefined,
  permissions: PermissionValue[],
  db: Database = prisma
): Promise<string[]> {
  if (!userId) {
    return [];
  }
  const roles = rolesWith(permissions);
  const user = await db.user.findFirst({
    where: { id: userId, companyId, isActive: true, role: { in: roles } },
    select: { id: true },
  });
  return user ? [user.id] : [];
}

/** Union of several resolver results, with the actor and duplicates removed. */
export function mergeRecipients(actorUserId: string, ...groups: string[][]): string[] {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const id of group) {
      if (id !== actorUserId) {
        seen.add(id);
      }
    }
  }
  return [...seen];
}
