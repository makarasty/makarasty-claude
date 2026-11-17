import { test } from 'node:test'
import assert from 'node:assert/strict'
import { value, low } from '../src/stock.js'

test('value sums count times cost', () => assert.equal(value([{ count: 3, cost: 0.1 }]), 0.3))
test('low lists rows under the minimum, the minimum included', () => assert.deepEqual(low([{ count: 2 }, { count: 5 }], 2), [{ count: 2 }]))
