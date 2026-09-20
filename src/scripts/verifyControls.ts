/**
 * End-to-end validation of the safety controls, against a running API.
 *
 * These are the rules that only show themselves under conditions a demo never
 * reaches - two users pressing the same button at once, a correction that
 * arrives after the supplier has already invoiced, a batch that expires between
 * a transfer being raised and being sent - so they are driven here deliberately
 * rather than left to be argued about:
 *
 *   P1-1  concurrent posting, dispatch and receipt
 *   P1-3  a receiving correction raised after invoicing
 *   P1-4  expired, damaged and quarantined stock leaving a branch
 *
 * It needs a seeded database and a running server:
 *
 *   npm run verify:controls
 *
 * Like the internal-fulfilment harness, it is additive and leaves its own
 * documents behind, so run `npm run prisma:seed` afterwards to put the demo
 * tenant back to the official scenario. Batch expiry and batch condition are set
 * directly, because no document in the system condemns a batch or moves a date.
 */
import { InventoryTransactionType, StockStatus } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/prisma';

const API = process.env.VERIFY_API ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const RUN = Date.now().toString(36).toUpperCase();

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log('PASS ' + name);
  } else {
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  }
}

function section(title: string) {
  console.log('\n--- ' + title + ' ---');
}

interface Session {
  email: string;
  token: string;
}

async function login(email: string): Promise<Session> {
  const response = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const payload = await response.json();
  if (!payload.success) {
    throw new Error('login failed for ' + email + ': ' + payload.message);
  }
  return { email, token: payload.data.accessToken };
}

