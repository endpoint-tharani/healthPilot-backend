-- CreateEnum
CREATE TYPE "BalanceType" AS ENUM ('DR', 'CR');

-- CreateEnum
CREATE TYPE "AccountGroupType" AS ENUM ('NORMAL', 'PRIMARY');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AccountingEvent" AS ENUM ('SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT', 'CREDIT_NOTE', 'SALES', 'COGS', 'MANUAL', 'REVERSAL');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('DOCUMENT', 'PAYMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "AccountMappingType" AS ENUM ('CUSTOMER', 'VENDOR', 'SALES', 'PURCHASE', 'CASH', 'BANK', 'TAX', 'ROUNDING', 'DISCOUNT', 'DIRECT_COST', 'INDIRECT_COST', 'INVENTORY', 'OTHER', 'INPUT_TAX', 'OUTPUT_TAX');

-- CreateEnum
CREATE TYPE "AccountMappingTarget" AS ENUM ('HEAD', 'LEDGER');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "accountingInitializedAt" TIMESTAMP(3),
ADD COLUMN     "accountingTemplateKey" TEXT,
ADD COLUMN     "accountingTemplateVersion" TEXT;

-- CreateTable
CREATE TABLE "AccountGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headId" TEXT NOT NULL,
    "groupType" "AccountGroupType" NOT NULL DEFAULT 'NORMAL',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountHead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "natureTypeId" TEXT NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "scopeKey" TEXT NOT NULL DEFAULT '*',
    "mappingType" "AccountMappingType" NOT NULL,
    "target" "AccountMappingTarget" NOT NULL,
    "headId" TEXT,
    "ledgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountNature" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ledgerCodeFrom" INTEGER NOT NULL,
    "ledgerCodeTo" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountNature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountNatureType" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "natureId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountNatureType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSubGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSubGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "journalNumber" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "event" "AccountingEvent" NOT NULL,
    "sourceType" "JournalSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceEventKey" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourcePaymentId" TEXT,
    "sourceDocumentType" TEXT,
    "sourceReference" TEXT,
    "description" TEXT NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "totalDebit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reversalOfId" TEXT,
    "createdById" TEXT NOT NULL,
    "postedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "branchId" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ledger" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headId" TEXT NOT NULL,
    "groupId" TEXT,
    "subGroupId" TEXT,
    "openingBalanceType" "BalanceType" NOT NULL DEFAULT 'DR',
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountGroup_companyId_idx" ON "AccountGroup"("companyId");

