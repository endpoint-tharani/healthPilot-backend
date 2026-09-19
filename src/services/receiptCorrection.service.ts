import {
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertBranchAccess } from './authorization.service';
import {
  DocumentListFilters,
  getDocumentDetail,
  linkDocuments,
  listDocuments,
} from './document.service';
import { StockMovementInput, recordStockMovements } from './inventory.service';
import { propagateFulfilment } from './goodsReceipt.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifyReceiptCorrected } from './notificationEvents.service';

export interface CorrectionLineInput {
  goodsReceiptLineItemId: string;
  correctedAcceptedQuantity: string;
  correctedDamagedQuantity: string;
  correctedMissingQuantity: string;
}

export interface CreateCorrectionInput {
  goodsReceiptId: string;
  reason: string;
  lines: CorrectionLineInput[];
}

interface ReceiptLineQuantities {
  id: string;
  acceptedQuantity: Prisma.Decimal | null;
  damagedQuantity: Prisma.Decimal | null;
  missingQuantity: Prisma.Decimal | null;
}

interface Split {
  accepted: Prisma.Decimal;
  damaged: Prisma.Decimal;
  missing: Prisma.Decimal;
}

/**
 * Effective quantities for every line of a receipt: the originally posted split
 * plus the deltas of every correction already applied to it. Read for the whole
 * receipt at once, because a correction is a single operation and one query per
 * line was the bulk of its cost over a network database.
 */
async function effectiveQuantitiesByLine(
  tx: Prisma.TransactionClient,
  receiptLines: ReceiptLineQuantities[]
): Promise<Map<string, Split>> {
  const result = new Map<string, Split>(
    receiptLines.map((line) => [
      line.id,
      {
        accepted: line.acceptedQuantity ?? ZERO,
        damaged: line.damagedQuantity ?? ZERO,
        missing: line.missingQuantity ?? ZERO,
      },
    ])
  );
  if (receiptLines.length === 0) {
    return result;
  }

  const priorCorrections = await tx.documentLineItem.findMany({
    where: {
      referenceLineItemId: { in: receiptLines.map((line) => line.id) },
      document: { documentType: DocumentType.RECEIPT_CORRECTION },
    },
    select: {
      referenceLineItemId: true,
      acceptedQuantity: true,
      damagedQuantity: true,
      missingQuantity: true,
    },
  });

  for (const correction of priorCorrections) {
    const current = result.get(correction.referenceLineItemId!);
    if (!current) {
      continue;
    }
    result.set(correction.referenceLineItemId!, {
      accepted: current.accepted.plus(correction.acceptedQuantity ?? ZERO),
      damaged: current.damaged.plus(correction.damagedQuantity ?? ZERO),
      missing: current.missing.plus(correction.missingQuantity ?? ZERO),
    });
  }
  return result;
}

/**
 * A correction never touches the posted goods receipt: the original user,
 * timestamp, quantities and stock movements stay exactly as recorded. The
 * correction is a new document carrying the signed delta, which is what moves
 * stock back to the true position.
 */
