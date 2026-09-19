-- Part 2: rename Location -> Branch (terminology only, no architectural change),
-- add branch-scope authorization, and per-company uniqueness for multi-tenancy.

-- 1. Enum rename: LocationType -> BranchType
ALTER TYPE "LocationType" RENAME TO "BranchType";

-- 2. New enum for user branch scope
DO $$ BEGIN
  CREATE TYPE "BranchScopeType" AS ENUM ('ALL_BRANCHES', 'SPECIFIC_BRANCHES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Table + column renames (data preserved)
ALTER TABLE "Location" RENAME TO "Branch";
ALTER TABLE "User" RENAME COLUMN "locationId" TO "branchId";
ALTER TABLE "Document" RENAME COLUMN "locationId" TO "branchId";
ALTER TABLE "Document" RENAME COLUMN "sourceLocationId" TO "sourceBranchId";
ALTER TABLE "Document" RENAME COLUMN "destinationLocationId" TO "destinationBranchId";
ALTER TABLE "InventoryTransaction" RENAME COLUMN "locationId" TO "branchId";
ALTER TABLE "Payment" RENAME COLUMN "locationId" TO "branchId";

-- 4. Rename constraints/indexes that carried the old name
ALTER TABLE "Branch" RENAME CONSTRAINT "Location_pkey" TO "Branch_pkey";
ALTER TABLE "Branch" RENAME CONSTRAINT "Location_companyId_fkey" TO "Branch_companyId_fkey";
ALTER TABLE "User" RENAME CONSTRAINT "User_locationId_fkey" TO "User_branchId_fkey";
ALTER TABLE "Document" RENAME CONSTRAINT "Document_locationId_fkey" TO "Document_branchId_fkey";
ALTER TABLE "Document" RENAME CONSTRAINT "Document_sourceLocationId_fkey" TO "Document_sourceBranchId_fkey";
ALTER TABLE "Document" RENAME CONSTRAINT "Document_destinationLocationId_fkey" TO "Document_destinationBranchId_fkey";
ALTER TABLE "InventoryTransaction" RENAME CONSTRAINT "InventoryTransaction_locationId_fkey" TO "InventoryTransaction_branchId_fkey";
ALTER TABLE "Payment" RENAME CONSTRAINT "Payment_locationId_fkey" TO "Payment_branchId_fkey";

DROP INDEX IF EXISTS "Location_code_key";
DROP INDEX IF EXISTS "Document_locationId_idx";
DROP INDEX IF EXISTS "InventoryTransaction_productId_batchId_locationId_stockStat_idx";
DROP INDEX IF EXISTS "InventoryTransaction_locationId_stockStatus_idx";

-- 5. Branch-scope authorization
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "branchScope" "BranchScopeType" NOT NULL DEFAULT 'SPECIFIC_BRANCHES';

CREATE TABLE IF NOT EXISTS "UserBranchAccess" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "branchId"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserBranchAccess_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserBranchAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserBranchAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserBranchAccess_userId_branchId_key" ON "UserBranchAccess"("userId", "branchId");
CREATE INDEX IF NOT EXISTS "UserBranchAccess_userId_idx" ON "UserBranchAccess"("userId");

-- 6. Company / Product master-data flags
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "trackInventory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Branch" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- 7. Dispensing traceability fields on the common document header
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "patientRef" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "prescriptionRef" TEXT;

-- 8. Per-company uniqueness (global unique codes/numbers break multi-tenancy)
DROP INDEX IF EXISTS "Product_code_key";
DROP INDEX IF EXISTS "Supplier_code_key";
DROP INDEX IF EXISTS "Batch_batchNumber_key";
DROP INDEX IF EXISTS "Document_documentNumber_key";
DROP INDEX IF EXISTS "Payment_paymentNumber_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Branch_companyId_code_key" ON "Branch"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_companyId_code_key" ON "Product"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_companyId_code_key" ON "Supplier"("companyId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Batch_productId_batchNumber_key" ON "Batch"("productId", "batchNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Document_companyId_documentNumber_key" ON "Document"("companyId", "documentNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_companyId_paymentNumber_key" ON "Payment"("companyId", "paymentNumber");

-- 9. Refresh-token hardening: deterministic hash lookup + rotation/reuse tracking
DELETE FROM "RefreshToken";
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "replacedByTokenId" TEXT;
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
ALTER TABLE "RefreshToken" DROP CONSTRAINT IF EXISTS "RefreshToken_userId_fkey";
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- 10. Indexes matching the Prisma schema
CREATE INDEX IF NOT EXISTS "Branch_companyId_idx" ON "Branch"("companyId");
CREATE INDEX IF NOT EXISTS "User_companyId_idx" ON "User"("companyId");
CREATE INDEX IF NOT EXISTS "Product_companyId_idx" ON "Product"("companyId");
CREATE INDEX IF NOT EXISTS "Supplier_companyId_idx" ON "Supplier"("companyId");
CREATE INDEX IF NOT EXISTS "Batch_companyId_idx" ON "Batch"("companyId");
CREATE INDEX IF NOT EXISTS "Document_branchId_idx" ON "Document"("branchId");
CREATE INDEX IF NOT EXISTS "Document_sourceBranchId_idx" ON "Document"("sourceBranchId");
CREATE INDEX IF NOT EXISTS "Document_destinationBranchId_idx" ON "Document"("destinationBranchId");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_productId_batchId_branchId_stockStatus_idx" ON "InventoryTransaction"("productId", "batchId", "branchId", "stockStatus");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_branchId_stockStatus_idx" ON "InventoryTransaction"("branchId", "stockStatus");
CREATE INDEX IF NOT EXISTS "InventoryTransaction_companyId_transactionDate_idx" ON "InventoryTransaction"("companyId", "transactionDate");
CREATE INDEX IF NOT EXISTS "Payment_companyId_idx" ON "Payment"("companyId");
CREATE INDEX IF NOT EXISTS "Payment_supplierId_idx" ON "Payment"("supplierId");
