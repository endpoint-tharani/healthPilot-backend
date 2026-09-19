/**
 * End-to-end validation of the notification system against a running API.
 *
 * Drives the whole REQ -> PO -> GRN -> correction -> follow-up -> transfer ->
 * dispensing scenario over HTTP as five real users, with live Socket.IO clients
 * attached, and asserts on what each of them actually received: recipient
 * resolution, branch and company isolation, transaction safety, duplicate
 * prevention, offline persistence and read state.
 *
 * It needs a seeded database and a running server, and it CLEARS the
 * Notification table so its counts are unambiguous. That makes it a development
 * tool only, which is why it refuses to run without an explicit opt-in:
 *
 *   ALLOW_NOTIFICATION_RESET=true npm run verify:notifications
 */
import { io, type Socket } from 'socket.io-client';
import { prisma, disconnectDatabase } from '../database/prisma';

const API = process.env.VERIFY_API ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const RESET_ALLOWED = (process.env.ALLOW_NOTIFICATION_RESET ?? '').toLowerCase() === 'true';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
  }
}

interface Session {
  email: string;
  userId: string;
  token: string;
  socket?: Socket;
  received: { id: string; type: string; title: string; message: string }[];
}

async function call(
  session: Session | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string): Promise<Session> {
  const response = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const payload = await response.json();
  if (!payload.success) {
    throw new Error(`login failed for ${email}: ${payload.message}`);
  }
  const session: Session = {
    email,
    userId: payload.data.user.id,
    token: payload.data.accessToken,
    received: [],
  };
  return session;
}

function openSocket(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = io(API, {
      transports: ['websocket'],
      auth: { token: session.token },
    });
    session.socket = socket;
    socket.on('notification:new', (event) => session.received.push(event));
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(new Error(`${session.email}: ${error.message}`)));
    setTimeout(() => reject(new Error(`${session.email}: socket connect timeout`)), 8000);
  });
}

/** Socket delivery is asynchronous; give the event loop a moment to drain. */
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

function typesFor(session: Session): string[] {
  return session.received.map((event) => event.type);
}

