/**
 * End-to-end validation of inter-branch stock fulfilment against a running API.
 *
 * Drives the whole question a branch faces before it orders anything - can this
 * requirement be met from stock we already own? - as real users over HTTP:
 * availability, the sourcing plan, the surplus guardrail that runs before a
 * purchase order, transfers raised against a requirement, dispatch, receipt, the
 * combined fulfilment status, the purchase order cap that follows from it,
 * branch authorisation, company isolation and concurrency.
 *
 * It needs a seeded database and a running server. Unlike the notification
 * harness it CLEARS NOTHING and deletes nothing: every run creates its own
 * products, batches and opening stock under a unique run tag, so it is additive
 * and repeatable, and existing documents are never touched.
 *
 *   npm run verify:internal-fulfilment
 *
 * Opening stock has no API - it is the one thing written straight to the ledger
 * here, because a branch cannot be given a starting position through any
 * document the system models.
 */
import { InventoryTransactionType, StockStatus } from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/prisma';

const API = process.env.VERIFY_API ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

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

function section(title: string) {
  console.log(`\n--- ${title} ---`);
}

interface Session {
  email: string;
  userId: string;
  token: string;
}

/**
 * One request, retried once if the access token aged out mid-run.
 *
 * A full pass is several hundred sequential calls against a remote database and
 * takes comfortably longer than the 15-minute access token, so without this the
 * suite cannot finish in one process however healthy the system under test is -
 * it just stops partway with a 401 that says nothing about the ERP.
 *
 * The retry is deliberately confined to a caller that HAS a session. The checks
 * that assert an endpoint demands authentication pass `null`, so they are never
 * retried and still see their 401.
 */
async function call(
  session: Session | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const send = () =>
    fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let response = await send();
  if (response.status === 401 && session) {
    // Sessions are shared objects, so refreshing one here refreshes it for
    // every later call that holds the same reference.
    session.token = (await login(session.email)).token;
    response = await send();
  }

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
  return { email, userId: payload.data.user.id, token: payload.data.accessToken };
}

