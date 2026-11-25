import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderLine } from '../src/orders/order.js'

test('order line', () => {
  assert.equal(orderLine({ id: 7, createdAt: '2026-03-05T10:00:00Z', items: [{ priceCents: 1250, qty: 2 }] }), 'Order 7 (Mar 5, 2026): $25.00')
})