async function call(
  session: Session,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + session.token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Fails loudly rather than letting a bad setup masquerade as a failed assertion. */
function expectOk(label: string, result: { status: number; body: any }) {
  if (!result.body?.success) {
    throw new Error(label + ' failed (' + result.status + '): ' + JSON.stringify(result.body));
  }
  return result.body.data;
}

/** Counts ledger rows one document wrote, which is how double-posting shows up. */
async function ledgerRows(documentId: string, type: InventoryTransactionType): Promise<number> {
  return prisma.inventoryTransaction.count({
    where: { documentId, transactionType: type },
  });
}

async function main() {
  console.log('--- safety control validation (run ' + RUN + ') ---');

  const central = await login('central@healthpilot.ai');
  const branchA = await login('brancha@healthpilot.ai');

  const branches = expectOk('branches', await call(central, 'GET', '/api/branches?scope=company&limit=100'));
  const centralBranch = branches.find((b: any) => b.code === 'BR-CENTRAL');
  const branchABranch = branches.find((b: any) => b.code === 'BR-A');

  const products = expectOk('products', await call(central, 'GET', '/api/products?limit=100'));
  const product = products.find((p: any) => p.code === 'PRD-INS-001');
  const suppliers = expectOk('suppliers', await call(central, 'GET', '/api/suppliers?limit=100'));
  const supplier = suppliers.find((s: any) => s.code === 'SUP-MEDISUPPLY');

  if (!centralBranch || !branchABranch || !product || !supplier) {
    throw new Error('Demo master data missing. Run `npm run prisma:seed` first.');
  }

  const unitPrice = '500.00';
  const taxRate = '5.00';
  const batchNumber = 'CTRL-' + RUN;

  /* ------------------------------------------------ set up a fresh order -- */

  const requirement = expectOk(
    'requisition',
    await call(branchA, 'POST', '/api/stock-requirements', {
      branchId: branchABranch.id,
      requiredDate: new Date(Date.now() + 7 * 864e5).toISOString(),
      reason: 'Control validation run ' + RUN,
      lines: [{ productId: product.id, quantity: '60' }],
    })
  );
  expectOk('submit', await call(branchA, 'POST', '/api/stock-requirements/' + requirement.id + '/submit', {}));
  expectOk('approve', await call(central, 'POST', '/api/stock-requirements/' + requirement.id + '/approve', {}));

  const purchaseOrder = expectOk(
    'purchase order',
    await call(central, 'POST', '/api/purchase-orders', {
      requirementId: requirement.id,
      supplierId: supplier.id,
      deliveryBranchId: centralBranch.id,
      expectedDeliveryDate: new Date(Date.now() + 3 * 864e5).toISOString(),
      lines: [{ productId: product.id, quantity: '60', unitPrice, taxRate }],
    })
  );
  expectOk('approve order', await call(central, 'POST', '/api/purchase-orders/' + purchaseOrder.id + '/approve', {}));

  const goodsReceipt = expectOk(
    'goods receipt',
    await call(central, 'POST', '/api/goods-receipts', {
      purchaseOrderId: purchaseOrder.id,
      supplierRef: 'CTRL-DN-' + RUN,
      lines: [
        {
          purchaseOrderLineItemId: purchaseOrder.lineItems[0].id,
          quantity: '60',
          acceptedQuantity: '60',
          damagedQuantity: '0',
          missingQuantity: '0',
          batchNumber,
          expiryDate: new Date(Date.now() + 730 * 864e5).toISOString(),
        },
      ],
    })
  );

  /* ---------------------------------------- P1-1 concurrent state changes -- */

  section('P1-1 concurrent goods receipt posting');

  const posts = await Promise.all([
    call(central, 'POST', '/api/goods-receipts/' + goodsReceipt.id + '/post', {}),
    call(central, 'POST', '/api/goods-receipts/' + goodsReceipt.id + '/post', {}),
  ]);
  const postAccepted = posts.filter((r) => r.status === 200).length;
  const postRefused = posts.filter((r) => r.status === 409).length;
  check('exactly one concurrent post succeeds', postAccepted === 1, posts.map((r) => r.status));
  check('the loser is refused with 409, not silently ignored', postRefused === 1, {
    statuses: posts.map((r) => r.status),
    message: posts.find((r) => r.status === 409)?.body?.message,
  });
  check(
    'the delivery is booked into stock exactly once',
    (await ledgerRows(goodsReceipt.id, InventoryTransactionType.RECEIPT)) === 1
  );

  const batch = await prisma.batch.findFirstOrThrow({
    where: { productId: product.id, batchNumber },
    select: { id: true, expiryDate: true, status: true },
  });

  section('P1-1 concurrent transfer dispatch and receipt');

  const transfer = expectOk(
    'transfer',
    await call(central, 'POST', '/api/stock-transfers', {
      sourceBranchId: centralBranch.id,
      destinationBranchId: branchABranch.id,
      requirementId: requirement.id,
      lines: [{ productId: product.id, batchId: batch.id, quantity: '30' }],
    })
  );

  const dispatches = await Promise.all([
    call(central, 'POST', '/api/stock-transfers/' + transfer.id + '/dispatch', {}),
    call(central, 'POST', '/api/stock-transfers/' + transfer.id + '/dispatch', {}),
  ]);
  check('exactly one concurrent dispatch succeeds', dispatches.filter((r) => r.status === 200).length === 1, dispatches.map((r) => r.status));
  check('the other dispatch is refused with 409', dispatches.filter((r) => r.status === 409).length === 1, dispatches.map((r) => r.status));
  check(
    'stock leaves the source branch exactly once',
    (await ledgerRows(transfer.id, InventoryTransactionType.TRANSFER_OUT)) === 1
  );

  const receipts = await Promise.all([
    call(branchA, 'POST', '/api/stock-transfers/' + transfer.id + '/receive', {}),
    call(branchA, 'POST', '/api/stock-transfers/' + transfer.id + '/receive', {}),
  ]);
  check('exactly one concurrent receipt succeeds', receipts.filter((r) => r.status === 200).length === 1, receipts.map((r) => r.status));
  check('the other receipt is refused with 409', receipts.filter((r) => r.status === 409).length === 1, receipts.map((r) => r.status));
  check(
    'stock arrives at the destination exactly once',
    (await ledgerRows(transfer.id, InventoryTransactionType.TRANSFER_IN)) === 1
  );

  /* ------------------------------------- P1-3 correction after invoicing -- */

  section('P1-3 a receiving correction raised after the supplier invoice');

  const invoice = expectOk(
    'supplier invoice',
    await call(central, 'POST', '/api/supplier-invoices', {
      purchaseOrderId: purchaseOrder.id,
      supplierRef: 'CTRL-INV-' + RUN,
      lines: [{ productId: product.id, quantity: '60', unitPrice, taxRate }],
    })
  );
  check('invoice starts undisputed (all 60 were accepted)', invoice.financials.disputedAmount === '0.00', invoice.financials);
  check('invoice is payable in full', invoice.financials.allocatableAmount === '31500.00', invoice.financials);

  const receiptDetail = expectOk('receipt detail', await call(central, 'GET', '/api/goods-receipts/' + goodsReceipt.id));
  const correction = await call(central, 'POST', '/api/receipt-corrections', {
    goodsReceiptId: goodsReceipt.id,
    reason: 'Control run ' + RUN + ': 10 vials found damaged after the invoice arrived',
    lines: [
      {
        goodsReceiptLineItemId: receiptDetail.lineItems[0].id,
        correctedAcceptedQuantity: '50',
        correctedDamagedQuantity: '10',
        correctedMissingQuantity: '0',
      },
    ],
  });
  check('the late correction is accepted', correction.status === 201, correction.body?.message);

  const reread = expectOk('invoice re-read', await call(central, 'GET', '/api/supplier-invoices/' + invoice.id));
  check(
    'the disputed amount is recomputed to 10 vials + tax',
    reread.financials.disputedAmount === '5250.00',
    reread.financials
  );
  check(
    'the accepted payable falls to 50 vials + tax',
    reread.financials.acceptedPayable === '26250.00',
    reread.financials
  );
  check('the invoice is marked DISCREPANT again', reread.status === 'DISCREPANT', { status: reread.status });

  const overpay = await call(central, 'POST', '/api/payments', {
    supplierId: supplier.id,
    branchId: centralBranch.id,
    amount: '31500.00',
    method: 'BANK_TRANSFER',
    allocations: [{ documentId: invoice.id, amount: '31500.00' }],
  });
  check('paying the full invoice is now refused', overpay.status === 409, {
    status: overpay.status,
    message: overpay.body?.message,
  });

  const payable = await call(central, 'POST', '/api/payments', {
    supplierId: supplier.id,
    branchId: centralBranch.id,
    amount: '26250.00',
    method: 'BANK_TRANSFER',
    allocations: [{ documentId: invoice.id, amount: '26250.00' }],
  });
  check('paying the still-accepted value is allowed', payable.status === 201, {
    status: payable.status,
    message: payable.body?.message,
  });

  /* ------------------------------------------- P1-4 invalid stock leaving -- */

  section('P1-4 expired, damaged and quarantined stock may not be transferred');

  const transferAttempt = (quantity: string) =>
    call(central, 'POST', '/api/stock-transfers', {
      sourceBranchId: centralBranch.id,
      destinationBranchId: branchABranch.id,
      lines: [{ productId: product.id, batchId: batch.id, quantity }],
    });

  await prisma.batch.update({
    where: { id: batch.id },
    data: { expiryDate: new Date(Date.now() - 864e5) },
  });
  const expired = await transferAttempt('5');
  check('an expired batch cannot be transferred', expired.status === 409, {
    status: expired.status,
    message: expired.body?.message,
  });

  await prisma.batch.update({ where: { id: batch.id }, data: { expiryDate: batch.expiryDate } });

  for (const status of [StockStatus.DAMAGED, StockStatus.QUARANTINED, StockStatus.EXPIRED]) {
    await prisma.batch.update({ where: { id: batch.id }, data: { status } });
    const blocked = await transferAttempt('5');
    check('a ' + status.toLowerCase() + ' batch cannot be transferred', blocked.status === 409, {
      status: blocked.status,
      message: blocked.body?.message,
    });
  }
  await prisma.batch.update({ where: { id: batch.id }, data: { status: StockStatus.USABLE } });

  // The same rule at dispatch, not only at creation: a transfer raised while the
  // batch was good must not be allowed to leave after it expires.
  const laterTransfer = expectOk(
    'transfer raised while valid',
    await transferAttempt('5')
  );
  await prisma.batch.update({
    where: { id: batch.id },
    data: { expiryDate: new Date(Date.now() - 864e5) },
  });
  const lateDispatch = await call(central, 'POST', '/api/stock-transfers/' + laterTransfer.id + '/dispatch', {});
  check('a batch that expires before dispatch cannot be dispatched', lateDispatch.status === 409, {
    status: lateDispatch.status,
    message: lateDispatch.body?.message,
  });

  // Dispensing has always enforced this; confirm it still does, from the same rule.
  const dispenseExpired = await call(branchA, 'POST', '/api/dispensing', {
    branchId: branchABranch.id,
    patientRef: 'CTRL-' + RUN,
    prescriptionRef: 'CTRL-RX-' + RUN,
    paymentMethod: 'CASH',
    lines: [{ productId: product.id, batchId: batch.id, quantity: '1' }],
  });
  check('an expired batch still cannot be dispensed', dispenseExpired.status === 409, {
    status: dispenseExpired.status,
    message: dispenseExpired.body?.message,
  });

  await prisma.batch.update({ where: { id: batch.id }, data: { expiryDate: batch.expiryDate } });

  /* -------------------------------------------------------------- summary -- */

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log(checks - failures + '/' + checks + ' passed');
  console.log('\nThis run left documents behind. Run `npm run prisma:seed` to restore the demo tenant.');
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Control validation failed to run:', error);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
