import crypto from 'crypto';
import { BranchScopeType, BranchType, Prisma, UserRole } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { config } from '../config/env';
import { hashPassword, verifyPassword } from '../utils/password';
import { signAccessToken } from '../utils/jwt';
import { durationToMs } from '../utils/duration';
import { conflict, forbidden, notFound, unauthorized } from '../utils/errors';
import { permissionsForRole } from '../constants/permissions';
import { logger } from '../loggers';
import { initializeCompanyAccounting } from './accounting/chartOfAccounts.service';

export interface LoginInput {
  email: string;
  password: string;
}

export interface SignupInput {
  company: { name: string; code?: string };
  admin: { name: string; email: string; password: string };
  branches: { code: string; name: string; type: BranchType; address?: string }[];
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * Refresh tokens are random 256-bit secrets. Only a SHA-256 digest is stored, so
 * a database leak cannot yield usable tokens, yet lookup stays a single indexed
 * read (bcrypt would force a table scan and make reuse detection impossible).
 */
function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueTokens(
  user: { id: string; companyId: string; role: string },
  userAgent?: string,
  replacesTokenId?: string
): Promise<IssuedTokens> {
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + durationToMs(config.refreshTokenExpiresIn));

  const created = await prisma.refreshToken.create({
    data: {
      tokenHash: digest(refreshToken),
      userId: user.id,
      expiresAt,
      userAgent: userAgent?.slice(0, 255),
    },
  });

  if (replacesTokenId) {
    await prisma.refreshToken.update({
      where: { id: replacesTokenId },
      data: { replacedByTokenId: created.id },
    });
  }

  return {
    accessToken: signAccessToken(user.id, user.companyId, user.role),
    refreshToken,
    expiresIn: config.accessTokenExpiresIn,
  };
}

/** Company codes are globally unique, so one is derived when the caller omits it. */
function companyCodeFromName(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `COMP-${slug || 'COMPANY'}`;
}

async function availableCompanyCode(base: string): Promise<string> {
  const taken = await prisma.company.findMany({
    where: { code: { startsWith: base } },
    select: { code: true },
  });
  const used = new Set(taken.map((c) => c.code));
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw conflict('Could not derive a unique company code; please supply one');
}

/**
 * Two signups racing on the same email or company code both clear their
 * pre-checks and one loses at the unique index. Translate that into the same 409
 * the pre-check would have produced rather than a 500.
 */
function translateSignupConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = Array.isArray(error.meta?.target)
      ? (error.meta.target as string[]).join(',')
      : String(error.meta?.target ?? '');
    if (target.includes('email')) {
      throw conflict('An account with this email already exists');
    }
    throw conflict('That company code is already taken');
  }
  throw error;
}

/**
 * Self-service tenant creation. The company, its branches and the founding
 * COMPANY_ADMIN are written in one transaction, so a half-built tenant can never
 * be left behind, and the caller is signed in with the same tokens login issues.
 */
export async function signup(input: SignupInput, userAgent?: string) {
  if (!config.allowPublicSignup) {
    throw forbidden('Self-service signup is disabled on this deployment');
  }

  const email = input.admin.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    throw conflict('An account with this email already exists');
  }

  const requestedCode = input.company.code?.trim();
  if (requestedCode) {
    const taken = await prisma.company.findUnique({
      where: { code: requestedCode },
      select: { id: true },
    });
    if (taken) {
      throw conflict(`A company with code ${requestedCode} already exists`);
    }
  }
  const companyCode =
    requestedCode ?? (await availableCompanyCode(companyCodeFromName(input.company.name)));

  // Hashing stays outside the transaction: bcrypt at 12 rounds would otherwise
  // hold it open for the whole hash.
  const passwordHash = await hashPassword(input.admin.password);

  const result = await transaction(async (tx) => {
    const company = await tx.company.create({
      data: { code: companyCode, name: input.company.name },
    });

    await tx.branch.createMany({
      data: input.branches.map((branch) => ({
        companyId: company.id,
        code: branch.code,
        name: branch.name,
        type: branch.type,
        address: branch.address,
      })),
    });

    const branches = await tx.branch.findMany({
      where: { companyId: company.id },
      select: { id: true, code: true, name: true, type: true, address: true },
      orderBy: { code: 'asc' },
    });

    // The founding admin owns every branch of the tenant it just created, so the
    // scope is ALL_BRANCHES and no per-branch access rows are needed.
    const user = await tx.user.create({
      data: {
        companyId: company.id,
        email,
        name: input.admin.name,
        role: UserRole.COMPANY_ADMIN,
        passwordHash,
        branchScope: BranchScopeType.ALL_BRANCHES,
        branchId: null,
      },
    });

    return { company, branches, user };
  }).catch(translateSignupConflict);

  // A new tenant gets its chart of accounts as part of being set up, rather than
  // waiting for somebody to remember. Until now a company existed with no books at
  // all, and the first supplier invoice was where that was discovered.
  //
  // Deliberately after the commit rather than inside it: initialisation writes a
  // few hundred rows of reporting hierarchy, and folding that into the signup
  // transaction would put the tenant's whole registration at the mercy of it. It
  // is also idempotent, so the recovery when it does fail is simply to run it
  // again - which is what the "Initialize Accounting" action on the chart of
  // accounts page does.
  const accounting = await initializeTenantAccounting(result.company.id, result.company.code);

  const tokens = await issueTokens(result.user, userAgent);
  return {
    ...tokens,
    user: publicUser(result.user),
    company: { id: result.company.id, code: result.company.code, name: result.company.name },
    branches: result.branches,
    accounting,
  };
}