-- CreateIndex
CREATE INDEX "AccountGroup_headId_idx" ON "AccountGroup"("headId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountGroup_companyId_code_key" ON "AccountGroup"("companyId", "code");

-- CreateIndex
CREATE INDEX "AccountHead_companyId_idx" ON "AccountHead"("companyId");

-- CreateIndex
CREATE INDEX "AccountHead_natureTypeId_idx" ON "AccountHead"("natureTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountHead_companyId_code_key" ON "AccountHead"("companyId", "code");

-- CreateIndex
CREATE INDEX "AccountMapping_companyId_idx" ON "AccountMapping"("companyId");

-- CreateIndex
CREATE INDEX "AccountMapping_branchId_idx" ON "AccountMapping"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_companyId_scopeKey_mappingType_key" ON "AccountMapping"("companyId", "scopeKey", "mappingType");

-- CreateIndex
CREATE INDEX "AccountNature_companyId_idx" ON "AccountNature"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountNature_companyId_code_key" ON "AccountNature"("companyId", "code");

-- CreateIndex
CREATE INDEX "AccountNatureType_companyId_idx" ON "AccountNatureType"("companyId");

-- CreateIndex
CREATE INDEX "AccountNatureType_natureId_idx" ON "AccountNatureType"("natureId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountNatureType_companyId_code_key" ON "AccountNatureType"("companyId", "code");

-- CreateIndex
CREATE INDEX "AccountSubGroup_companyId_idx" ON "AccountSubGroup"("companyId");

-- CreateIndex
CREATE INDEX "AccountSubGroup_groupId_idx" ON "AccountSubGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSubGroup_companyId_code_key" ON "AccountSubGroup"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_documentDate_idx" ON "JournalEntry"("companyId", "documentDate");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_status_idx" ON "JournalEntry"("companyId", "status");

-- CreateIndex
CREATE INDEX "JournalEntry_branchId_idx" ON "JournalEntry"("branchId");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceDocumentId_idx" ON "JournalEntry"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "JournalEntry_sourcePaymentId_idx" ON "JournalEntry"("sourcePaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_journalNumber_key" ON "JournalEntry"("companyId", "journalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_sourceEventKey_key" ON "JournalEntry"("companyId", "sourceEventKey");

-- CreateIndex
CREATE INDEX "JournalLine_journalEntryId_idx" ON "JournalLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalLine_ledgerId_idx" ON "JournalLine"("ledgerId");

-- CreateIndex
CREATE INDEX "JournalLine_branchId_idx" ON "JournalLine"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalLine_journalEntryId_lineNumber_key" ON "JournalLine"("journalEntryId", "lineNumber");

-- CreateIndex
CREATE INDEX "Ledger_companyId_idx" ON "Ledger"("companyId");

-- CreateIndex
CREATE INDEX "Ledger_headId_idx" ON "Ledger"("headId");

-- CreateIndex
CREATE INDEX "Ledger_groupId_idx" ON "Ledger"("groupId");

-- CreateIndex
CREATE INDEX "Ledger_subGroupId_idx" ON "Ledger"("subGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "Ledger_companyId_code_key" ON "Ledger"("companyId", "code");

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_headId_fkey" FOREIGN KEY ("headId") REFERENCES "AccountHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHead" ADD CONSTRAINT "AccountHead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountHead" ADD CONSTRAINT "AccountHead_natureTypeId_fkey" FOREIGN KEY ("natureTypeId") REFERENCES "AccountNatureType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_headId_fkey" FOREIGN KEY ("headId") REFERENCES "AccountHead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNature" ADD CONSTRAINT "AccountNature_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNatureType" ADD CONSTRAINT "AccountNatureType_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNatureType" ADD CONSTRAINT "AccountNatureType_natureId_fkey" FOREIGN KEY ("natureId") REFERENCES "AccountNature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSubGroup" ADD CONSTRAINT "AccountSubGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSubGroup" ADD CONSTRAINT "AccountSubGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_headId_fkey" FOREIGN KEY ("headId") REFERENCES "AccountHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_subGroupId_fkey" FOREIGN KEY ("subGroupId") REFERENCES "AccountSubGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Double-entry integrity, enforced by the database rather than only by the
-- service. The journal service validates all of this before it writes, but a
-- migration, a repair script or a future service that forgets the rule would
-- otherwise be able to write a line that is neither a debit nor a credit, or a
-- posting that does not balance. Postgres is the last line that cannot be
-- bypassed.
--
-- CHECK constraints are deliberately used here rather than partial indexes:
-- Prisma does not model CHECKs, so they survive future `migrate dev` runs
-- without being detected as drift and dropped.
-- ---------------------------------------------------------------------------

-- Neither side of a posting may be negative. A negative debit is a credit
-- wearing the wrong sign, and it would silently unbalance every report that
-- sums the two columns separately.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "JournalLine_amounts_non_negative"
  CHECK ("debit" >= 0 AND "credit" >= 0);

-- Exactly one side carries a value. Both zero is a line that means nothing;
-- both set is a line that means two contradictory things.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "JournalLine_exactly_one_side"
  CHECK (("debit" > 0) <> ("credit" > 0));

-- A posted journal balances. Draft entries are exempt while they are being
-- built up; nothing that has reached POSTED may be unbalanced.
ALTER TABLE "JournalEntry"
  ADD CONSTRAINT "JournalEntry_posted_is_balanced"
  CHECK ("status" <> 'POSTED' OR "totalDebit" = "totalCredit");
