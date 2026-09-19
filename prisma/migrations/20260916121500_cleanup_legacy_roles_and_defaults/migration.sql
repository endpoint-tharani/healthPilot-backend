-- Retire the Part 1 role values in favour of the Part 2 role model, and drop
-- the placeholder defaults that allowed the auth columns to be backfilled.

UPDATE "User" SET "role" = 'COMPANY_ADMIN'    WHERE "role" = 'ADMIN';
UPDATE "User" SET "role" = 'CENTRAL_PHARMACY' WHERE "role" IN ('PURCHASE_OFFICER', 'WAREHOUSE_STAFF');
UPDATE "User" SET "role" = 'PHARMACIST'       WHERE "role" = 'BRANCH_STAFF';

ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'CENTRAL_PHARMACY', 'BRANCH_MANAGER', 'PHARMACIST', 'STAFF');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole" USING "role"::text::"UserRole";
DROP TYPE "UserRole_old";

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP DEFAULT;
ALTER TABLE "RefreshToken" ALTER COLUMN "updatedAt" DROP DEFAULT;
