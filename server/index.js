const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const { callSupplier } = require('./suppliers');

const app = express();
app.use(express.json());

function log(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const listProducts = db.prepare('SELECT * FROM products');
const getProduct = db.prepare('SELECT * FROM products WHERE sku = ?');

const insertOrder = db.prepare(
  `INSERT INTO orders (id, sku, amount, currency, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'created', ?, ?)`
);
const getOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const setOrderStatus = db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?');
const setOrderDelivered = db.prepare("UPDATE orders SET status = 'delivered', delivered_code = ?, updated_at = ? WHERE id = ?");
const listUndelivered = db.prepare("SELECT * FROM orders WHERE status IN ('out_of_stock', 'delivery_failed') ORDER BY updated_at");
const listStale = db.prepare(
  "SELECT * FROM orders WHERE status IN ('out_of_stock', 'delivery_failed') AND updated_at < ? ORDER BY updated_at LIMIT ?"
);

const insertWebhookEvent = db.prepare('INSERT INTO webhook_events (event_id, order_id, received_at) VALUES (?, ?, ?)');
const insertLedgerCharge = db.prepare(
  'INSERT INTO ledger_entries (order_id, amount, currency, created_at) VALUES (?, ?, ?, ?)'
);
const listLedger = db.prepare('SELECT * FROM ledger_entries ORDER BY id');
const sumLedger = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries');

function isUniqueViolation(err) {
  return typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get('/api/products', (req, res) => {
  res.json(listProducts.all());
});

app.post('/api/orders', (req, res) => {
  const { sku } = req.body || {};
  const product = getProduct.get(sku);
  if (!product) return res.status(404).json({ error: 'product_not_found' });

  const orderId = req.body.id || 'ord_' + crypto.randomBytes(6).toString('hex');
  const now = Date.now();
  insertOrder.run(orderId, sku, product.price, product.currency, now, now);
  log('order_created', { order_id: orderId, sku, amount: product.price, currency: product.currency });

  res.status(201).json({ order_id: orderId, sku, amount: product.price, currency: product.currency, status: 'created' });
});

app.get('/api/orders/:id', (req, res) => {
  const order = getOrder.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  res.json(order);
});

const SUPPLIER_TIMEOUT_MS = Number(process.env.SUPPLIER_CALL_TIMEOUT_MS ?? 1500);
const SUPPLIER_MAX_ATTEMPTS = Number(process.env.SUPPLIER_MAX_ATTEMPTS ?? 2);
const SUPPLIER_BACKOFF_BASE_MS = Number(process.env.SUPPLIER_BACKOFF_BASE_MS ?? 200);

async function attemptSupplierOnce(supplier, order, requestId, force) {
  const supplierPromise = callSupplier(supplier, { requestId, sku: order.sku, orderId: order.id, force });

  const raced = await Promise.race([
    supplierPromise.then((result) => ({ timedOut: false, result })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), SUPPLIER_TIMEOUT_MS)),
  ]);

  if (!raced.timedOut) return raced.result;

  supplierPromise.then((result) => handleLateSupplierResponse(order.id, supplier, result)).catch(() => {});
  return { status: 'timeout' };
}

// Ретраи с бэкоффом только на явную ошибку поставщика (4xx/5xx).
// Таймаут — отдельный случай: не повторяем с новым request_id, ждём поздний ответ на исходный.
async function attemptSupplierWithBackoff(supplier, order, force) {
  let result;
  for (let attempt = 1; attempt <= SUPPLIER_MAX_ATTEMPTS; attempt++) {
    const requestId = `${order.id}:${supplier}:${attempt}`;
    result = await attemptSupplierOnce(supplier, order, requestId, force);

    if (result.status !== 'error') return result;
    if (result.reason === 'out_of_stock') return result; // повторять бессмысленно, лучше сразу fallback

    if (attempt < SUPPLIER_MAX_ATTEMPTS) {
      const delay = SUPPLIER_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      log('supplier_retry', { order_id: order.id, supplier, attempt, reason: result.reason, delay_ms: delay });
      await sleep(delay);
    }
  }
  return result;
}

function finalizeDelivered(orderId, code) {
  const order = getOrder.get(orderId);
  if (!order || order.status === 'delivered') return;
  setOrderDelivered.run(code, Date.now(), orderId);
  log('order_delivered', { order_id: orderId, code });
}