/** Fails loudly rather than letting a bad setup masquerade as a failed assertion. */
function expectOk(label: string, result: { status: number; body: any }) {
  if (!result.body?.success) {
    throw new Error(`${label} failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result.body.data;
}

/**
 * Which parts of the suite to run.
 *
 * The whole thing is several hundred sequential HTTP calls against a remote
 * database, which over a slow or serverless connection is long enough that a
 * single transient fault loses the entire run. Splitting it lets a change be
 * verified against the part it touches, and the halves can be run back to back
 * for a full pass:
 *
 *   VERIFY_SECTIONS=sourcing npm run verify:internal-fulfilment
 *   VERIFY_SECTIONS=surplus  npm run verify:internal-fulfilment
 *   VERIFY_SECTIONS=core     npm run verify:internal-fulfilment
 *
 * Unset runs everything, which is still the default.
 */
const SECTION = { core: 'core', sourcing: 'sourcing', surplus: 'surplus' } as const;

const REQUESTED_SECTIONS = (process.env.VERIFY_SECTIONS ?? '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

function runSection(name: string): boolean {
  return REQUESTED_SECTIONS.length === 0 || REQUESTED_SECTIONS.includes(name);
}

const RUN = Date.now().toString(36).toUpperCase();
const future = (years: number) =>
  new Date(Date.now() + years * 365 * 24 * 3600 * 1000).toISOString();

async function main() {
  console.log('--- inter-branch stock fulfilment validation ---');
  console.log(`run tag: ${RUN}`);
  console.log(
    `sections: ${REQUESTED_SECTIONS.length === 0 ? 'all' : REQUESTED_SECTIONS.join(', ')}\n`
  );

  /* ------------------------------------------------------------- setup ---- */

  const company = await prisma.company.findFirst({ where: { code: { not: '' } } });
  if (!company) {
    throw new Error('No company found. Seed the database first.');
  }

  const branchRows = await prisma.branch.findMany({
    where: { companyId: company.id },
    select: { id: true, code: true, name: true },
  });
  const branch = Object.fromEntries(branchRows.map((b) => [b.code, b])) as Record<
    string,
    { id: string; code: string; name: string }
  >;
  for (const code of ['BR-A', 'BR-B', 'BR-C', 'BR-CENTRAL']) {
    if (!branch[code]) {
      throw new Error(`Branch ${code} is missing. Seed the database first.`);
    }
  }

  const supplier = await prisma.supplier.findFirst({ where: { companyId: company.id } });
  if (!supplier) {
    throw new Error('No supplier found. Seed the database first.');
  }

  const admin = await login('admin@healthpilot.ai');
  const central = await login('central@healthpilot.ai');
  const branchA = await login('brancha@healthpilot.ai');
  const branchB = await login('branchb@healthpilot.ai');

  /** A product nothing else in the database touches, so figures are unambiguous. */
  async function makeProduct(tag: string) {
    return prisma.product.create({
      data: {
        companyId: company!.id,
        code: `PRD-IFT-${RUN}-${tag}`,
        name: `Internal Fulfilment Test ${RUN} ${tag}`,
        unit: 'Vial',
        purchasePrice: '500.00',
        sellingPrice: '650.00',
        taxRate: '5.00',
      },
    });
  }

  async function makeBatch(productId: string, batchNumber: string, years = 3) {
    return prisma.batch.create({
      data: {
        companyId: company!.id,
        productId,
        batchNumber: `${batchNumber}-${RUN}`,
        expiryDate: new Date(future(years)),
        status: StockStatus.USABLE,
      },
    });
  }

  /**
   * Opening stock straight into the ledger. This is the only write here that does
   * not go through the API, because the system has no opening-balance document.
   */
  async function openingStock(
    branchId: string,
    productId: string,
    batchId: string,
    quantity: string,
    unitCost: string
  ) {
    await prisma.inventoryTransaction.create({
      data: {
        companyId: company!.id,
        branchId,
        productId,
        batchId,
        transactionType: InventoryTransactionType.OPENING_BALANCE,
        quantity,
        unitCost,
        totalCost: (Number(quantity) * Number(unitCost)).toFixed(2),
        stockStatus: StockStatus.USABLE,
        createdById: admin.userId,
        notes: `verify:internal-fulfilment ${RUN}`,
      },
    });
  }

  /** REQ raised by Branch A and approved by central, which is the real flow. */
  async function approvedRequirement(productId: string, quantity: string, reason: string) {
    const created = expectOk(
      'create requirement',
      await call(branchA, 'POST', '/api/stock-requirements', {
        branchId: branch['BR-A'].id,
        requiredDate: future(0.02),
        reason,
        lines: [{ productId, quantity }],
      })
    );
    expectOk(
      'submit requirement',
      await call(branchA, 'POST', `/api/stock-requirements/${created.id}/submit`, {})
    );
    expectOk(
      'approve requirement',
      await call(central, 'POST', `/api/stock-requirements/${created.id}/approve`, {})
    );
    return created;
  }

  /**
   * The same flow at any branch, as any caller. The surplus tests need
   * requirements at the branches that HOLD stock, which is how a source branch
   * comes to have demand of its own, and one of them belongs to the other tenant.
   */
  async function approvedRequirementAs(
    session: Session,
    branchId: string,
    productId: string,
    quantity: string,
    reason: string
  ) {
    const created = expectOk(
      'create requirement',
      await call(session, 'POST', '/api/stock-requirements', {
        branchId,
        requiredDate: future(0.02),
        reason,
        lines: [{ productId, quantity }],
      })
    );
    expectOk(
      'submit requirement',
      await call(session, 'POST', `/api/stock-requirements/${created.id}/submit`, {})
    );
    expectOk(
      'approve requirement',
      await call(session, 'POST', `/api/stock-requirements/${created.id}/approve`, {})
    );
    return created;
  }

  const availability = async (session: Session, requirementId: string) =>
    call(session, 'GET', `/api/stock-requirements/${requirementId}/internal-availability`);

  const requirementStatus = async (requirementId: string) => {
    const detail = expectOk(
      'read requirement',
      await call(admin, 'GET', `/api/stock-requirements/${requirementId}`)
    );
    return detail.status as string;
  };

  /** Raise, dispatch and receive a transfer for a requirement, end to end. */
  async function transferFor(
    requirementId: string,
    sourceBranchId: string,
    lines: { productId: string; batchId: string; quantity: string }[]
  ) {
    const transfer = expectOk(
      'create transfer',
      await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId,
        destinationBranchId: branch['BR-A'].id,
        requirementId,
        lines,
      })
    );
    return transfer;
  }

  const dispatchTransfer = (id: string) =>
    call(admin, 'POST', `/api/stock-transfers/${id}/dispatch`, {});
  const receiveTransfer = (id: string) =>
    call(admin, 'POST', `/api/stock-transfers/${id}/receive`, {});

  /**
   * A supplier order fully received as usable stock, against a requirement.
   *
   * Raised by the company admin rather than the seeded central user, because the
   * latter is scoped to the central warehouse and so may not name Branch A as the
   * delivery branch. The regression section below keeps the central user on the
   * central-warehouse route the product walkthrough actually describes.
   */
  async function procure(
    requirementId: string,
    productId: string,
    quantity: string,
    tag: string,
    unitPrice?: string
  ) {
    const order = expectOk(
      'create purchase order',
      await call(admin, 'POST', '/api/purchase-orders', {
        requirementId,
        supplierId: supplier!.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId, quantity, ...(unitPrice ? { unitPrice } : {}) }],
      })
    );
    expectOk(
      'approve purchase order',
      await call(admin, 'POST', `/api/purchase-orders/${order.id}/approve`, {})
    );
    const receipt = expectOk(
      'create goods receipt',
      await call(admin, 'POST', '/api/goods-receipts', {
        purchaseOrderId: order.id,
        supplierRef: `SREF-${RUN}-${tag}`,
        lines: [
          {
            purchaseOrderLineItemId: order.lineItems[0].id,
            quantity,
            acceptedQuantity: quantity,
            damagedQuantity: '0',
            missingQuantity: '0',
            batchNumber: `SUP-${RUN}-${tag}`,
            expiryDate: future(3),
          },
        ],
      })
    );
    expectOk(
      'post goods receipt',
      await call(admin, 'POST', `/api/goods-receipts/${receipt.id}/post`, {})
    );
    return { order, receipt };
  }

  if (runSection(SECTION.core)) {
    /* ------------------------------------------------------------ TEST 1 ---- */
    section('TEST 1 - no internal stock: procurement workflow unchanged');
    {
      const product = await makeProduct('T1');
      const requirement = await approvedRequirement(product.id, '100', `T1 ${RUN}`);

      const result = expectOk('availability', await availability(central, requirement.id));
      check('1a. Internal availability is zero', result.totals.internalAvailable === '0.00', result.totals);
      check('1b. Whole requirement falls to procurement', result.totals.procurementShortfall === '100.00', result.totals);
      check('1c. No source branches are offered', result.lines[0].sources.length === 0);

      await procure(requirement.id, product.id, '100', 'T1');
      check('1d. Procurement alone still reaches FULFILLED', (await requirementStatus(requirement.id)) === 'FULFILLED');
    }

    /* ------------------------------------------------------------ TEST 2 ---- */
    section('TEST 2 - 40 internal + 60 supplier reaches FULFILLED');
    {
      const product = await makeProduct('T2');
      const batch = await makeBatch(product.id, 'T2B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `T2 ${RUN}`);

      const before = expectOk('availability', await availability(central, requirement.id));
      check('2a. 40 shown as internally available', before.totals.internalAvailable === '40.00', before.totals);
      check('2b. 60 shown as the procurement shortfall', before.totals.procurementShortfall === '60.00', before.totals);
      check('2c. Branch B is named as the source', before.lines[0].sources[0]?.branch.code === 'BR-B');
      check('2d. Suggested quantity is capped at the shortfall', before.lines[0].sources[0]?.suggested === '40.00');
      check('2e. Source unit cost is the ledger cost, not the price list', before.lines[0].sources[0]?.unitCost === '500.00');

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '40' },
      ]);
      check('2f. Transfer is linked to the requirement', Boolean(transfer.links.outgoing.find((l: any) => l.linkType === 'TRANSFER_FOR' && l.document.id === requirement.id)), transfer.links);

      // TEST 22/34: the order cap must already reflect the transfer in flight.
      const overOrder = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '61' }],
      });
      check('2g. A purchase order for 61 is refused while 40 is in transit', overOrder.status === 409, overOrder.body?.message);

      expectOk('dispatch', await dispatchTransfer(transfer.id));
      check('2h. Dispatch alone does not fulfil the requirement', (await requirementStatus(requirement.id)) === 'APPROVED');

      expectOk('receive', await receiveTransfer(transfer.id));
      check('2i. Receipt makes it PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');

      const mid = expectOk('availability', await availability(central, requirement.id));
      check('2j. 40 now counted as fulfilled', mid.lines[0].fulfilled === '40.00', mid.lines[0]);
      check('2k. 60 still outstanding', mid.lines[0].outstanding === '60.00', mid.lines[0]);

      await procure(requirement.id, product.id, '60', 'T2');
      check('2l. Internal 40 + supplier 60 reaches FULFILLED', (await requirementStatus(requirement.id)) === 'FULFILLED');

      // Destination stock must have arrived at Branch A carrying the source cost.
      const arrived = await prisma.inventoryTransaction.findFirst({
        where: { documentId: transfer.id, transactionType: InventoryTransactionType.TRANSFER_IN },
      });
      check('2m. Branch A received 40 at the source cost of 500.00', arrived?.quantity.toFixed(2) === '40.00' && arrived?.unitCost.toFixed(2) === '500.00', { qty: arrived?.quantity, cost: arrived?.unitCost });
      check('2n. Received stock is at the destination branch', arrived?.branchId === branch['BR-A'].id);
      check('2o. Batch identity is preserved across the transfer', arrived?.batchId === batch.id);
    }

    /* ------------------------------------------------------------ TEST 3 ---- */
    section('TEST 3 - 40 internal + 30 supplier stays PARTIALLY_FULFILLED');
    {
      const product = await makeProduct('T3');
      const batch = await makeBatch(product.id, 'T3B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `T3 ${RUN}`);

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '40' },
      ]);
      expectOk('dispatch', await dispatchTransfer(transfer.id));
      expectOk('receive', await receiveTransfer(transfer.id));
      await procure(requirement.id, product.id, '30', 'T3');

      check('3a. 70 of 100 leaves it PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');
      const result = expectOk('availability', await availability(central, requirement.id));
      check('3b. Fulfilled reads 70', result.lines[0].fulfilled === '70.00', result.lines[0]);
      check('3c. Remaining reads 30', result.lines[0].outstanding === '30.00', result.lines[0]);
    }

    /* ------------------------------------------------------------ TEST 4 ---- */
    section('TEST 4 - three source branches plus a supplier');
    {
      const product = await makeProduct('T4');
      const batchB = await makeBatch(product.id, 'T4B');
      const batchC = await makeBatch(product.id, 'T4C');
      const batchCentral = await makeBatch(product.id, 'T4CEN');
      await openingStock(branch['BR-B'].id, product.id, batchB.id, '40', '500.00');
      await openingStock(branch['BR-C'].id, product.id, batchC.id, '20', '480.00');
      await openingStock(branch['BR-CENTRAL'].id, product.id, batchCentral.id, '10', '520.00');

      const requirement = await approvedRequirement(product.id, '100', `T4 ${RUN}`);
      const plan = expectOk('availability', await availability(central, requirement.id));
      check('4a. 70 available across three branches', plan.totals.internalAvailable === '70.00', plan.totals);
      check('4b. 30 left for the supplier', plan.totals.procurementShortfall === '30.00', plan.totals);
      check('4c. All three branches are listed', plan.lines[0].sources.length === 3, plan.lines[0].sources.map((s: any) => s.branch.code));

      for (const [branchCode, batchId] of [
        ['BR-B', batchB.id],
        ['BR-C', batchC.id],
        ['BR-CENTRAL', batchCentral.id],
      ] as const) {
        const quantity = branchCode === 'BR-B' ? '40' : branchCode === 'BR-C' ? '20' : '10';
        const transfer = await transferFor(requirement.id, branch[branchCode].id, [
          { productId: product.id, batchId, quantity },
        ]);
        expectOk('dispatch', await dispatchTransfer(transfer.id));
        expectOk('receive', await receiveTransfer(transfer.id));
      }

      check('4d. 70 internal leaves it PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');
      await procure(requirement.id, product.id, '30', 'T4');
      check('4e. Adding the supplier 30 reaches FULFILLED', (await requirementStatus(requirement.id)) === 'FULFILLED');

      const detail = expectOk('read requirement', await call(admin, 'GET', `/api/stock-requirements/${requirement.id}`));
      const transferLinks = detail.links.incoming.filter((l: any) => l.linkType === 'TRANSFER_FOR');
      const orderLinks = detail.links.incoming.filter((l: any) => l.linkType === 'FULFILLS');
      check('4f. All three transfers are traceable from the requirement', transferLinks.length === 3, transferLinks.length);
      check('4g. The purchase order is traceable alongside them', orderLinks.length === 1, orderLinks.length);
    }

    /* ------------------------------------------------------------ TEST 5 ---- */
    section('TEST 5 - internal stock alone can fulfil the whole requirement');
    {
      const product = await makeProduct('T5');
      const batch = await makeBatch(product.id, 'T5B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '100', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `T5 ${RUN}`);

      const plan = expectOk('availability', await availability(central, requirement.id));
      check('5a. Nothing needs a supplier', plan.totals.procurementShortfall === '0.00', plan.totals);

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '100' },
      ]);
      expectOk('dispatch', await dispatchTransfer(transfer.id));
      expectOk('receive', await receiveTransfer(transfer.id));
      check('5b. FULFILLED with no purchase order at all', (await requirementStatus(requirement.id)) === 'FULFILLED');

      const blocked = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '1' }],
      });
      check('5c. A fulfilled requirement accepts no further order', blocked.status === 409, blocked.body?.message);
    }

    /* ------------------------------------------------------------ TEST 6 ---- */
    section('TEST 6 - dispatched but unreceived stock never counts');
    {
      const product = await makeProduct('T6');
      const batch = await makeBatch(product.id, 'T6B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `T6 ${RUN}`);

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '40' },
      ]);
      check('6a. Creating the transfer does not fulfil', (await requirementStatus(requirement.id)) === 'APPROVED');

      expectOk('dispatch', await dispatchTransfer(transfer.id));
      const afterDispatch = expectOk('availability', await availability(central, requirement.id));
      check('6b. Dispatch leaves the requirement APPROVED', (await requirementStatus(requirement.id)) === 'APPROVED');
      check('6c. Dispatched stock counts as in transit, not fulfilled', afterDispatch.lines[0].fulfilled === '0.00' && afterDispatch.lines[0].onTransfer === '40.00', afterDispatch.lines[0]);

      // Source stock has genuinely left Branch B, and has not yet arrived.
      const sourceStock = await call(admin, 'GET', `/api/inventory?branchId=${branch['BR-B'].id}&productId=${product.id}`);
      const sourceQty = expectOk('source stock', sourceStock).reduce((acc: number, row: any) => acc + Number(row.quantity), 0);
      check('6d. Source branch is down 40 at dispatch', sourceQty === 0, sourceQty);

      expectOk('receive', await receiveTransfer(transfer.id));
      check('6e. Only receipt moves it to PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');
    }

    /* ------------------------------------------------------------ TEST 7 ---- */
    section('TEST 7 - concurrent transfers cannot oversell a bucket');
    {
      const product = await makeProduct('T7');
      const batch = await makeBatch(product.id, 'T7B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');

      // Two independent requirements, so the requirement cap cannot be what stops
      // the second transfer: the stock bucket has to be.
      const first = await approvedRequirement(product.id, '30', `T7a ${RUN}`);
      const second = await approvedRequirement(product.id, '30', `T7b ${RUN}`);

      const body = (requirementId: string) => ({
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '30' }],
      });

      const [a, b] = await Promise.all([
        call(admin, 'POST', '/api/stock-transfers', body(first.id)),
        call(admin, 'POST', '/api/stock-transfers', body(second.id)),
      ]);

      const created = [a, b].filter((r) => r.body?.success);
      const refused = [a, b].filter((r) => !r.body?.success);
      check('7a. Exactly one of two simultaneous 30-unit transfers succeeds', created.length === 1 && refused.length === 1, { a: a.status, b: b.status });
      check('7b. The loser is refused as a stock conflict', refused[0]?.status === 409, refused[0]?.body?.message);

      const remaining = expectOk('branch B stock', await call(admin, 'GET', `/api/inventory?branchId=${branch['BR-B'].id}&productId=${product.id}`));
      const remainingQty = remaining.reduce((acc: number, row: any) => acc + Number(row.quantity), 0);
      check('7c. Branch B still holds the full 40 on the ledger until dispatch', remainingQty === 40, remainingQty);

      // The winning transfer has reserved 30 of the 40, so only 10 remains
      // sourceable even though the ledger still shows the full quantity.
      const third = await approvedRequirement(product.id, '30', `T7c ${RUN}`);
      const sourcePlan = expectOk('availability', await availability(central, third.id));
      check('7e. Committed stock is no longer offered as available', sourcePlan.totals.internalAvailable === '10.00', sourcePlan.totals);

      const overdraw = await call(admin, 'POST', '/api/stock-transfers', body(third.id));
      check('7f. A third 30-unit transfer is refused against the 10 that are left', overdraw.status === 409, overdraw.body?.message);

      // And the winner cannot then be dispatched twice over the same stock.
      const winner = created[0].body.data;
      expectOk('dispatch winner', await dispatchTransfer(winner.id));
      const secondDispatch = await dispatchTransfer(winner.id);
      check('7d. A transfer cannot be dispatched twice', !secondDispatch.body?.success, secondDispatch.body?.message);
    }

    /* ------------------------------------------------------------ TEST 8 ---- */
    section('TEST 8 - per-batch costs survive the transfer');
    {
      const product = await makeProduct('T8');
      const cheap = await makeBatch(product.id, 'T8-CHEAP', 2);
      const dear = await makeBatch(product.id, 'T8-DEAR', 4);
      await openingStock(branch['BR-B'].id, product.id, cheap.id, '20', '450.00');
      await openingStock(branch['BR-B'].id, product.id, dear.id, '30', '500.00');

      const requirement = await approvedRequirement(product.id, '30', `T8 ${RUN}`);
      const plan = expectOk('availability', await availability(central, requirement.id));
      const sources = plan.lines[0].sources;

      check('8a. Both batches are offered as distinct buckets', sources.length === 2, sources.length);
      check('8b. Costs are not averaged across batches', sources.some((s: any) => s.unitCost === '450.00') && sources.some((s: any) => s.unitCost === '500.00'), sources.map((s: any) => s.unitCost));
      check('8c. The batch expiring first is offered first', sources[0].unitCost === '450.00', sources[0]);
      check('8d. The plan proposes 20 from the first batch and 10 from the second', sources[0].suggested === '20.00' && sources[1].suggested === '10.00', sources.map((s: any) => s.suggested));

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: cheap.id, quantity: '20' },
        { productId: product.id, batchId: dear.id, quantity: '10' },
      ]);
      expectOk('dispatch', await dispatchTransfer(transfer.id));
      expectOk('receive', await receiveTransfer(transfer.id));

      const arrivals = await prisma.inventoryTransaction.findMany({
        where: { documentId: transfer.id, transactionType: InventoryTransactionType.TRANSFER_IN },
        select: { batchId: true, quantity: true, unitCost: true, totalCost: true },
      });
      const cheapRow = arrivals.find((r) => r.batchId === cheap.id);
      const dearRow = arrivals.find((r) => r.batchId === dear.id);
      check('8e. 20 arrive at 450.00 under their own batch', cheapRow?.quantity.toFixed(2) === '20.00' && cheapRow?.unitCost.toFixed(2) === '450.00', cheapRow);
      check('8f. 10 arrive at 500.00 under theirs', dearRow?.quantity.toFixed(2) === '10.00' && dearRow?.unitCost.toFixed(2) === '500.00', dearRow);

      // Cost accounting: value leaving the source equals value arriving, and no
      // payable or revenue is created by an internal move.
      const out = await prisma.inventoryTransaction.aggregate({
        where: { documentId: transfer.id, transactionType: InventoryTransactionType.TRANSFER_OUT },
        _sum: { totalCost: true },
      });
      const inbound = await prisma.inventoryTransaction.aggregate({
        where: { documentId: transfer.id, transactionType: InventoryTransactionType.TRANSFER_IN },
        _sum: { totalCost: true },
      });
      check('8g. Value out equals value in (14,000.00)', Math.abs(Number(out._sum.totalCost)) === 14000 && Number(inbound._sum.totalCost) === 14000, { out: out._sum.totalCost, in: inbound._sum.totalCost });

      const allocations = await prisma.paymentAllocation.count({ where: { documentId: transfer.id } });
      check('8h. An internal transfer creates no payment allocation', allocations === 0, allocations);
      const transferDoc = await prisma.document.findUnique({ where: { id: transfer.id }, select: { supplierId: true, totalAmount: true, balanceAmount: true } });
      check('8i. No supplier is attached to an internal transfer', transferDoc?.supplierId === null);
      check('8j. Nothing is left outstanding to pay', transferDoc?.balanceAmount.toFixed(2) === '0.00', transferDoc?.balanceAmount);
    }

    /* --------------------------------------------------------- security ---- */
    section('SECURITY - branch authorisation and company isolation');
    {
      const product = await makeProduct('SEC');
      const batch = await makeBatch(product.id, 'SECB');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `SEC ${RUN}`);

      const asBranchA = expectOk('availability as branch A', await availability(branchA, requirement.id));
      check('S1. Branch A is told how much exists internally', asBranchA.totals.internalAvailable === '40.00', asBranchA.totals);
      check('S2. Branch A is NOT shown which branch holds it', asBranchA.lines[0].sources.length === 0, asBranchA.lines[0].sources);
      check('S3. Branch A is told detail is being withheld', asBranchA.detailRestricted === true && asBranchA.lines[0].withheldBranchCount === 1, asBranchA.lines[0]);
      check('S4. Branch A is not offered the transfer action', asBranchA.canCreateTransfer === false);

      const asCentral = expectOk('availability as central', await availability(central, requirement.id));
      check('S5. Central procurement sees the branch breakdown', asCentral.lines[0].sources[0]?.branch.code === 'BR-B', asCentral.lines[0].sources);
      check('S6. Central procurement is offered the transfer action', asCentral.canCreateTransfer === true);

      // Branch B holds the stock but has no business reading another branch's
      // requirement at all, so the availability view inherits that refusal rather
      // than becoming a way around it.
      const branchBView = await availability(branchB, requirement.id);
      check('S7. Branch B cannot read another branch requirement at all', branchBView.status === 403, { status: branchBView.status, message: branchBView.body?.message });

      // Branch A cannot raise the transfer itself.
      const forbiddenTransfer = await call(branchA, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '40' }],
      });
      check('S8. Branch A cannot raise a transfer out of Branch B', forbiddenTransfer.status === 403, { status: forbiddenTransfer.status, message: forbiddenTransfer.body?.message });

      // A transfer must land where the requirement was raised.
      const wrongDestination = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-C'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '10' }],
      });
      check('S9. A transfer to a third branch cannot claim the requirement', wrongDestination.status === 400, wrongDestination.body?.message);

      // A product that is not on the requirement cannot ride along.
      const otherProduct = await makeProduct('SEC2');
      const otherBatch = await makeBatch(otherProduct.id, 'SEC2B');
      await openingStock(branch['BR-B'].id, otherProduct.id, otherBatch.id, '10', '500.00');
      const foreignProduct = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: otherProduct.id, batchId: otherBatch.id, quantity: '10' }],
      });
      check('S10. A product not on the requirement is refused', foreignProduct.status === 400, foreignProduct.body?.message);

      const unauthenticated = await call(null, 'GET', `/api/stock-requirements/${requirement.id}/internal-availability`);
      check('S11. Availability requires authentication', unauthenticated.status === 401);

      const bogus = await call(central, 'GET', '/api/stock-requirements/not-a-uuid/internal-availability');
      check('S12. A malformed id is rejected by validation', bogus.status === 400, bogus.status);

      const missing = await call(central, 'GET', '/api/stock-requirements/11111111-1111-4111-8111-111111111111/internal-availability');
      check('S13. An unknown requirement is a 404', missing.status === 404, missing.status);
    }

    /* -------------------------------------------- expiry and usability ---- */
    section('SOURCING RULES - expired and unusable stock is never offered');
    {
      const product = await makeProduct('EXP');
      const good = await makeBatch(product.id, 'EXP-GOOD', 3);
      const expired = await prisma.batch.create({
        data: {
          companyId: company.id,
          productId: product.id,
          batchNumber: `EXP-OLD-${RUN}`,
          expiryDate: new Date(Date.now() - 24 * 3600 * 1000),
          status: StockStatus.USABLE,
        },
      });
      const quarantined = await prisma.batch.create({
        data: {
          companyId: company.id,
          productId: product.id,
          batchNumber: `EXP-QUAR-${RUN}`,
          expiryDate: new Date(future(3)),
          status: StockStatus.QUARANTINED,
        },
      });
      await openingStock(branch['BR-B'].id, product.id, good.id, '15', '500.00');
      await openingStock(branch['BR-B'].id, product.id, expired.id, '50', '500.00');
      await openingStock(branch['BR-B'].id, product.id, quarantined.id, '50', '500.00');

      // Damaged stock of the good batch must be ignored too.
      await prisma.inventoryTransaction.create({
        data: {
          companyId: company.id,
          branchId: branch['BR-B'].id,
          productId: product.id,
          batchId: good.id,
          transactionType: InventoryTransactionType.DAMAGE,
          quantity: '25',
          unitCost: '500.00',
          totalCost: '12500.00',
          stockStatus: StockStatus.DAMAGED,
          createdById: admin.userId,
          notes: `verify:internal-fulfilment ${RUN}`,
        },
      });

      const requirement = await approvedRequirement(product.id, '100', `EXP ${RUN}`);
      const plan = expectOk('availability', await availability(central, requirement.id));
      check('E1. Only the 15 usable, unexpired units are offered', plan.totals.internalAvailable === '15.00', plan.totals);
      check('E2. Expired, quarantined and damaged stock is excluded', plan.lines[0].sources.length === 1 && plan.lines[0].sources[0].batch.batchNumber === good.batchNumber, plan.lines[0].sources);
      check('E3. The rest falls to procurement', plan.totals.procurementShortfall === '85.00', plan.totals);
    }

    /* ---------------------------------- self-sourcing and requirement cap ---- */
    section('SOURCING RULES - a branch never sources from itself');
    {
      const product = await makeProduct('SELF');
      const batch = await makeBatch(product.id, 'SELFB');
      await openingStock(branch['BR-A'].id, product.id, batch.id, '80', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `SELF ${RUN}`);

      const plan = expectOk('availability', await availability(central, requirement.id));
      check('F1. Stock already at the requesting branch is not internal availability', plan.totals.internalAvailable === '0.00', plan.totals);
      check('F2. The whole requirement still falls to procurement', plan.totals.procurementShortfall === '100.00', plan.totals);
    }

    section('SOURCING RULES - a transfer cannot exceed what is outstanding');
    {
      const product = await makeProduct('CAP');
      const batch = await makeBatch(product.id, 'CAPB');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '200', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `CAP ${RUN}`);

      const tooMuch = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '101' }],
      });
      check('G1. A transfer of 101 against a 100 requirement is refused', tooMuch.status === 409, tooMuch.body?.message);

      const plan = expectOk('availability', await availability(central, requirement.id));
      check('G2. Availability is capped at the requirement, not the shelf', plan.totals.internalAvailable === '100.00', plan.totals);

      const ok = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '100' }],
      });
      check('G3. A transfer of exactly 100 is accepted', ok.body?.success === true, ok.body?.message);

      const second = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '1' }],
      });
      check('G4. A second transfer for the same shortfall is refused', second.status === 409, second.body?.message);
    }

  }

  if (runSection(SECTION.sourcing)) {
    /* -------------------------------------------- sourcing analysis (S1-S4) ---- */
    section('SOURCING ANALYSIS - internal stock and supplier comparison together');

    const sourcing = async (session: Session | null, requirementId: string) =>
      call(session, 'GET', `/api/stock-requirements/${requirementId}/sourcing-analysis`);

    {
      // S1: three internal sources covering 90 of 100, supplier asked for the rest.
      const product = await makeProduct('S1');
      const batchB = await makeBatch(product.id, 'S1B');
      const batchC = await makeBatch(product.id, 'S1C', 4);
      const batchCentral = await makeBatch(product.id, 'S1CEN', 5);
      await openingStock(branch['BR-B'].id, product.id, batchB.id, '40', '450.00');
      await openingStock(branch['BR-C'].id, product.id, batchC.id, '20', '500.00');
      await openingStock(branch['BR-CENTRAL'].id, product.id, batchCentral.id, '30', '480.00');

      const requirement = await approvedRequirement(product.id, '100', `S1 ${RUN}`);
      const plan = expectOk('sourcing analysis', await sourcing(admin, requirement.id));
      const line = plan.productLines[0];
      const allBatches = line.internal.sources.flatMap((b: any) => b.batches);
      const branchNamed = (code: string) =>
        line.internal.sources.find((b: any) => b.branchCode === code);

      check('S1a. Internal sourceable reads 90', line.internal.totalSourceableQty === '90.00', line.internal.totalSourceableQty);
      check('S1b. Procurement required reads 10', line.procurement.requiredQty === '10.00', line.procurement.requiredQty);
      check('S1c. Sources are grouped by branch, three of them', line.internal.sources.length === 3, line.internal.sources.map((b: any) => b.branchCode));
      check('S1d. Each branch carries its own batches', line.internal.sources.every((b: any) => b.batches.length >= 1));
      check('S1e. Branch totals match their opening stock', branchNamed('BR-B')?.totalAvailableQty === '40.00' && branchNamed('BR-CENTRAL')?.totalAvailableQty === '30.00', line.internal.sources.map((b: any) => [b.branchCode, b.totalAvailableQty]));
      check('S1f. Per-batch source cost is preserved in the analysis', branchNamed('BR-B')?.batches[0].unitCost === '450.00', branchNamed('BR-B')?.batches[0]);
      check('S1g. Exactly one batch is flagged as expiring soonest', allBatches.filter((x: any) => x.expiresSoonest).length === 1, allBatches.map((x: any) => [x.batchNumber, x.expiresSoonest]));
      check('S1h. Suggested internal allocation totals 90, not more', line.internal.sources.reduce((acc: number, b: any) => acc + Number(b.totalSuggestedQty), 0) === 90, line.internal.sources.map((b: any) => b.totalSuggestedQty));

      const suppliers = line.procurement.suppliers;
      check('S1i. Supplier options are offered for the shortfall', suppliers.length >= 1, suppliers.length);
      check('S1j. Every supplier is priced for the 10 actually needed', suppliers.every((sup: any) => {
        const subtotal = (Number(sup.unitPrice) * 10).toFixed(2);
        const tax = ((Number(subtotal) * Number(sup.taxRate)) / 100).toFixed(2);
        const total = (Number(subtotal) + Number(tax)).toFixed(2);
        return sup.estimatedSubtotal === subtotal && sup.estimatedTax === tax && sup.estimatedTotal === total;
      }), suppliers.map((sup: any) => [sup.supplierName, sup.unitPrice, sup.estimatedTotal]));
      check('S1k. No supplier is ranked, scored or marked preferred', suppliers.every((sup: any) => !('rank' in sup) && !('score' in sup) && !('recommended' in sup) && !('isBest' in sup)), Object.keys(suppliers[0] ?? {}));
      check('S1l. A never-used supplier is on the product master price with no lead time', suppliers.every((sup: any) => sup.priceSource === 'LAST_PURCHASE' || (sup.priceSource === 'PRODUCT_MASTER' && sup.leadTimeDays === null)), suppliers.map((sup: any) => [sup.supplierName, sup.priceSource, sup.leadTimeDays]));
      check('S1m. No supplier stock availability is claimed', suppliers.every((sup: any) => !('availableQty' in sup) && !('inStock' in sup)), Object.keys(suppliers[0] ?? {}));
    }

    {
      // S2: a shelf far bigger than the requirement must not inflate the plan.
      const product = await makeProduct('S2');
      const batch = await makeBatch(product.id, 'S2B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '150', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `S2 ${RUN}`);

      const plan = expectOk('sourcing analysis', await sourcing(admin, requirement.id));
      const line = plan.productLines[0];
      check('S2a. Internal sourceable is capped at the requirement, not the shelf', line.internal.totalSourceableQty === '100.00', line.internal.totalSourceableQty);
      check('S2b. Nothing is left for a supplier', line.procurement.requiredQty === '0.00', line.procurement.requiredQty);
      check('S2c. No supplier comparison is offered when nothing needs buying', line.procurement.suppliers.length === 0);
      check('S2d. Suggested allocation never exceeds 100', line.internal.sources.reduce((acc: number, b: any) => acc + Number(b.totalSuggestedQty), 0) === 100, line.internal.sources.map((b: any) => b.totalSuggestedQty));
      check('S2e. The full 150 on hand is still reported honestly', line.internal.sources[0].batches[0].availableQty === '150.00', line.internal.sources[0].batches[0].availableQty);
    }

    {
      // S4: two branches plus a supplier, end to end.
      const product = await makeProduct('S4');
      const batchB = await makeBatch(product.id, 'S4B');
      const batchC = await makeBatch(product.id, 'S4C', 4);
      await openingStock(branch['BR-B'].id, product.id, batchB.id, '40', '500.00');
      await openingStock(branch['BR-C'].id, product.id, batchC.id, '20', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `S4 ${RUN}`);

      for (const [code, batchId, qty] of [
        ['BR-B', batchB.id, '40'],
        ['BR-C', batchC.id, '20'],
      ] as const) {
        const transfer = await transferFor(requirement.id, branch[code].id, [
          { productId: product.id, batchId, quantity: qty },
        ]);
        expectOk('dispatch', await dispatchTransfer(transfer.id));
        expectOk('receive', await receiveTransfer(transfer.id));
      }

      const mid = expectOk('sourcing analysis', await sourcing(admin, requirement.id));
      check('S4a. 60 received internally, 40 left to buy', mid.productLines[0].fulfilledQty === '60.00' && mid.productLines[0].procurement.requiredQty === '40.00', mid.productLines[0].sourcingSummary);

      await procure(requirement.id, product.id, '40', 'S4');
      check('S4b. Mixed internal and supplier sourcing reaches FULFILLED', (await requirementStatus(requirement.id)) === 'FULFILLED');

      const done = expectOk('sourcing analysis', await sourcing(admin, requirement.id));
      check('S4c. Nothing outstanding and nothing left to source', done.totals.outstanding === '0.00' && done.productLines[0].procurement.requiredQty === '0.00', done.totals);
    }

    {
      // Supplier history: a real past purchase is what the price and lead time come
      // from, and it is labelled as such rather than presented as a quote.
      const product = await makeProduct('SH');
      const first = await approvedRequirement(product.id, '10', `SH1 ${RUN}`);
      await procure(first.id, product.id, '10', 'SH', '475.00');

      const second = await approvedRequirement(product.id, '20', `SH2 ${RUN}`);
      const plan = expectOk('sourcing analysis', await sourcing(admin, second.id));
      const used = plan.productLines[0].procurement.suppliers.find(
        (sup: any) => sup.supplierId === supplier.id
      );
      check('SH1. The supplier just used is priced from that purchase, not the master', used?.priceSource === 'LAST_PURCHASE' && used?.unitPrice === '475.00', used);
      check('SH2. Lead time is observed from the order-to-receipt gap', used?.leadTimeDays !== null && used?.leadTimeSampleSize >= 1, { lead: used?.leadTimeDays, samples: used?.leadTimeSampleSize });
      check('SH3. The estimate uses the historic price for the 20 now needed', used?.estimatedSubtotal === '9500.00', used?.estimatedSubtotal);
    }

    {
      // Authorization: the shortfall is the branch business, the commercials are not.
      const product = await makeProduct('SAUTH');
      const batch = await makeBatch(product.id, 'SAUTHB');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `SAUTH ${RUN}`);

      const asBranch = expectOk('sourcing as branch A', await sourcing(branchA, requirement.id));
      const line = asBranch.productLines[0];
      check('SA1. Branch A is told 60 needs procuring', line.procurement.requiredQty === '60.00', line.procurement.requiredQty);
      check('SA2. Branch A sees no supplier prices', line.procurement.suppliers.length === 0 && line.procurement.comparisonRestricted === true, line.procurement);
      check('SA3. Branch A is not offered purchase order creation', asBranch.canCreatePurchaseOrder === false);
      check('SA4. Branch A still cannot see which branch holds the stock', line.internal.sources.length === 0 && line.internal.withheldBranchCount === 1, line.internal);
      check('SA5. Branch A is still told 40 exists internally', line.internal.totalSourceableQty === '40.00', line.internal.totalSourceableQty);

      const asCentral = expectOk('sourcing as central', await sourcing(central, requirement.id));
      check('SA6. Central procurement sees supplier prices', asCentral.productLines[0].procurement.suppliers.length >= 1 && asCentral.canCreatePurchaseOrder === true);
      check('SA7. Central procurement sees the branch breakdown', asCentral.productLines[0].internal.sources[0]?.branchCode === 'BR-B');

      const unauth = await sourcing(null, requirement.id);
      check('SA8. Sourcing analysis requires authentication', unauth.status === 401);
      const bogus = await call(central, 'GET', '/api/stock-requirements/not-a-uuid/sourcing-analysis');
      check('SA9. A malformed id is rejected by validation', bogus.status === 400, bogus.status);
      const missing = await call(central, 'GET', '/api/stock-requirements/11111111-1111-4111-8111-111111111111/sourcing-analysis');
      check('SA10. An unknown requirement is a 404', missing.status === 404, missing.status);
    }

    {
      // Analysis is a read. It must leave the database exactly as it found it.
      const product = await makeProduct('SRO');
      const batch = await makeBatch(product.id, 'SROB');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '40', '500.00');
      const requirement = await approvedRequirement(product.id, '100', `SRO ${RUN}`);

      const counts = () =>
        Promise.all([
          prisma.inventoryTransaction.count({ where: { companyId: company.id } }),
          prisma.document.count({ where: { companyId: company.id } }),
          prisma.documentLink.count({ where: { companyId: company.id } }),
        ]);

      const before = await counts();
      for (let i = 0; i < 3; i += 1) {
        expectOk('sourcing analysis', await sourcing(admin, requirement.id));
      }
      const after = await counts();
      check('SR1. Repeated analysis creates no stock movement, document or link', before[0] === after[0] && before[1] === after[1] && before[2] === after[2], { before, after });
    }

  }

  if (runSection(SECTION.surplus)) {
    /* ---------------------------------------- surplus guardrail (1 - 18) ---- */
    section('SURPLUS - internal surplus detection before supplier procurement');

    const sourcing = async (session: Session | null, requirementId: string) =>
      call(session, 'GET', `/api/stock-requirements/${requirementId}/sourcing-analysis`);

    /** The analysis and its single product line, which every scenario asserts on. */
    const surplusOf = async (requirementId: string, session: Session = admin) => {
      const plan = expectOk('sourcing analysis', await sourcing(session, requirementId));
      return { plan, line: plan.productLines[0] };
    };

    const branchNamed = (line: any, code: string) =>
      line.internal.sources.find((b: any) => b.branchCode === code);

    {
      // SURPLUS-1: one branch can spare far more than the requirement needs.
      const product = await makeProduct('SUR1');
      const batch = await makeBatch(product.id, 'SUR1B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR1 ${RUN}`);

      const { plan, line } = await surplusOf(requirement.id);
      check('SURPLUS-1a. Status is HIGH_SURPLUS', line.internal.surplusStatus === 'HIGH_SURPLUS', line.internal.surplusStatus);
      check('SURPLUS-1b. Suggested internal quantity is 10', line.internal.suggestedInternalQty === '10.00', line.internal.suggestedInternalQty);
      check('SURPLUS-1c. Suggested procurement quantity is 0', line.internal.suggestedProcurementQty === '0.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-1d. Branch B reports its full 50 of sourceable surplus', branchNamed(line, 'BR-B')?.sourceableSurplusQty === '50.00', branchNamed(line, 'BR-B'));
      check('SURPLUS-1e. Branch B is itself classified HIGH_SURPLUS', branchNamed(line, 'BR-B')?.surplusStatus === 'HIGH_SURPLUS', branchNamed(line, 'BR-B')?.surplusStatus);
      check('SURPLUS-1f. The requirement as a whole reads HIGH_SURPLUS', plan.surplusStatus === 'HIGH_SURPLUS', plan.surplusStatus);
      check('SURPLUS-1g. No branch is ranked, scored or marked best', line.internal.sources.every((b: any) => !('rank' in b) && !('score' in b) && !('recommended' in b) && !('isBest' in b)), Object.keys(line.internal.sources[0] ?? {}));
    }

    {
      // SURPLUS-2: internal stock covers part of it; a supplier covers the rest.
      const product = await makeProduct('SUR2');
      const batch = await makeBatch(product.id, 'SUR2B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '6', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR2 ${RUN}`);

      const { plan, line } = await surplusOf(requirement.id);
      check('SURPLUS-2a. Status is PARTIAL_SURPLUS', line.internal.surplusStatus === 'PARTIAL_SURPLUS', line.internal.surplusStatus);
      check('SURPLUS-2b. Suggested internal quantity is 6', line.internal.suggestedInternalQty === '6.00', line.internal.suggestedInternalQty);
      check('SURPLUS-2c. Suggested procurement quantity is 4', line.internal.suggestedProcurementQty === '4.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-2d. The supplier half is priced for 4, not 10', line.procurement.requiredQty === '4.00', line.procurement.requiredQty);
      check('SURPLUS-2e. The requirement as a whole reads PARTIAL_SURPLUS', plan.surplusStatus === 'PARTIAL_SURPLUS', plan.surplusStatus);
    }

    {
      // SURPLUS-3: nothing anywhere; procurement is the only route.
      const product = await makeProduct('SUR3');
      const requirement = await approvedRequirement(product.id, '10', `SUR3 ${RUN}`);

      const { plan, line } = await surplusOf(requirement.id);
      check('SURPLUS-3a. Status is NO_SURPLUS', line.internal.surplusStatus === 'NO_SURPLUS', line.internal.surplusStatus);
      check('SURPLUS-3b. Suggested internal quantity is 0', line.internal.suggestedInternalQty === '0.00', line.internal.suggestedInternalQty);
      check('SURPLUS-3c. The whole 10 falls to procurement', line.internal.suggestedProcurementQty === '10.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-3d. No source branch is offered', line.internal.sources.length === 0, line.internal.sources);
      check('SURPLUS-3e. The requirement as a whole reads NO_SURPLUS', plan.surplusStatus === 'NO_SURPLUS', plan.surplusStatus);
    }

    {
      // SURPLUS-4: two branches together cover it, so nothing needs buying.
      const product = await makeProduct('SUR4');
      const batchB = await makeBatch(product.id, 'SUR4B', 3);
      const batchC = await makeBatch(product.id, 'SUR4C', 4);
      await openingStock(branch['BR-B'].id, product.id, batchB.id, '15', '500.00');
      await openingStock(branch['BR-C'].id, product.id, batchC.id, '10', '500.00');
      const requirement = await approvedRequirement(product.id, '20', `SUR4 ${RUN}`);

      const { line } = await surplusOf(requirement.id);
      check('SURPLUS-4a. Suggested internal quantity is 20 across two branches', line.internal.suggestedInternalQty === '20.00', line.internal.suggestedInternalQty);
      check('SURPLUS-4b. Nothing is left for a supplier', line.internal.suggestedProcurementQty === '0.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-4c. Combined surplus is reported as 25', line.internal.totalSurplusQty === '25.00', line.internal.totalSurplusQty);
      check('SURPLUS-4d. The line reads HIGH_SURPLUS on the combined position', line.internal.surplusStatus === 'HIGH_SURPLUS', line.internal.surplusStatus);
      check('SURPLUS-4e. Neither branch alone is called HIGH_SURPLUS for 20', branchNamed(line, 'BR-B')?.surplusStatus === 'PARTIAL_SURPLUS' && branchNamed(line, 'BR-C')?.surplusStatus === 'PARTIAL_SURPLUS', line.internal.sources.map((b: any) => [b.branchCode, b.surplusStatus]));
      check('SURPLUS-4f. The split proposes 15 from Branch B and 5 from Branch C', branchNamed(line, 'BR-B')?.totalSuggestedQty === '15.00' && branchNamed(line, 'BR-C')?.totalSuggestedQty === '5.00', line.internal.sources.map((b: any) => [b.branchCode, b.totalSuggestedQty]));
    }

    {
      // SURPLUS-5: two branches together still fall short.
      const product = await makeProduct('SUR5');
      const batchB = await makeBatch(product.id, 'SUR5B', 3);
      const batchC = await makeBatch(product.id, 'SUR5C', 4);
      await openingStock(branch['BR-B'].id, product.id, batchB.id, '5', '500.00');
      await openingStock(branch['BR-C'].id, product.id, batchC.id, '4', '500.00');
      const requirement = await approvedRequirement(product.id, '20', `SUR5 ${RUN}`);

      const { line } = await surplusOf(requirement.id);
      check('SURPLUS-5a. Suggested internal quantity is 9', line.internal.suggestedInternalQty === '9.00', line.internal.suggestedInternalQty);
      check('SURPLUS-5b. Suggested procurement quantity is 11', line.internal.suggestedProcurementQty === '11.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-5c. Status is PARTIAL_SURPLUS', line.internal.surplusStatus === 'PARTIAL_SURPLUS', line.internal.surplusStatus);
    }

    {
      // SURPLUS-6: THE business rule. 50 on the shelf is not 50 of surplus once
      // 20 is promised to another transfer and 20 is owed to the holding branch's
      // own approved requirement.
      const product = await makeProduct('SUR6');
      const batch = await makeBatch(product.id, 'SUR6B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '500.00');

      // 20 committed: a transfer raised out of this bucket and left in DRAFT.
      const otherRequirement = await approvedRequirement(product.id, '20', `SUR6-other ${RUN}`);
      const committed = await transferFor(otherRequirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '20' },
      ]);
      check('SURPLUS-6a. The competing transfer is raised and still DRAFT', committed.status === 'DRAFT', committed.status);

      // 20 needed by the source branch itself.
      await approvedRequirementAs(admin, branch['BR-B'].id, product.id, '20', `SUR6-own ${RUN}`);

      const requirement = await approvedRequirement(product.id, '10', `SUR6 ${RUN}`);
      const { line } = await surplusOf(requirement.id);
      const holder = branchNamed(line, 'BR-B');

      check('SURPLUS-6b. Branch B is NOT reported as holding 50 of surplus', holder?.sourceableSurplusQty !== '50.00', holder?.sourceableSurplusQty);
      check('SURPLUS-6c. Sourceable surplus is 10 or less', Number(holder?.sourceableSurplusQty) <= 10, holder?.sourceableSurplusQty);
      check('SURPLUS-6d. Sourceable surplus is exactly 50 - 20 committed - 20 own demand', holder?.sourceableSurplusQty === '10.00', holder?.sourceableSurplusQty);
      check('SURPLUS-6e. Available still reports the 30 the other transfer left', holder?.totalAvailableQty === '30.00', holder?.totalAvailableQty);
      check('SURPLUS-6f. 20 is reported as held for Branch B own requirements', holder?.reservedQty === '20.00', holder?.reservedQty);
      check('SURPLUS-6g. The suggestion never draws on the reserved stock', line.internal.suggestedInternalQty === '10.00', line.internal.suggestedInternalQty);
    }

    {
      // SURPLUS-18: the reserve comes off the longest-dated stock, so the batch
      // closest to expiry is still the one offered and proposed first.
      const product = await makeProduct('SUR18');
      const soon = await makeBatch(product.id, 'SUR18-SOON', 2);
      const later = await makeBatch(product.id, 'SUR18-LATER', 5);
      await openingStock(branch['BR-B'].id, product.id, soon.id, '10', '450.00');
      await openingStock(branch['BR-B'].id, product.id, later.id, '40', '500.00');
      await approvedRequirementAs(admin, branch['BR-B'].id, product.id, '20', `SUR18-own ${RUN}`);

      const requirement = await approvedRequirement(product.id, '10', `SUR18 ${RUN}`);
      const { line } = await surplusOf(requirement.id);
      const batches = branchNamed(line, 'BR-B')?.batches ?? [];
      const soonRow = batches.find((b: any) => b.batchId === soon.id);
      const laterRow = batches.find((b: any) => b.batchId === later.id);

      check('SURPLUS-18a. The short-dated batch keeps all 10 of its surplus', soonRow?.surplusQty === '10.00', soonRow);
      check('SURPLUS-18b. The 20 reserved comes off the long-dated batch', laterRow?.surplusQty === '20.00', laterRow);
      check('SURPLUS-18c. The proposal takes the short-dated batch first', soonRow?.suggestedQty === '10.00' && laterRow?.suggestedQty === '0.00', batches.map((b: any) => [b.batchNumber, b.suggestedQty]));
      check('SURPLUS-18d. Total surplus is 30, not the 50 on the shelf', line.internal.totalSurplusQty === '30.00', line.internal.totalSurplusQty);
    }

    {
      // SURPLUS-7: the warning is exposed and is advisory only.
      const product = await makeProduct('SUR7');
      const batch = await makeBatch(product.id, 'SUR7B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR7 ${RUN}`);

      const { plan } = await surplusOf(requirement.id);
      const cheap = expectOk('availability', await availability(admin, requirement.id));

      check('SURPLUS-7a. The sourcing analysis carries the surplus warning', plan.surplusStatus === 'HIGH_SURPLUS' && plan.totals.suggestedInternalQty === '10.00', plan.totals);
      check('SURPLUS-7b. The cheaper availability read carries it too, so the PO screen needs no extra call', cheap.surplusStatus === 'HIGH_SURPLUS' && cheap.totals.suggestedProcurementQty === '0.00', cheap.totals);
      check('SURPLUS-7c. Purchase order creation is still offered', plan.canCreatePurchaseOrder === true);
      check('SURPLUS-7d. Nothing in the response blocks or forces a decision', !('blocked' in plan) && !('mustTransfer' in plan) && !('requiresTransfer' in plan), Object.keys(plan));

      // Non-blocking means non-blocking: the full 10 may still be bought even
      // though the suggestion was to procure none of it.
      const bought = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '10' }],
      });
      check('SURPLUS-7e. The full 10 can still be procured despite the surplus', bought.body?.success === true, bought.body?.message);
    }

    {
      // SURPLUS-8: the user chooses Continue with PO, and it goes through.
      const product = await makeProduct('SUR8');
      const batch = await makeBatch(product.id, 'SUR8B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR8 ${RUN}`);

      const order = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '10' }],
      });
      check('SURPLUS-8a. The purchase order is created', order.body?.success === true, order.body?.message);

      const { line } = await surplusOf(requirement.id);
      check('SURPLUS-8b. The 10 now shows as on order, not as fulfilled', line.sourcingSummary.onOrderQty === '10.00' && line.fulfilledQty === '0.00', line.sourcingSummary);
      check('SURPLUS-8c. With nothing outstanding there is no sourcing decision left', line.internal.surplusStatus === 'NO_SURPLUS' && line.remainingQty === '0.00', { status: line.internal.surplusStatus, remaining: line.remainingQty });
      check('SURPLUS-8d. Analysis created no transfer of its own', (await prisma.documentLink.count({ where: { targetDocumentId: requirement.id, linkType: 'TRANSFER_FOR' } })) === 0);
    }

    {
      // SURPLUS-9: Review internal stock leads to the existing internal sourcing
      // view, and that view is populated - branch, batch, expiry, cost and all.
      const product = await makeProduct('SUR9');
      const batch = await makeBatch(product.id, 'SUR9B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '480.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR9 ${RUN}`);

      const { line } = await surplusOf(requirement.id);
      const holder = branchNamed(line, 'BR-B');
      const offered = holder?.batches?.[0];
      check('SURPLUS-9a. The internal sourcing view names the source branch', holder?.branchName === branch['BR-B'].name, holder?.branchName);
      check('SURPLUS-9b. It carries the batch, expiry and ledger cost to review', Boolean(offered?.batchNumber) && Boolean(offered?.expiryDate) && offered?.unitCost === '480.00', offered);
      check('SURPLUS-9c. It carries the surplus and the proposed quantity', offered?.surplusQty === '50.00' && offered?.suggestedQty === '10.00', offered);
      check('SURPLUS-9d. Reviewing it is read-only - no transfer exists yet', (await prisma.documentLink.count({ where: { targetDocumentId: requirement.id, linkType: 'TRANSFER_FOR' } })) === 0);
    }

    {
      // SURPLUS-10: partial surplus defaults procurement to the shortfall, and
      // the backend cap is still the full outstanding quantity.
      const product = await makeProduct('SUR10');
      const batch = await makeBatch(product.id, 'SUR10B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '6', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR10 ${RUN}`);

      const cheap = expectOk('availability', await availability(admin, requirement.id));
      check('SURPLUS-10a. The PO screen is handed a default of 4, not 10', cheap.lines[0].suggestedProcurementQty === '4.00', cheap.lines[0]);
      check('SURPLUS-10b. The authoritative remaining quantity is still 10', cheap.lines[0].outstanding === '10.00', cheap.lines[0]);

      const tooMuch = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '11' }],
      });
      check('SURPLUS-10c. An order for 11 against a remaining 10 is refused', tooMuch.status === 409, tooMuch.body?.message);

      const right = await call(admin, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-A'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '4' }],
      });
      check('SURPLUS-10d. The suggested 4 is accepted', right.body?.success === true, right.body?.message);
    }

    {
      // SURPLUS-11: a suggestion is a live read, not a reservation. Stock taken
      // between the analysis and the transfer must be caught at creation.
      const product = await makeProduct('SUR11');
      const batch = await makeBatch(product.id, 'SUR11B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '30', '500.00');

      const mine = await approvedRequirement(product.id, '30', `SUR11-mine ${RUN}`);
      const theirs = await approvedRequirement(product.id, '30', `SUR11-theirs ${RUN}`);

      const { line } = await surplusOf(mine.id);
      check('SURPLUS-11a. The analysis first proposes the full 30', line.internal.suggestedInternalQty === '30.00', line.internal.suggestedInternalQty);

      // Somebody else takes it, and physically ships it.
      const competing = await transferFor(theirs.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '30' },
      ]);
      expectOk('dispatch competing transfer', await dispatchTransfer(competing.id));

      const stale = await call(admin, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: mine.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '30' }],
      });
      check('SURPLUS-11b. Acting on the stale suggestion is refused at creation', stale.status === 409, stale.body?.message);

      const ledger = await prisma.inventoryTransaction.aggregate({
        where: { branchId: branch['BR-B'].id, productId: product.id },
        _sum: { quantity: true },
      });
      check('SURPLUS-11c. Branch B is left at zero, never negative', Number(ledger._sum.quantity ?? 0) === 0, ledger._sum.quantity);

      const after = await surplusOf(mine.id);
      check('SURPLUS-11d. A re-read reports the surplus honestly as gone', after.line.internal.surplusStatus === 'NO_SURPLUS' && after.line.internal.suggestedProcurementQty === '30.00', after.line.internal);
    }

    {
      // SURPLUS-12: one tenant's shelf can never answer another tenant's need.
      const otherCompany = await prisma.company.findFirst({ where: { code: 'COMP-OTHERCARE' } });
      if (!otherCompany) {
        throw new Error('Company COMP-OTHERCARE is missing. Seed the database first.');
      }
      const otherBranch = await prisma.branch.findFirst({
        where: { companyId: otherCompany.id, code: 'BR-MAIN' },
      });
      if (!otherBranch) {
        throw new Error('Branch BR-MAIN is missing. Seed the database first.');
      }
      const otherAdmin = await login('admin@othercare.ai');

      // The same product code in both tenants, one of them with stock on a shelf.
      const ours = await makeProduct('SUR12');
      const batch = await makeBatch(ours.id, 'SUR12B');
      await openingStock(branch['BR-B'].id, ours.id, batch.id, '50', '500.00');

      const theirs = await prisma.product.create({
        data: {
          companyId: otherCompany.id,
          code: `PRD-IFT-${RUN}-SUR12`,
          name: `Internal Fulfilment Test ${RUN} SUR12`,
          unit: 'Vial',
          purchasePrice: '500.00',
          sellingPrice: '650.00',
          taxRate: '5.00',
        },
      });

      const foreign = await approvedRequirementAs(
        otherAdmin,
        otherBranch.id,
        theirs.id,
        '10',
        `SUR12 ${RUN}`
      );
      const plan = expectOk('sourcing analysis', await sourcing(otherAdmin, foreign.id));
      const line = plan.productLines[0];

      check('SURPLUS-12a. The other company sees no surplus at all', line.internal.surplusStatus === 'NO_SURPLUS' && line.internal.totalSurplusQty === '0.00', line.internal);
      check('SURPLUS-12b. Its whole requirement falls to its own procurement', line.internal.suggestedProcurementQty === '10.00', line.internal.suggestedProcurementQty);
      check('SURPLUS-12c. No branch of ours is named to them', line.internal.sources.length === 0 && line.internal.withheldBranchCount === 0, line.internal);

      const ourRequirement = await approvedRequirement(ours.id, '10', `SUR12-ours ${RUN}`);
      const crossRead = await sourcing(otherAdmin, ourRequirement.id);
      check('SURPLUS-12d. They cannot read our requirement at all', crossRead.status === 404, crossRead.status);
      const reverseRead = await sourcing(admin, foreign.id);
      check('SURPLUS-12e. Nor we theirs', reverseRead.status === 404, reverseRead.status);
      check('SURPLUS-12f. Our own 50 is still there for our own requirement', (await surplusOf(ourRequirement.id)).line.internal.surplusStatus === 'HIGH_SURPLUS');
    }

    {
      // SURPLUS-13: seeing that surplus exists is not permission to move it.
      const product = await makeProduct('SUR13');
      const batch = await makeBatch(product.id, 'SUR13B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '50', '500.00');
      const requirement = await approvedRequirement(product.id, '10', `SUR13 ${RUN}`);

      const plan = expectOk('sourcing as branch A', await sourcing(branchA, requirement.id));
      const line = plan.productLines[0];
      check('SURPLUS-13a. Branch A is told the aggregate surplus position', line.internal.surplusStatus === 'HIGH_SURPLUS' && line.internal.suggestedInternalQty === '10.00', line.internal);
      check('SURPLUS-13b. Branch A is not shown which branch holds it', line.internal.sources.length === 0 && line.internal.withheldBranchCount === 1, line.internal);
      check('SURPLUS-13c. Branch A is not offered the transfer action', plan.canCreateTransfer === false);

      const refused = await call(branchA, 'POST', '/api/stock-transfers', {
        sourceBranchId: branch['BR-B'].id,
        destinationBranchId: branch['BR-A'].id,
        requirementId: requirement.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: '10' }],
      });
      check('SURPLUS-13d. And cannot raise the transfer anyway', refused.status === 403, { status: refused.status, message: refused.body?.message });
    }

    {
      // SURPLUS-14: stock nobody could dispense is not surplus.
      const product = await makeProduct('SUR14');
      const good = await makeBatch(product.id, 'SUR14-GOOD', 3);
      const expired = await prisma.batch.create({
        data: {
          companyId: company.id,
          productId: product.id,
          batchNumber: `SUR14-OLD-${RUN}`,
          expiryDate: new Date(Date.now() - 24 * 3600 * 1000),
          status: StockStatus.USABLE,
        },
      });
      await openingStock(branch['BR-B'].id, product.id, good.id, '4', '500.00');
      await openingStock(branch['BR-B'].id, product.id, expired.id, '100', '500.00');

      const requirement = await approvedRequirement(product.id, '10', `SUR14 ${RUN}`);
      const { line } = await surplusOf(requirement.id);

      check('SURPLUS-14a. Only the 4 unexpired units count as surplus', line.internal.totalSurplusQty === '4.00', line.internal.totalSurplusQty);
      check('SURPLUS-14b. The expired batch is not offered as a source', (branchNamed(line, 'BR-B')?.batches ?? []).every((b: any) => b.batchId !== expired.id), branchNamed(line, 'BR-B')?.batches);
      check('SURPLUS-14c. 100 expired units do not make this HIGH_SURPLUS', line.internal.surplusStatus === 'PARTIAL_SURPLUS', line.internal.surplusStatus);
      check('SURPLUS-14d. 6 still needs a supplier', line.internal.suggestedProcurementQty === '6.00', line.internal.suggestedProcurementQty);
    }

    {
      // SURPLUS-15, 16 and 17 in one life: suggestion, transfer, dispatch,
      // receipt - and only the last of them moves fulfilment.
      const product = await makeProduct('SUR15');
      const batch = await makeBatch(product.id, 'SUR15B');
      await openingStock(branch['BR-B'].id, product.id, batch.id, '10', '500.00');
      const requirement = await approvedRequirement(product.id, '20', `SUR15 ${RUN}`);

      const suggested = await surplusOf(requirement.id);
      check('SURPLUS-15a. A suggestion of 10 exists', suggested.line.internal.suggestedInternalQty === '10.00', suggested.line.internal.suggestedInternalQty);
      check('SURPLUS-15b. Suggesting it fulfils nothing', suggested.line.fulfilledQty === '0.00', suggested.line.fulfilledQty);
      check('SURPLUS-15c. The requirement is untouched by the analysis', (await requirementStatus(requirement.id)) === 'APPROVED');
      check('SURPLUS-15d. No document was created by suggesting', (await prisma.documentLink.count({ where: { targetDocumentId: requirement.id } })) === 0);

      const transfer = await transferFor(requirement.id, branch['BR-B'].id, [
        { productId: product.id, batchId: batch.id, quantity: '10' },
      ]);
      const raised = await surplusOf(requirement.id);
      check('SURPLUS-16a. A raised transfer still fulfils nothing', raised.line.fulfilledQty === '0.00', raised.line.fulfilledQty);
      check('SURPLUS-16b. It is counted as in transit instead', raised.line.sourcingSummary.onTransferQty === '10.00', raised.line.sourcingSummary);
      check('SURPLUS-16c. The requirement is still APPROVED', (await requirementStatus(requirement.id)) === 'APPROVED');

      expectOk('dispatch', await dispatchTransfer(transfer.id));
      const dispatched = await surplusOf(requirement.id);
      check('SURPLUS-16d. Dispatch still fulfils nothing', dispatched.line.fulfilledQty === '0.00', dispatched.line.fulfilledQty);
      check('SURPLUS-16e. The requirement is still APPROVED after dispatch', (await requirementStatus(requirement.id)) === 'APPROVED');

      expectOk('receive', await receiveTransfer(transfer.id));
      const received = await surplusOf(requirement.id);
      check('SURPLUS-17a. Receipt fulfils exactly the 10 that arrived', received.line.fulfilledQty === '10.00', received.line.fulfilledQty);
      check('SURPLUS-17b. The requirement becomes PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');
      check('SURPLUS-17c. The remaining 10 has no internal surplus left behind it', received.line.internal.surplusStatus === 'NO_SURPLUS' && received.line.internal.suggestedProcurementQty === '10.00', received.line.internal);

      const inbound = await prisma.inventoryTransaction.aggregate({
        where: {
          documentId: transfer.id,
          transactionType: InventoryTransactionType.TRANSFER_IN,
          stockStatus: StockStatus.USABLE,
        },
        _sum: { quantity: true },
      });
      check('SURPLUS-17d. Fulfilment came from usable TRANSFER_IN only', Number(inbound._sum.quantity ?? 0) === 10, inbound._sum.quantity);
    }

  }

  /* --------------------------------------------------------- regression ---- */
  if (runSection(SECTION.core)) {
    section('REGRESSION - the existing correction and follow-up scenario');
    {
      const product = await makeProduct('REG');
      const requirement = await approvedRequirement(product.id, '100', `REG ${RUN}`);

      const order = expectOk(
        'create purchase order',
        await call(central, 'POST', '/api/purchase-orders', {
          requirementId: requirement.id,
          supplierId: supplier.id,
          deliveryBranchId: branch['BR-CENTRAL'].id,
          expectedDeliveryDate: future(0.02),
          lines: [{ productId: product.id, quantity: '100' }],
        })
      );
      expectOk('approve order', await call(central, 'POST', `/api/purchase-orders/${order.id}/approve`, {}));

      const receipt = expectOk(
        'create receipt',
        await call(central, 'POST', '/api/goods-receipts', {
          purchaseOrderId: order.id,
          supplierRef: `REG-${RUN}`,
          lines: [
            {
              purchaseOrderLineItemId: order.lineItems[0].id,
              quantity: '100',
              acceptedQuantity: '100',
              damagedQuantity: '0',
              missingQuantity: '0',
              batchNumber: `REG-${RUN}`,
              expiryDate: future(3),
            },
          ],
        })
      );
      const posted = expectOk('post receipt', await call(central, 'POST', `/api/goods-receipts/${receipt.id}/post`, {}));
      check('R1. A clean 100 receipt reaches FULFILLED', (await requirementStatus(requirement.id)) === 'FULFILLED');

      expectOk(
        'correct receipt',
        await call(central, 'POST', '/api/receipt-corrections', {
          goodsReceiptId: receipt.id,
          reason: `Recount after delivery ${RUN}`,
          lines: [
            {
              goodsReceiptLineItemId: posted.lineItems[0].id,
              correctedAcceptedQuantity: '70',
              correctedDamagedQuantity: '20',
              correctedMissingQuantity: '10',
            },
          ],
        })
      );
      check('R2. A correction to 70/20/10 knocks it back to PARTIALLY_FULFILLED', (await requirementStatus(requirement.id)) === 'PARTIALLY_FULFILLED');

      const afterCorrection = expectOk('availability', await availability(central, requirement.id));
      check('R3. Fulfilled reads 70 after the correction', afterCorrection.lines[0].fulfilled === '70.00', afterCorrection.lines[0]);
      check('R4. 30 is genuinely still procureable', afterCorrection.lines[0].outstanding === '30.00', afterCorrection.lines[0]);

      const overFollowUp = await call(central, 'POST', '/api/purchase-orders', {
        requirementId: requirement.id,
        supplierId: supplier.id,
        deliveryBranchId: branch['BR-CENTRAL'].id,
        expectedDeliveryDate: future(0.02),
        lines: [{ productId: product.id, quantity: '31' }],
      });
      check('R5. A follow-up order for 31 is still refused', overFollowUp.status === 409, overFollowUp.body?.message);

      await procure(requirement.id, product.id, '30', 'REG');
      check('R6. The follow-up 30 reaches FULFILLED again', (await requirementStatus(requirement.id)) === 'FULFILLED');
    }

  }

  /* -------------------------------------------------------------- done ---- */
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    throw new Error(`${failures} check(s) failed`);
  }
}

main()
  .then(() => console.log('\nINTERNAL FULFILMENT VALIDATION PASSED'))
  .catch((error) => {
    console.error('\nINTERNAL FULFILMENT VALIDATION FAILED');
    console.error(String(error));
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
