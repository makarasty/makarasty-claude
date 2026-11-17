import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../price.js'

test('empty order is zero', () => assert.equal(total([]), 0))
test('one item', () => assert.equal(total([{ price: 250, qty: 1 }]), 250))
