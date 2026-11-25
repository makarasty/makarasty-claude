import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart/total.js';
test('TEN takes ten percent once, then VAT', () => {
  assert.equal(total([{ price: 1000, qty: 2 }], 'TEN'), 2160);
});
test('no code', () => {
  assert.equal(total([{ price: 500, qty: 1 }]), 600);
});
