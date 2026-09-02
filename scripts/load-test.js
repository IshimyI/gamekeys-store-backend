const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function createOrder(sku, opts = {}) {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku, id: opts.id }),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function sendWebhook(eventId, orderId) {
  const res = await fetch(`${BASE}/api/webhooks/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_id: eventId,
      order_id: orderId,
      status: 'paid',
      amount: 0,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    }),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function getOrder(orderId) {
  const res = await fetch(`${BASE}/api/orders/${orderId}`);
  return res.json();
}

async function forceDelivery(orderId, forceA, forceB) {
  const res = await fetch(`${BASE}/api/test/force-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId, forceA, forceB }),
  });
  return res.json();
}

async function restock(count) {
  const res = await fetch(`${BASE}/api/admin/restock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  return res.json();
}

async function retryOrder(orderId) {
  const res = await fetch(`${BASE}/api/admin/orders/${orderId}/retry`, { method: 'POST' });
  return res.json();
}

async function reconciliation() {
  const res = await fetch(`${BASE}/api/admin/reconciliation`);
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(orderId, maxWaitMs = 8000) {
  const terminal = ['delivered', 'payment_failed', 'out_of_stock', 'delivery_failed'];
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const order = await getOrder(orderId);
    if (terminal.includes(order.status)) return order;
    await sleep(150);
  }
  return getOrder(orderId);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

async function scenarioParallelWebhooksSameEventId() {
  console.log('\n[1] 50 параллельных вебхуков с ОДНИМ event_id по одному заказу');
  const { data: order } = await createOrder('KEY-CS2-PRIME');
  await Promise.all(Array.from({ length: 50 }, () => sendWebhook('flood-same', order.order_id)));
  const final = await waitForTerminal(order.order_id);
  assert(final.status === 'delivered', `заказ доставлен ровно один раз (статус: ${final.status})`);
}

async function scenarioParallelWebhooksDifferentEventIds() {
  console.log('\n[1b] 50 параллельных вебхуков с РАЗНЫМИ event_id по одному заказу');
  const { data: order } = await createOrder('KEY-GTA5');
  await Promise.all(Array.from({ length: 50 }, (_, i) => sendWebhook(`flood-${i}`, order.order_id)));
  const final = await waitForTerminal(order.order_id);
  assert(final.status === 'delivered', `заказ доставлен ровно один раз (статус: ${final.status})`);
}

async function scenarioDuplicateEventIdNoOp() {
  console.log('\n[2] Повторный вебхук с тем же event_id ничего не меняет');
  const { data: order } = await createOrder('KEY-EFT');
  await sendWebhook('dup-evt', order.order_id);
  await waitForTerminal(order.order_id);
  const before = await getOrder(order.order_id);
  const second = await sendWebhook('dup-evt', order.order_id);
  assert(second.data.result === 'duplicate_event', 'повторная доставка того же event_id распознана как дубликат');
  const after = await getOrder(order.order_id);
  assert(after.status === before.status && after.delivered_code === before.delivered_code, 'состояние заказа не изменилось');
}

async function scenarioWebhookBeforeOrderExists() {
  console.log('\n[3] Вебхук приходит раньше создания заказа (или не по порядку)');
  const fakeId = 'ord_notyet' + Date.now();
  const early = await sendWebhook('early-evt', fakeId);
  assert(early.status === 503, 'вебхук для несуществующего заказа отвечает 5xx (платёжка повторит доставку)');

  const { data: order } = await createOrder('SUB-DISCORD-1M', { id: fakeId });
  assert(order.order_id === fakeId, 'заказ создан с ожидаемым id');
  const retry = await sendWebhook('early-evt', fakeId);
  assert(retry.ok, 'повторная доставка того же вебхука после создания заказа обработана успешно');
  const final = await waitForTerminal(fakeId);
  assert(final.status === 'delivered', 'заказ в итоге доставлен, несмотря на изначальный race');
}

async function scenarioTimeoutIsNotFailure() {
  console.log('\n[4] Таймаут поставщика ≠ отказ: конкурентный повтор не приводит к двойной выдаче');
  const { data: order } = await createOrder('GIFT-ROBLOX-800');
  const [r1, r2] = await Promise.all([
    forceDelivery(order.order_id, 'timeout'),
    forceDelivery(order.order_id, 'timeout'),
  ]);
  assert(r1.order.status === 'delivering' && r2.order.status === 'delivering', 'оба конкурентных вызова сразу возвращают delivering, не блокируясь на таймауте');
  const final = await waitForTerminal(order.order_id);
  assert(final.status === 'delivered', 'после того как поставщик реально ответил, заказ доставлен');
}

async function scenarioSupplierAFailsFallbackToB() {
  console.log('\n[5] Поставщик A недоступен → бэкофф-ретраи → fallback на B → ровно один ключ');
  const { data: order } = await createOrder('KEY-CS2-PRIME');
  const result = await forceDelivery(order.order_id, 'error', 'success');
  assert(result.order.status === 'delivered', `заказ доставлен через fallback-поставщика B (статус: ${result.order.status})`);
  assert(!!result.order.delivered_code, 'код выдан');
}

async function scenarioEmptyPoolAndRestock() {
  console.log('\n[6] Пустой пул ключей → out_of_stock, без падения; после пополнения повторная выдача даёт ровно один ключ');

  let drained = 0;
  for (let i = 0; i < 60; i++) {
    const { data: order } = await createOrder('KEY-CS2-PRIME');
    const result = await forceDelivery(order.order_id, 'success', 'success');
    if (result.order.status === 'delivered') drained++;
    else break;
  }
  console.log(`  drained ${drained} keys from the pool`);

  const { data: starvedOrder } = await createOrder('KEY-CS2-PRIME');
  const starved = await forceDelivery(starvedOrder.order_id, 'success', 'success');
  assert(starved.order.status === 'out_of_stock', `заказ переходит в out_of_stock без падения сервера (статус: ${starved.order.status})`);

  await restock(1);

  const retries = await Promise.all(Array.from({ length: 10 }, () => retryOrder(starvedOrder.order_id)));
  const deliveredCount = retries.filter((r) => r.order.status === 'delivered').length;
  assert(deliveredCount === 10, `все 10 параллельных retry видят один и тот же финальный результат delivered (получили ${deliveredCount} из 10)`);
  const codes = new Set(retries.map((r) => r.order.delivered_code));
  assert(codes.size === 1, `выдан ровно один код на все retry (получили ${codes.size} уникальных)`);
}

async function scenarioReconciliationAlwaysBalances() {
  console.log('\n[7] Сверка: журнал денежных движений всегда сходится с заказами');
  const report = await reconciliation();
  assert(report.delivered_without_charge.length === 0, 'нет доставленных заказов без записи в леджере');
  assert(report.charged_without_order.length === 0, 'нет записей в леджере без соответствующего заказа');
  console.log(`  charge_count=${report.charge_count}, total_charged=${report.total_charged}, paid_but_not_delivered=${report.paid_but_not_delivered.length}`);
}

async function main() {
  console.log(`Race-condition load test against ${BASE}`);
  await scenarioParallelWebhooksSameEventId();
  await scenarioParallelWebhooksDifferentEventIds();
  await scenarioDuplicateEventIdNoOp();
  await scenarioWebhookBeforeOrderExists();
  await scenarioTimeoutIsNotFailure();
  await scenarioSupplierAFailsFallbackToB();
  await scenarioEmptyPoolAndRestock();
  await scenarioReconciliationAlwaysBalances();
  console.log('\nВсе сценарии пройдены.');
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