function handleLateSupplierResponse(orderId, supplier, result) {
  const order = getOrder.get(orderId);
  if (!order || order.status === 'delivered') return;
  log('supplier_late_response', { order_id: orderId, supplier, status: result.status });
  if (result.status === 'ok') {
    finalizeDelivered(orderId, result.code);
    return;
  }
  if (supplier === 'A' && order.status === 'delivering') {
    runDelivery(orderId);
  } else if (order.status === 'delivering') {
    setOrderStatus.run(result.reason === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed', Date.now(), orderId);
    log('order_recoverable', { order_id: orderId, status: result.reason === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed' });
  }
}

async function runDelivery(orderId, options = {}) {
  const order = getOrder.get(orderId);
  if (!order || order.status !== 'delivering') return;

  const resultA = await attemptSupplierWithBackoff('A', order, options.forceA);
  if (resultA.status === 'ok') return finalizeDelivered(orderId, resultA.code);
  if (resultA.status === 'timeout') return;

  const resultB = await attemptSupplierWithBackoff('B', order, options.forceB);
  if (resultB.status === 'ok') return finalizeDelivered(orderId, resultB.code);
  if (resultB.status === 'timeout') return;

  const bothOutOfStock = resultA.reason === 'out_of_stock' && resultB.reason === 'out_of_stock';
  const finalStatus = bothOutOfStock ? 'out_of_stock' : 'delivery_failed';
  setOrderStatus.run(finalStatus, Date.now(), orderId);
  log('order_recoverable', { order_id: orderId, status: finalStatus });
}

app.post('/api/webhooks/payment', async (req, res) => {
  const { event_id, order_id, status } = req.body || {};
  if (!event_id || !order_id || !['paid', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const order = getOrder.get(order_id);
  if (!order) {
    log('webhook_order_not_found_yet', { event_id, order_id });
    return res.status(503).json({ error: 'order_not_found_yet' });
  }

  try {
    insertWebhookEvent.run(event_id, order_id, Date.now());
  } catch (err) {
    if (isUniqueViolation(err)) {
      log('webhook_duplicate', { event_id, order_id });
      return res.json({ result: 'duplicate_event', order: getOrder.get(order_id) });
    }
    throw err;
  }

  log('webhook_received', { event_id, order_id, status });

  if (status === 'failed') {
    if (order.status === 'created') {
      setOrderStatus.run('payment_failed', Date.now(), order_id);
      log('payment_failed', { order_id });
    }
    return res.json({ result: 'payment_failed', order: getOrder.get(order_id) });
  }

  if (order.status !== 'created') {
    return res.json({ result: 'already_processed', order: getOrder.get(order_id) });
  }

  markPaidAndDelivering(order);
  res.json({ result: 'accepted', order: getOrder.get(order_id) });

  runDelivery(order_id).catch((err) => log('delivery_error', { order_id, error: err.message }));
});

// Общая точка перехода created → delivering: и вебхук, и тестовый форс-эндпоинт
// проходят через неё, чтобы леджер всегда отражал реальность (см. /reconciliation).
function markPaidAndDelivering(order) {
  setOrderStatus.run('delivering', Date.now(), order.id);
  try {
    insertLedgerCharge.run(order.id, order.amount, order.currency, Date.now());
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  log('payment_confirmed', { order_id: order.id, amount: order.amount, currency: order.currency });
}

app.get('/api/admin/undelivered-orders', (req, res) => {
  res.json(listUndelivered.all());
});

app.get('/api/admin/reconciliation', (req, res) => {
  const orders = db.prepare("SELECT id, status, amount, currency FROM orders WHERE status != 'created'").all();
  const ledger = listLedger.all();
  const ledgerByOrder = new Map(ledger.map((l) => [l.order_id, l]));

  const paidButNotDelivered = orders.filter((o) => ledgerByOrder.has(o.id) && o.status !== 'delivered' && o.status !== 'payment_failed');
  const deliveredWithoutCharge = orders.filter((o) => o.status === 'delivered' && !ledgerByOrder.has(o.id));
  const chargedWithoutOrder = ledger.filter((l) => !orders.find((o) => o.id === l.order_id));

  res.json({
    total_charged: sumLedger.get().total,
    charge_count: ledger.length,
    paid_but_not_delivered: paidButNotDelivered,
    delivered_without_charge: deliveredWithoutCharge, // должно быть всегда пусто
    charged_without_order: chargedWithoutOrder, // должно быть всегда пусто
  });
});

app.post('/api/admin/orders/:id/retry', async (req, res) => {
  const order = getOrder.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.status === 'delivered') return res.json({ result: 'already_delivered', order });
  if (!['out_of_stock', 'delivery_failed'].includes(order.status)) {
    return res.status(409).json({ error: 'order_not_recoverable', status: order.status });
  }

  setOrderStatus.run('delivering', Date.now(), order.id);
  log('order_retry', { order_id: order.id, triggered_by: 'admin' });
  await runDelivery(order.id);
  res.json({ result: 'retried', order: getOrder.get(order.id) });
});

app.post('/api/admin/restock', (req, res) => {
  const { count } = req.body || {};
  const n = Number(count) || 1;
  const insertKey = db.prepare("INSERT INTO keys (code, status) VALUES (?, 'available')");
  for (let i = 0; i < n; i++) {
    insertKey.run('RESTOCK-' + crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  log('restock', { count: n });
  res.json({ restocked: n });
});

app.post('/api/test/force-delivery', async (req, res) => {
  const { order_id, forceA, forceB } = req.body || {};
  const order = getOrder.get(order_id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  markPaidAndDelivering(order);
  await runDelivery(order_id, { forceA, forceB });
  res.json({ order: getOrder.get(order_id) });
});

// Фоновая задача: подбирает заказы, застрявшие в out_of_stock/delivery_failed,
// и безопасно повторяет выдачу. Использует ту же идемпотентную транзакцию
// перехода в delivering, что и ручной retry — гонки между sweep и admin retry
// исключены синхронностью SQLite-вызовов.
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 15000);
const SWEEP_MIN_AGE_MS = Number(process.env.SWEEP_MIN_AGE_MS ?? 10000);
const SWEEP_BATCH_SIZE = Number(process.env.SWEEP_BATCH_SIZE ?? 5);

async function sweepStuckOrders() {
  const cutoff = Date.now() - SWEEP_MIN_AGE_MS;
  const candidates = listStale.all(cutoff, SWEEP_BATCH_SIZE);
  for (const order of candidates) {
    const fresh = getOrder.get(order.id);
    if (!fresh || !['out_of_stock', 'delivery_failed'].includes(fresh.status)) continue;
    setOrderStatus.run('delivering', Date.now(), fresh.id);
    log('order_retry', { order_id: fresh.id, triggered_by: 'sweep' });
    await runDelivery(fresh.id);
    await sleep(50); // не долбим поставщика пачкой запросов подряд
  }
}

let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepStuckOrders().catch((err) => log('sweep_error', { error: err.message }));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  startSweep();
  app.listen(PORT, () => {
    log('server_started', { port: PORT });
    console.log(`gamekeys-store-backend listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, sweepStuckOrders, startSweep };