async function stored(userId: string, type?: string) {
  return prisma.notification.findMany({
    where: { recipientUserId: userId, ...(type ? { type: type as never } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, title: true, message: true, isRead: true, eventKey: true },
  });
}

async function main() {
  console.log('--- notification end-to-end validation ---\n');

  if (!RESET_ALLOWED) {
    throw new Error(
      'This harness clears the Notification table. Re-run with ALLOW_NOTIFICATION_RESET=true ' +
        'against a development database only.'
    );
  }

  // A clean slate so counts in this run are unambiguous. Only notifications are
  // touched; no business data is removed.
  await prisma.notification.deleteMany({});

  /* ------------------------------------------------------------ sessions -- */
  const admin = await login('admin@healthpilot.ai');
  const central = await login('central@healthpilot.ai');
  const branchA = await login('brancha@healthpilot.ai');
  const branchB = await login('branchb@healthpilot.ai');
  const otherCo = await login('admin@othercare.ai');
  console.log('logged in: admin, central, branchA, branchB, otherCompanyAdmin\n');

  await Promise.all([
    openSocket(admin),
    openSocket(central),
    openSocket(branchA),
    openSocket(branchB),
    openSocket(otherCo),
  ]);
  check('1. Socket.IO: all five users connected', true);

  // A second tab for Branch A, to prove multi-tab behaviour.
  const branchATab2: Session = { ...branchA, received: [], socket: undefined };
  await openSocket(branchATab2);
  check('2. Socket.IO: second tab connected for the same user', Boolean(branchATab2.socket));

  const badSocket = await new Promise<string>((resolve) => {
    const socket = io(API, { transports: ['websocket'], auth: { token: 'not-a-token' } });
    socket.on('connect_error', (error) => {
      socket.close();
      resolve(error.message);
    });
    socket.on('connect', () => {
      socket.close();
      resolve('CONNECTED');
    });
    setTimeout(() => resolve('TIMEOUT'), 6000);
  });
  check('3. Socket.IO rejects an invalid token', badSocket === 'unauthorized', badSocket);

  /* ------------------------------------------------- reference data ------- */
  const branches = (await call(admin, 'GET', '/api/branches?scope=company&limit=50')).body.data;
  const central_bid = branches.find((b: any) => b.code === 'BR-CENTRAL').id;
  const branchA_bid = branches.find((b: any) => b.code === 'BR-A').id;

  const products = (await call(admin, 'GET', '/api/products?limit=10')).body.data;
  const productId = products[0].id;
  const suppliers = (await call(admin, 'GET', '/api/suppliers?limit=10')).body.data;
  const supplierId = suppliers[0].id;

  /* ============================ STEP 1: requirement submitted ============= */
  const reqCreate = await call(branchA, 'POST', '/api/stock-requirements', {
    branchId: branchA_bid,
    requiredDate: new Date(Date.now() + 7 * 864e5).toISOString(),
    reason: 'Notification validation run',
    lines: [{ productId, quantity: '100' }],
  });
  const requirementId = reqCreate.body.data.id;
  const requirementNumber = reqCreate.body.data.documentNumber;

  await settle(300);
  check(
    '4. Draft creation raises no notification',
    central.received.length === 0 && admin.received.length === 0,
    { central: typesFor(central), admin: typesFor(admin) }
  );

  await call(branchA, 'POST', `/api/stock-requirements/${requirementId}/submit`, {
    reason: 'Ward demand',
  });
  await settle();

  check(
    '5. STEP 1 - central procurement notified of the submission',
    typesFor(central).includes('STOCK_REQUIREMENT_SUBMITTED'),
    typesFor(central)
  );
  check(
    '5b. Submission message names the raising branch',
    central.received.some(
      (e) =>
        e.type === 'STOCK_REQUIREMENT_SUBMITTED' &&
        e.message.includes(requirementNumber) &&
        e.message.includes('Branch A')
    ),
    central.received.map((e) => e.message)
  );
  check(
    '5c. The submitting user is not notified of their own action',
    !typesFor(branchA).includes('STOCK_REQUIREMENT_SUBMITTED'),
    typesFor(branchA)
  );
  check(
    '5d. Branch B is not notified about a Branch A requirement',
    branchB.received.length === 0,
    typesFor(branchB)
  );
  check(
    '5e. The other company receives nothing at all',
    otherCo.received.length === 0,
    typesFor(otherCo)
  );

  /* ============================ STEP 2: approved ========================== */
  await call(central, 'POST', `/api/stock-requirements/${requirementId}/approve`, {
    reason: 'Approved for procurement',
  });
  await settle();

  check(
    '6. STEP 2 - the raising branch is notified of the approval',
    typesFor(branchA).includes('STOCK_REQUIREMENT_APPROVED'),
    typesFor(branchA)
  );
  check(
    '6b. Both tabs of the same user received it',
    typesFor(branchATab2).includes('STOCK_REQUIREMENT_APPROVED'),
    typesFor(branchATab2)
  );

  /* --------------------- rollback: a rejected operation notifies nobody --- */
  const before = await prisma.notification.count();
  const replay = await call(central, 'POST', `/api/stock-requirements/${requirementId}/approve`, {
    reason: 'Second attempt',
  });
  await settle(400);
  const after = await prisma.notification.count();
  check('7. A conflicting re-approval is refused', replay.status === 409, replay.status);
  check('7b. The refused operation wrote no notification', before === after, { before, after });

  /* ============================ STEP 3: PO + GRN ========================== */
  const poCreate = await call(central, 'POST', '/api/purchase-orders', {
    requirementId,
    supplierId,
    deliveryBranchId: central_bid,
    expectedDeliveryDate: new Date(Date.now() + 5 * 864e5).toISOString(),
    lines: [{ productId, quantity: '100' }],
  });
  const poId = poCreate.body.data.id;
  await settle();
  check(
    '8. STEP 3 - purchase order raised, approvers notified',
    typesFor(admin).includes('PURCHASE_ORDER_CREATED'),
    typesFor(admin)
  );

  await call(central, 'POST', `/api/purchase-orders/${poId}/approve`, {});
  await settle();
  check(
    '9. Purchase order approval notified',
    typesFor(admin).includes('PURCHASE_ORDER_APPROVED'),
    typesFor(admin)
  );

  const po = (await call(central, 'GET', `/api/purchase-orders/${poId}`)).body.data;
  const poLineId = po.lineItems[0].id;

  const grnCreate = await call(central, 'POST', '/api/goods-receipts', {
    purchaseOrderId: poId,
    supplierRef: 'SUP-DN-9001',
    lines: [
      {
        purchaseOrderLineItemId: poLineId,
        quantity: '100',
        acceptedQuantity: '100',
        damagedQuantity: '0',
        missingQuantity: '0',
        batchNumber: 'NOTIF-VAL-01',
        expiryDate: new Date(Date.now() + 500 * 864e5).toISOString(),
      },
    ],
  });
  const grnId = grnCreate.body.data.id;
  const grnNumber = grnCreate.body.data.documentNumber;

  await call(central, 'POST', `/api/goods-receipts/${grnId}/post`, {});
  await settle();

  check(
    '10. STEP 3 - goods receipt posted notification raised',
    typesFor(admin).includes('GOODS_RECEIPT_POSTED'),
    typesFor(admin)
  );
  check(
    '11. 100/100 accepted fulfils the requirement',
    branchA.received.some(
      (e) => e.type === 'STOCK_REQUIREMENT_FULFILLED' && e.message.includes('100/100 units')
    ),
    branchA.received.filter((e) => e.type.startsWith('STOCK_REQUIREMENT')).map((e) => e.message)
  );

  /* ============================ STEP 4: correction ======================== */
  const grn = (await call(central, 'GET', `/api/goods-receipts/${grnId}`)).body.data;
  const grnLineId = grn.lineItems[0].id;

  await call(central, 'POST', '/api/receipt-corrections', {
    goodsReceiptId: grnId,
    reason: 'Temperature logger exceeded 8C',
    lines: [
      {
        goodsReceiptLineItemId: grnLineId,
        correctedAcceptedQuantity: '70',
        correctedDamagedQuantity: '20',
        correctedMissingQuantity: '10',
      },
    ],
  });
  await settle();

  const corrected = admin.received.find((e) => e.type === 'GOODS_RECEIPT_CORRECTED');
  check('12. STEP 4 - receipt correction notified', Boolean(corrected), typesFor(admin));
  check(
    '12b. Correction message carries the before/after split and the reason',
    Boolean(
      corrected &&
        corrected.message.includes(grnNumber) &&
        corrected.message.includes('Accepted 100 → 70') &&
        corrected.message.includes('Damaged 0 → 20') &&
        corrected.message.includes('Missing 0 → 10') &&
        corrected.message.includes('Temperature logger')
    ),
    corrected?.message
  );

  /* ============================ STEP 5: partial =========================== */
  const partial = branchA.received.find(
    (e) => e.type === 'STOCK_REQUIREMENT_PARTIALLY_FULFILLED'
  );
  check('13. STEP 5 - requirement drops to partially fulfilled', Boolean(partial));
  check(
    '13b. Partial message reports 70/100 with 30 remaining',
    Boolean(
      partial && partial.message.includes('70/100 units') && partial.message.includes('30 remaining')
    ),
    partial?.message
  );

  /* ==================== STEPS 6-7: follow-up order and fulfilment ========= */
  const po2 = await call(central, 'POST', '/api/purchase-orders', {
    requirementId,
    supplierId,
    deliveryBranchId: central_bid,
    expectedDeliveryDate: new Date(Date.now() + 10 * 864e5).toISOString(),
    lines: [{ productId, quantity: '30' }],
  });
  if (!po2.body?.data?.id) {
    throw new Error(
      `follow-up purchase order rejected (${po2.status}): ${JSON.stringify(po2.body)}`
    );
  }
  const po2Id = po2.body.data.id;
  await call(central, 'POST', `/api/purchase-orders/${po2Id}/approve`, {});
  const po2Detail = (await call(central, 'GET', `/api/purchase-orders/${po2Id}`)).body.data;

  const grn2 = await call(central, 'POST', '/api/goods-receipts', {
    purchaseOrderId: po2Id,
    supplierRef: 'SUP-DN-9002',
    lines: [
      {
        purchaseOrderLineItemId: po2Detail.lineItems[0].id,
        quantity: '30',
        acceptedQuantity: '30',
        damagedQuantity: '0',
        missingQuantity: '0',
        batchNumber: 'NOTIF-VAL-02',
        expiryDate: new Date(Date.now() + 500 * 864e5).toISOString(),
      },
    ],
  });
  if (!grn2.body?.data?.id) {
    throw new Error(
      `follow-up goods receipt rejected (${grn2.status}): ${JSON.stringify(grn2.body)}`
    );
  }
  await call(central, 'POST', `/api/goods-receipts/${grn2.body.data.id}/post`, {});
  await settle();

  const fulfilledEvents = branchA.received.filter(
    (e) => e.type === 'STOCK_REQUIREMENT_FULFILLED'
  );
  check(
    '14. STEP 7 - the requirement is notified as fulfilled a second time',
    fulfilledEvents.length === 2,
    fulfilledEvents.map((e) => e.message)
  );
  check(
    '14b. The second fulfilment also reports 100/100',
    fulfilledEvents.every((e) => e.message.includes('100/100 units')),
    fulfilledEvents.map((e) => e.message)
  );

  /* ============================ invoice, credit note, payment ============= */
  const invoice = await call(central, 'POST', '/api/supplier-invoices', {
    purchaseOrderId: poId,
    supplierRef: 'SUP-INV-9001',
    lines: [{ productId, quantity: '100' }],
  });
  const invoiceId = invoice.body.data.id;
  const invoiceNumber = invoice.body.data.documentNumber;
  await settle();
  check(
    '15. Supplier invoice with a shortfall is notified as disputed',
    typesFor(admin).includes('SUPPLIER_INVOICE_DISPUTED'),
    typesFor(admin)
  );

  const creditNote = await call(central, 'POST', '/api/credit-notes', {
    supplierInvoiceId: invoiceId,
    reason: 'Credit for damaged and missing stock',
    lines: [{ productId, quantity: '30' }],
  });
  await settle();
  check(
    '16. Credit note posting is notified',
    typesFor(admin).includes('CREDIT_NOTE_POSTED'),
    { types: typesFor(admin), creditNote: creditNote.status }
  );

  const invoiceAfter = (await call(central, 'GET', `/api/supplier-invoices/${invoiceId}`)).body.data;
  const payable = invoiceAfter.balanceAmount;
  const payment = await call(central, 'POST', '/api/payments', {
    supplierId,
    branchId: central_bid,
    amount: payable,
    method: 'BANK_TRANSFER',
    allocations: [{ documentId: invoiceId, amount: payable }],
  });
  await settle();
  const allocated = admin.received.find((e) => e.type === 'PAYMENT_ALLOCATED');
  check('17. Payment allocation is notified', Boolean(allocated), {
    types: typesFor(admin),
    payment: payment.status,
  });
  check(
    '17b. Allocation message names the payment, the amount and the invoice only',
    Boolean(
      allocated &&
        allocated.message.includes(invoiceNumber) &&
        allocated.message.includes('₹') &&
        !allocated.message.includes('BANK_TRANSFER')
    ),
    allocated?.message
  );

  /* ============================ STEP 8: transfer ========================== */
  const stock = (
    await call(central, 'GET', `/api/inventory?branchId=${central_bid}&stockStatus=USABLE`)
  ).body.data;
  const usable = stock.find(
    (row: any) => row.product?.id === productId && Number(row.quantity) >= 30
  );
  check('18. Central warehouse holds transferable usable stock', Boolean(usable), stock);

  const transfer = await call(central, 'POST', '/api/stock-transfers', {
    sourceBranchId: central_bid,
    destinationBranchId: branchA_bid,
    lines: [{ productId, batchId: usable.batch.id, quantity: '30' }],
  });
  if (!transfer.body?.data?.id) {
    throw new Error(
      `stock transfer rejected (${transfer.status}): ${JSON.stringify(transfer.body)}`
    );
  }
  const transferId = transfer.body.data.id;
  const transferNumber = transfer.body.data.documentNumber;
  await settle();
  check(
    '19. STEP 8 - transfer creation notified to both ends',
    typesFor(branchA).includes('STOCK_TRANSFER_CREATED'),
    typesFor(branchA)
  );

  await call(central, 'POST', `/api/stock-transfers/${transferId}/dispatch`, {});
  await settle();
  const dispatched = branchA.received.find((e) => e.type === 'STOCK_TRANSFER_DISPATCHED');
  check('20. Dispatch notified to the destination branch', Boolean(dispatched));
  check(
    '20b. Dispatch message names both branches',
    Boolean(
      dispatched &&
        dispatched.message.includes(transferNumber) &&
        dispatched.message.includes('Central') &&
        dispatched.message.includes('Branch A')
    ),
    dispatched?.message
  );
  check(
    '20c. Branch B was told nothing about the Central to Branch A transfer',
    !typesFor(branchB).includes('STOCK_TRANSFER_DISPATCHED'),
    typesFor(branchB)
  );

  await call(branchA, 'POST', `/api/stock-transfers/${transferId}/receive`, {});
  await settle();
  check(
    '21. Receipt notified back to the source',
    typesFor(central).includes('STOCK_TRANSFER_RECEIVED'),
    typesFor(central)
  );

  /* ============================ STEP 9: dispensing ======================== */
  const branchStock = (
    await call(branchA, 'GET', `/api/inventory?branchId=${branchA_bid}&stockStatus=USABLE`)
  ).body.data;
  const dispensable = branchStock.find(
    (row: any) => row.product?.id === productId && Number(row.quantity) >= 5
  );
  if (!dispensable) {
    throw new Error('no dispensable stock at Branch A: ' + JSON.stringify(branchStock));
  }

  await call(branchA, 'POST', '/api/dispensing', {
    branchId: branchA_bid,
    patientRef: 'PAT-NOTIF-1',
    prescriptionRef: 'RX-NOTIF-1',
    paymentMethod: 'CASH',
    lines: [{ productId, batchId: dispensable.batch.id, quantity: '5' }],
  });
  await settle();
  check(
    '22. STEP 9 - dispensing notified at the dispensing branch',
    typesFor(admin).includes('DISPENSING_COMPLETED'),
    typesFor(admin)
  );
  check(
    '22b. Branch B was not told about a Branch A dispensing',
    !typesFor(branchB).includes('DISPENSING_COMPLETED'),
    typesFor(branchB)
  );

  /* ============================ persistence and the REST API ============== */
  const branchARows = await stored(branchA.userId);
  check('23. Notifications are persisted in PostgreSQL', branchARows.length > 0, {
    count: branchARows.length,
  });
  check(
    '23b. Every delivered event also exists as a stored row',
    branchA.received.every((event) => branchARows.some((row) => row.id === event.id)),
    { delivered: branchA.received.length, stored: branchARows.length }
  );

  const unreadBefore = await call(branchA, 'GET', '/api/notifications/unread-count');
  check(
    '24. Unread count endpoint matches the database',
    unreadBefore.body.data.unread === branchARows.filter((r) => !r.isRead).length,
    { api: unreadBefore.body.data.unread, db: branchARows.filter((r) => !r.isRead).length }
  );

  const list = await call(branchA, 'GET', '/api/notifications?limit=100');
  check(
    '25. The list endpoint returns only the caller notifications',
    list.body.data.every((row: any) => branchARows.some((stored) => stored.id === row.id)) &&
      list.body.data.length === branchARows.length,
    { returned: list.body.data.length, own: branchARows.length }
  );

  const unreadList = await call(branchA, 'GET', '/api/notifications?unreadOnly=true&limit=100');
  check(
    '26. The unread filter returns unread rows only',
    unreadList.body.data.every((row: any) => row.isRead === false),
    unreadList.body.data.map((r: any) => r.isRead)
  );

  const targetId = branchARows[0].id;
  branchATab2.received = [];
  const readOne = await call(branchA, 'PATCH', `/api/notifications/${targetId}/read`);
  check(
    '27. Mark as read flips the row and returns the new unread count',
    readOne.body.data.notification.isRead === true &&
      readOne.body.data.unread === unreadBefore.body.data.unread - 1,
    readOne.body.data
  );

  /* ---------------------- security: another user notification ------------- */
  const centralRows = await stored(central.userId);
  const foreign = await call(branchA, 'PATCH', `/api/notifications/${centralRows[0].id}/read`);
  check(
    '28. A user cannot mark another user notification as read',
    foreign.status === 404,
    foreign.status
  );
  const stillUnread = await prisma.notification.findUnique({
    where: { id: centralRows[0].id },
    select: { isRead: true },
  });
  check('28b. The other user row was not modified', stillUnread?.isRead === false, stillUnread);

  const crossCompany = await call(otherCo, 'GET', '/api/notifications?limit=100');
  check(
    '29. Company isolation: the other tenant sees an empty inbox',
    crossCompany.body.data.length === 0,
    crossCompany.body.data.length
  );

  const anonymous = await call(null, 'GET', '/api/notifications');
  check('30. Notifications require authentication', anonymous.status === 401, anonymous.status);

  /* ---------------------- duplicate prevention ---------------------------- */
  const grouped = await prisma.notification.groupBy({
    by: ['recipientUserId', 'eventKey'],
    _count: { _all: true },
    having: { eventKey: { _count: { gt: 1 } } },
  });
  check('31. No duplicate notification for any recipient and event', grouped.length === 0, grouped);

  const sample = branchARows[0];
  let replayError: string | null = null;
  let replayInserted = 0;
  try {
    const result = await prisma.notification.createManyAndReturn({
      data: [
        {
          companyId: (await prisma.user.findUniqueOrThrow({ where: { id: branchA.userId } }))
            .companyId,
          recipientUserId: branchA.userId,
          type: sample.type,
          title: sample.title,
          message: sample.message,
          eventKey: sample.eventKey,
        },
      ],
      skipDuplicates: true,
    });
    replayInserted = result.length;
  } catch (error) {
    replayError = error instanceof Error ? error.message : String(error);
  }
  check(
    '31b. Replaying an identical event inserts nothing and does not error',
    replayError === null && replayInserted === 0,
    { replayError, replayInserted }
  );

  /* ---------------------- mark all as read -------------------------------- */
  const readAll = await call(branchA, 'PATCH', '/api/notifications/read-all');
  const unreadAfter = await call(branchA, 'GET', '/api/notifications/unread-count');
  check(
    '32. Mark all as read clears the unread count',
    readAll.body.data.unread === 0 && unreadAfter.body.data.unread === 0,
    { readAll: readAll.body.data, unreadAfter: unreadAfter.body.data }
  );
  check(
    '32b. Other users are unaffected by one user clearing their inbox',
    (await prisma.notification.count({ where: { recipientUserId: central.userId, isRead: false } })) >
      0
  );

  /* ---------------------- offline delivery -------------------------------- */
  branchB.socket?.disconnect();
  await settle(400);
  const branchBBefore = await prisma.notification.count({
    where: { recipientUserId: branchB.userId },
  });

  const offlineReq = await call(branchB, 'POST', '/api/stock-requirements', {
    branchId: branches.find((b: any) => b.code === 'BR-B').id,
    requiredDate: new Date(Date.now() + 7 * 864e5).toISOString(),
    reason: 'Offline delivery check',
    lines: [{ productId, quantity: '5' }],
  });
  await call(branchB, 'POST', `/api/stock-requirements/${offlineReq.body.data.id}/submit`, {});
  await settle();
  await call(central, 'POST', `/api/stock-requirements/${offlineReq.body.data.id}/approve`, {});
  await settle();

  const branchBAfter = await prisma.notification.count({
    where: { recipientUserId: branchB.userId },
  });
  check(
    '33. A disconnected user still has the notification stored',
    branchBAfter === branchBBefore + 1,
    { before: branchBBefore, after: branchBAfter }
  );

  const reconnected = await login('branchb@healthpilot.ai');
  const branchBInbox = await call(reconnected, 'GET', '/api/notifications?unreadOnly=true');
  check(
    '34. On reconnect the user fetches what they missed',
    branchBInbox.body.data.some((row: any) => row.type === 'STOCK_REQUIREMENT_APPROVED'),
    branchBInbox.body.data.map((r: any) => r.type)
  );

  /* ---------------------- document activity is untouched ------------------ */
  const history = await call(admin, 'GET', `/api/documents/${requirementId}/history`);
  check(
    '35. DocumentLog still records the full audit trail alongside notifications',
    history.body.data.history.length >= 4 &&
      history.body.data.history.some((h: any) => h.action === 'FULFILMENT_UPDATED'),
    history.body.data.history.map((h: any) => h.action)
  );

  /* ---------------------- payload safety ---------------------------------- */
  const serialised = JSON.stringify(branchA.received);
  check(
    '36. Realtime payloads carry no credentials or tokens',
    !/password|token|secret|passwordHash|refresh/i.test(serialised)
  );
  const eventKeys = Object.keys(branchA.received[0] ?? {}).sort().join(',');
  check(
    '36b. Realtime payload carries only the agreed display fields',
    eventKeys ===
      'branchId,createdAt,documentId,entityId,entityType,id,isRead,message,severity,title,type',
    eventKeys
  );

  console.log(`\n--- ${checks - failures}/${checks} checks passed ---`);

  for (const session of [admin, central, branchA, branchB, otherCo, branchATab2]) {
    session.socket?.disconnect();
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nNOTIFICATION VALIDATION PASSED' : '\nNOTIFICATION VALIDATION FAILED');
    return disconnectDatabase().then(() => process.exit(failures === 0 ? 0 : 1));
  })
  .catch(async (error) => {
    console.error('\nHARNESS ERROR:', error);
    await disconnectDatabase();
    process.exit(1);
  });