export async function createReceiptCorrection(auth: AuthContext, input: CreateCorrectionInput) {
  if (!input.reason?.trim()) {
    throw badRequest('A correction reason is required');
  }

  const documentId = await notifyingTransaction(async (tx) => {
    const receipt = await tx.document.findUnique({
      where: { id: input.goodsReceiptId },
      include: { lineItems: true },
    });
    if (
      !receipt ||
      receipt.companyId !== auth.companyId ||
      receipt.documentType !== DocumentType.GOODS_RECEIPT
    ) {
      throw notFound('Goods receipt not found');
    }
    const correctable: DocumentStatus[] = [DocumentStatus.POSTED, DocumentStatus.CORRECTED];
    if (!correctable.includes(receipt.status)) {
      throw conflict(
        'Only a posted goods receipt can be corrected; ' +
          receipt.documentNumber +
          ' is ' +
          receipt.status
      );
    }
    if (!receipt.branchId) {
      throw conflict('Goods receipt has no receiving branch');
    }
    await assertBranchAccess(auth, receipt.branchId, tx);

    const receiptLineById = new Map(receipt.lineItems.map((l) => [l.id, l]));
    const currentByLineId = await effectiveQuantitiesByLine(tx, receipt.lineItems);

    const prepared = [];
    for (const [index, line] of input.lines.entries()) {
      const lineNumber = index + 1;
      const receiptLine = receiptLineById.get(line.goodsReceiptLineItemId);
      if (!receiptLine) {
        throw badRequest(
          'Line ' + lineNumber + ': line not found on ' + receipt.documentNumber
        );
      }

      const accepted = dec(line.correctedAcceptedQuantity);
      const damaged = dec(line.correctedDamagedQuantity);
      const missing = dec(line.correctedMissingQuantity);
      if (accepted.isNegative() || damaged.isNegative() || missing.isNegative()) {
        throw badRequest('Line ' + lineNumber + ': corrected quantities cannot be negative');
      }
      if (!accepted.plus(damaged).plus(missing).equals(receiptLine.quantity)) {
        throw badRequest(
          'Line ' +
            lineNumber +
            ': corrected accepted + damaged + missing must equal the received quantity ' +
            receiptLine.quantity.toFixed(2)
        );
      }

      const current = currentByLineId.get(receiptLine.id)!;
      const delta = {
        accepted: accepted.minus(current.accepted),
        damaged: damaged.minus(current.damaged),
        missing: missing.minus(current.missing),
      };

      if (delta.accepted.isZero() && delta.damaged.isZero() && delta.missing.isZero()) {
        throw conflict('Line ' + lineNumber + ': corrected quantities match the current position');
      }

      prepared.push({ receiptLine, delta, corrected: { accepted, damaged, missing }, current });
    }

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.RECEIPT_CORRECTION
    );

    const correction = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: receipt.branchId,
        supplierId: receipt.supplierId,
        documentNumber,
        documentType: DocumentType.RECEIPT_CORRECTION,
        status: DocumentStatus.POSTED,
        supplierRef: receipt.supplierRef,
        notes: input.reason,
        createdById: auth.userId,
        lineItems: {
          create: prepared.map((p, index) => {
            const netDelta = p.delta.accepted.plus(p.delta.damaged).plus(p.delta.missing);
            const totals = calculateLineTotals(
              netDelta,
              p.receiptLine.unitPrice,
              p.receiptLine.taxRate
            );
            return {
              lineNumber: index + 1,
              productId: p.receiptLine.productId,
              batchId: p.receiptLine.batchId,
              description:
                'Correction: accepted ' +
                p.current.accepted.toFixed(2) +
                ' -> ' +
                p.corrected.accepted.toFixed(2),
              quantity: netDelta,
              acceptedQuantity: p.delta.accepted,
              damagedQuantity: p.delta.damaged,
              missingQuantity: p.delta.missing,
              unitPrice: p.receiptLine.unitPrice,
              subtotal: totals.subtotal,
              taxRate: p.receiptLine.taxRate,
              taxAmount: totals.taxAmount,
              total: totals.total,
              unitOfMeasure: p.receiptLine.unitOfMeasure,
              referenceLineItemId: p.receiptLine.id,
            };
          }),
        },
      },
      include: { lineItems: true },
    });

    const movements: StockMovementInput[] = [];
    for (const [index, p] of prepared.entries()) {
      const correctionLine = correction.lineItems[index];
      if (!p.receiptLine.batchId) {
        throw conflict('Corrected receipt line has no batch');
      }

      if (!p.delta.accepted.isZero()) {
        movements.push({
          companyId: auth.companyId,
          branchId: receipt.branchId,
          productId: p.receiptLine.productId,
          batchId: p.receiptLine.batchId,
          documentId: correction.id,
          documentLineItemId: correctionLine.id,
          transactionType: InventoryTransactionType.CORRECTION,
          quantity: p.delta.accepted,
          unitCost: p.receiptLine.unitPrice,
          stockStatus: StockStatus.USABLE,
          createdById: auth.userId,
          notes: 'Correction of ' + receipt.documentNumber,
        });
      }

      if (!p.delta.damaged.isZero()) {
        movements.push({
          companyId: auth.companyId,
          branchId: receipt.branchId,
          productId: p.receiptLine.productId,
          batchId: p.receiptLine.batchId,
          documentId: correction.id,
          documentLineItemId: correctionLine.id,
          transactionType: InventoryTransactionType.CORRECTION,
          quantity: p.delta.damaged,
          unitCost: p.receiptLine.unitPrice,
          stockStatus: StockStatus.DAMAGED,
          createdById: auth.userId,
          notes: 'Correction of ' + receipt.documentNumber,
        });
      }
      // Missing quantities carry no stock, so only the document record changes.
    }
    await recordStockMovements(tx, movements);

    await linkDocuments(
      tx,
      auth.companyId,
      correction.id,
      receipt.id,
      DocumentLinkType.CORRECTS
    );

    await tx.document.update({
      where: { id: receipt.id },
      data: { status: DocumentStatus.CORRECTED },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: correction.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.reason,
      newData: {
        documentNumber,
        corrects: receipt.documentNumber,
        deltas: prepared.map((p) => ({
          accepted: p.delta.accepted.toFixed(2),
          damaged: p.delta.damaged.toFixed(2),
          missing: p.delta.missing.toFixed(2),
        })),
      },
    });

    // The original receipt keeps its own history entry, recording that it was corrected.
    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: receipt.id,
      userId: auth.userId,
      action: AuditAction.CORRECT,
      reason: input.reason,
      oldData: {
        status: receipt.status,
        lines: receipt.lineItems.map((l) => ({
          lineNumber: l.lineNumber,
          accepted: (l.acceptedQuantity ?? ZERO).toFixed(2),
          damaged: (l.damagedQuantity ?? ZERO).toFixed(2),
          missing: (l.missingQuantity ?? ZERO).toFixed(2),
        })),
      },
      newData: {
        status: DocumentStatus.CORRECTED,
        correctionDocument: documentNumber,
        correctedLines: prepared.map((p) => ({
          receiptLineId: p.receiptLine.id,
          accepted: p.corrected.accepted.toFixed(2),
          damaged: p.corrected.damaged.toFixed(2),
          missing: p.corrected.missing.toFixed(2),
        })),
      },
    });

    // The correction changes the accepted quantity, so requirement fulfilment is
    // re-derived from the corrected stock position.
    await propagateFulfilment(tx, auth, receipt.id);

    // The before and after are the same per-line figures the deltas above were
    // computed from, summed for display only.
    await notifyReceiptCorrected(
      tx,
      auth,
      correction,
      receipt,
      {
        before: sumSplits(prepared.map((p) => p.current)),
        after: sumSplits(prepared.map((p) => p.corrected)),
      },
      input.reason
    );

    return correction.id;
  }, deliverNotifications);

  return getDocumentDetail(auth, documentId);
}

/** Totals across the corrected lines, for the notification summary. */
function sumSplits(splits: Split[]) {
  return splits.reduce(
    (acc, split) => ({
      accepted: acc.accepted.plus(split.accepted),
      damaged: acc.damaged.plus(split.damaged),
      missing: acc.missing.plus(split.missing),
    }),
    { accepted: ZERO, damaged: ZERO, missing: ZERO }
  );
}

export function listReceiptCorrections(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.RECEIPT_CORRECTION, filters);
}
