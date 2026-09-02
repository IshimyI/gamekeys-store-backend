const db = require('./db');

const FAIL_RATE = Number(process.env.SUPPLIER_FAIL_RATE ?? 0.15);
const TIMEOUT_RATE = Number(process.env.SUPPLIER_TIMEOUT_RATE ?? 0.15);
const TIMEOUT_DELAY_MS = Number(process.env.SUPPLIER_TIMEOUT_DELAY_MS ?? 4000);

const getAttempt = db.prepare('SELECT * FROM supplier_attempts WHERE request_id = ?');
const reserveAttempt = db.prepare(
  "INSERT INTO supplier_attempts (request_id, supplier, order_id, status, code, reason, created_at) VALUES (?, ?, ?, 'pending', NULL, NULL, ?)"
);
const resolveAttemptOk = db.prepare("UPDATE supplier_attempts SET status = 'ok', code = ? WHERE request_id = ?");
const deleteAttempt = db.prepare("DELETE FROM supplier_attempts WHERE request_id = ? AND status = 'pending'");
const claimKey = db.prepare(
  "UPDATE keys SET status = 'issued', issued_to_order_id = ? WHERE id = (SELECT id FROM keys WHERE status = 'available' LIMIT 1)"
);
const getKeyIssuedTo = db.prepare("SELECT * FROM keys WHERE issued_to_order_id = ? AND status = 'issued' ORDER BY id DESC LIMIT 1");

function claimKeyForOrder(orderId) {
  const result = claimKey.run(orderId);
  if (result.changes === 0) return null;
  return getKeyIssuedTo.get(orderId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSupplier(supplier, { requestId, sku, orderId, force }) {
  const existing = getAttempt.get(requestId);
  if (existing && existing.status === 'ok') {
    return { status: 'ok', request_id: requestId, code: existing.code, replay: true };
  }

  if (!existing) {
    try {
      reserveAttempt.run(requestId, supplier, orderId, Date.now());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return waitForResolution(requestId);
    }
  } else if (existing.status === 'pending') {
    return waitForResolution(requestId);
  }

  const roll = Math.random();
  const mode = force || (roll < FAIL_RATE ? 'error' : roll < FAIL_RATE + TIMEOUT_RATE ? 'timeout' : 'success');

  if (mode === 'error') {
    deleteAttempt.run(requestId);
    return { status: 'error', reason: 'supplier_error' };
  }

  if (mode === 'timeout') {
    await sleep(TIMEOUT_DELAY_MS);
  }

  const key = claimKeyForOrder(orderId);
  if (!key) {
    deleteAttempt.run(requestId);
    return { status: 'error', reason: 'out_of_stock' };
  }
  resolveAttemptOk.run(key.code, requestId);
  return { status: 'ok', request_id: requestId, code: key.code };
}

async function waitForResolution(requestId, maxWaitMs = TIMEOUT_DELAY_MS + 500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const row = getAttempt.get(requestId);
    if (!row) return { status: 'error', reason: 'supplier_error' };
    if (row.status === 'ok') return { status: 'ok', request_id: requestId, code: row.code, replay: true };
    await sleep(50);
  }
  return { status: 'timeout' };
}

function isUniqueViolation(err) {
  return typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed');
}

module.exports = { callSupplier, FAIL_RATE, TIMEOUT_RATE, TIMEOUT_DELAY_MS };