/**
 * Initialises a new tenant's books, and never fails the signup over it.
 *
 * A company that could not be registered because its chart of accounts did not
 * build is a worse outcome than a company that has to press one button. The
 * result says which happened, so the caller is told rather than left to guess.
 */
async function initializeTenantAccounting(
  companyId: string,
  companyCode: string
): Promise<{ initialized: boolean; templateKey: string | null; error: string | null }> {
  try {
    const chart = await initializeCompanyAccounting(companyId);
    logger.info('New tenant accounting initialised', {
      company: companyCode,
      template: chart.templateKey + '@' + chart.templateVersion,
      ledgers: chart.total.ledgers,
      mappings: chart.total.mappings,
    });
    return { initialized: true, templateKey: chart.templateKey, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error('New tenant created without a chart of accounts', {
      company: companyCode,
      companyId,
      reason,
    });
    return { initialized: false, templateKey: null, error: reason };
  }
}

export async function login(input: LoginInput, userAgent?: string) {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
    include: { company: { select: { isActive: true } } },
  });

  // Uniform message: never reveal whether the email exists.
  const invalid = unauthorized('Invalid credentials');
  if (!user) {
    throw invalid;
  }

  const passwordMatches = await verifyPassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw invalid;
  }
  if (!user.isActive) {
    throw unauthorized('User account is inactive', 'ACCOUNT_INACTIVE');
  }
  if (!user.company.isActive) {
    throw unauthorized('Company account is inactive', 'ACCOUNT_INACTIVE');
  }

  const tokens = await issueTokens(user, userAgent);
  return { ...tokens, user: publicUser(user) };
}

/**
 * Rotation with reuse detection: a presented token is consumed exactly once.
 * Replaying a rotated token revokes the whole session family.
 */
export async function refresh(refreshToken: string, userAgent?: string) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: digest(refreshToken) },
    include: { user: { include: { company: { select: { isActive: true } } } } },
  });

  if (!record) {
    throw unauthorized('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
  }

  if (record.revoked) {
    await prisma.refreshToken.updateMany({
      where: { userId: record.userId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
    throw unauthorized('Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
  }

  if (record.expiresAt <= new Date()) {
    throw unauthorized('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }
  if (!record.user.isActive || !record.user.company.isActive) {
    throw unauthorized('Account is inactive', 'ACCOUNT_INACTIVE');
  }

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revoked: true, revokedAt: new Date() },
  });

  const tokens = await issueTokens(record.user, userAgent, record.id);
  return { ...tokens, user: publicUser(record.user) };
}

export async function logout(refreshToken: string) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: digest(refreshToken), revoked: false },
    data: { revoked: true, revokedAt: new Date() },
  });
}

export async function logoutAllSessions(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true, revokedAt: new Date() },
  });
}

export async function me(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      branch: { select: { id: true, code: true, name: true, type: true } },
      branchAccess: { select: { branchId: true } },
    },
  });
  if (!user) {
    throw notFound('User not found');
  }

  return {
    ...publicUser(user),
    branch: user.branch,
    scopeType: user.branchScope,
    allowedBranchIds:
      user.branchScope === 'ALL_BRANCHES'
        ? null
        : Array.from(
            new Set([
              ...(user.branchId ? [user.branchId] : []),
              ...user.branchAccess.map((a) => a.branchId),
            ])
          ),
    permissions: permissionsForRole(user.role),
  };
}

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  companyId: string;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
}
