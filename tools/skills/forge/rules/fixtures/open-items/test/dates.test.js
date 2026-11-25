import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workingDays } from '../src/dates/range.js';
test('Mon to Fri is five working days', () => {
  assert.equal(workingDays('2026-11-16', '2026-11-20'), 5);
});
test('Fri to Mon is two', () => {
  assert.equal(workingDays('2026-11-20', '2026-11-23'), 2);
});
