-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('STOCK_REQUIREMENT_SUBMITTED', 'STOCK_REQUIREMENT_APPROVED', 'STOCK_REQUIREMENT_REJECTED', 'STOCK_REQUIREMENT_PARTIALLY_FULFILLED', 'STOCK_REQUIREMENT_FULFILLED', 'PURCHASE_ORDER_CREATED', 'PURCHASE_ORDER_APPROVED', 'GOODS_RECEIPT_POSTED', 'GOODS_RECEIPT_CORRECTED', 'SUPPLIER_INVOICE_CREATED', 'SUPPLIER_INVOICE_DISPUTED', 'CREDIT_NOTE_POSTED', 'PAYMENT_ALLOCATED', 'STOCK_TRANSFER_CREATED', 'STOCK_TRANSFER_DISPATCHED', 'STOCK_TRANSFER_RECEIVED', 'DISPENSING_COMPLETED', 'LOW_STOCK', 'EXPIRY_ALERT');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationEntityType" AS ENUM ('DOCUMENT', 'PAYMENT', 'PRODUCT', 'BATCH');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "entityType" "NotificationEntityType",
    "entityId" TEXT,
    "documentId" TEXT,
    "branchId" TEXT,
    "eventKey" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_isRead_idx" ON "Notification"("recipientUserId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_companyId_idx" ON "Notification"("companyId");

-- CreateIndex
CREATE INDEX "Notification_documentId_idx" ON "Notification"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_companyId_recipientUserId_eventKey_key" ON "Notification"("companyId", "recipientUserId", "eventKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
