import { prisma } from '../database/prisma';
import { verifyAccessToken } from '../utils/jwt';
import { unauthorized } from '../utils/errors';
import { permissionsForRole } from '../constants/permissions';
import { AuthContext } from './authContext';

/**
 * Rebuilds the request identity from a bearer access token: the token is
 * verified, then the user record is re-read so a revoked session or a
 * deactivated account is rejected even while its token is still in date.
 *
 * Both entry points into the API share this - the HTTP middleware and the
 * Socket.IO handshake - so a socket can never be authorised on weaker terms
 * than a request, and no client-supplied companyId or branchId is ever trusted.
 */
export async function authContextFromAccessToken(token: string): Promise<AuthContext> {
  const claims = verifyAccessToken(token);

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    include: {
      company: { select: { isActive: true } },
      branch: { select: { id: true, type: true } },
      branchAccess: { select: { branch: { select: { id: true, type: true } } } },
    },
  });

  if (!user || !user.isActive || !user.company.isActive) {
    throw unauthorized('Account is no longer active');
  }
  if (user.companyId !== claims.companyId || user.role !== claims.role) {
    throw unauthorized('Token no longer matches the user record');
  }

  const hasAllBranches = user.branchScope === 'ALL_BRANCHES';
  const scopedBranches = [
    ...(user.branch ? [user.branch] : []),
    ...user.branchAccess.map((access) => access.branch),
  ];

  return {
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
    scopeType: user.branchScope,
    hasAllBranches,
    allowedBranchIds: hasAllBranches
      ? []
      : Array.from(new Set(scopedBranches.map((branch) => branch.id))),
    hasCentralWarehouseAccess:
      hasAllBranches || scopedBranches.some((branch) => branch.type === 'CENTRAL_WAREHOUSE'),
    permissions: permissionsForRole(user.role),
  };
}
