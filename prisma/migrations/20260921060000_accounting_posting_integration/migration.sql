-- Accounting posting integration.
--
-- Two things arrive here. First, an accounting state on the two rows that raise
-- postings (Document and Payment), so "has this been booked" is answerable
-- without inferring it from the absence of a journal - absence cannot tell a
-- stock transfer that needs no entry apart from an invoice whose entry is
-- missing. Second, a supplier id on the journal line, which is the accounts
-- payable subledger: 2301 stays the single control account and every payable
-- line names the supplier behind it.

-- CreateEnum
CREATE TYPE "AccountingStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'POSTED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "accountingMessage" TEXT,
ADD COLUMN     "accountingPostedAt" TIMESTAMP(3),
ADD COLUMN     "accountingStatus" "AccountingStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "supplierId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "accountingMessage" TEXT,
ADD COLUMN     "accountingPostedAt" TIMESTAMP(3),
ADD COLUMN     "accountingStatus" "AccountingStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- CreateIndex
CREATE INDEX "Document_companyId_accountingStatus_idx" ON "Document"("companyId", "accountingStatus");

-- CreateIndex
CREATE INDEX "JournalLine_supplierId_idx" ON "JournalLine"("supplierId");

-- CreateIndex
CREATE INDEX "Payment_companyId_accountingStatus_idx" ON "Payment"("companyId", "accountingStatus");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/* ------------------------------------------------------------- backfill ---- */

-- Payable lines already posted are attributed to the supplier of the document or
-- payment that raised them, so the subledger covers the whole history rather than
-- starting from today. The vendor account is resolved exactly as the posting
-- service resolves it: the company-wide VENDOR mapping, through its head's
-- default ledger when the mapping names a head rather than a ledger.
WITH vendor_ledger AS (
  SELECT m."companyId", COALESCE(m."ledgerId", head_default.id) AS "ledgerId"
  FROM "AccountMapping" m
  LEFT JOIN LATERAL (
    SELECT l.id
    FROM "Ledger" l
    WHERE l."companyId" = m."companyId"
      AND l."headId" = m."headId"
      AND l."isActive"
    ORDER BY l."isDefault" DESC, l."code" ASC
    LIMIT 1
  ) head_default ON m."headId" IS NOT NULL
  WHERE m."mappingType" = 'VENDOR' AND m."scopeKey" = '*'
),
source_supplier AS (
  SELECT je.id AS "journalEntryId",
         je."companyId",
         COALESCE(d."supplierId", p."supplierId") AS "supplierId"
  FROM "JournalEntry" je
  LEFT JOIN "Document" d ON d.id = je."sourceDocumentId"
  LEFT JOIN "Payment"  p ON p.id = je."sourcePaymentId"
)
UPDATE "JournalLine" jl
SET "supplierId" = ss."supplierId"
FROM source_supplier ss
JOIN vendor_ledger vl ON vl."companyId" = ss."companyId"
WHERE jl."journalEntryId" = ss."journalEntryId"
  AND jl."ledgerId" = vl."ledgerId"
  AND ss."supplierId" IS NOT NULL;

-- Anything that already carries a journal is POSTED, dated from that journal.
UPDATE "Document" d
SET "accountingStatus" = 'POSTED',
    "accountingPostedAt" = j."postedAt"
FROM (
  SELECT "sourceDocumentId", MIN("postedAt") AS "postedAt"
  FROM "JournalEntry"
  WHERE "sourceDocumentId" IS NOT NULL AND "status" <> 'DRAFT'
  GROUP BY "sourceDocumentId"
) j
WHERE d.id = j."sourceDocumentId";

UPDATE "Payment" p
SET "accountingStatus" = 'POSTED',
    "accountingPostedAt" = j."postedAt"
FROM (
  SELECT "sourcePaymentId", MIN("postedAt") AS "postedAt"
  FROM "JournalEntry"
  WHERE "sourcePaymentId" IS NOT NULL AND "status" <> 'DRAFT'
  GROUP BY "sourcePaymentId"
) j
WHERE p.id = j."sourcePaymentId";

-- Everything the policy says should be booked and is not, is PENDING rather than
-- silently NOT_REQUIRED: a document raised before posting was wired into the
-- workflow is a recoverable gap, and it has to be visible as one.
UPDATE "Document"
SET "accountingStatus" = 'PENDING',
    "accountingMessage" = 'Raised before accounting posting was integrated into the workflow. Retry accounting to raise the journal.'
WHERE "documentType" IN ('SUPPLIER_INVOICE', 'CREDIT_NOTE', 'DISPENSING')
  AND "status" <> 'CANCELLED'
  AND "accountingStatus" = 'NOT_REQUIRED';

-- A patient receipt has no supplier and is booked by the sale it settles, so only
-- supplier payments allocated to a supplier invoice are pending here.
UPDATE "Payment" p
SET "accountingStatus" = 'PENDING',
    "accountingMessage" = 'Raised before accounting posting was integrated into the workflow. Retry accounting to raise the journal.'
WHERE p."supplierId" IS NOT NULL
  AND p."accountingStatus" = 'NOT_REQUIRED'
  AND EXISTS (
    SELECT 1
    FROM "PaymentAllocation" pa
    JOIN "Document" d ON d.id = pa."documentId"
    WHERE pa."paymentId" = p.id AND d."documentType" = 'SUPPLIER_INVOICE'
  );
