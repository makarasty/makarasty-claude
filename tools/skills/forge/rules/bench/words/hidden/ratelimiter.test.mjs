import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/token-bucket.js';

const mk = (o = {}) => { const c = { t: 0 }; const b = new TokenBucket({ capacity: 10, refillPerSecond: 2, now: () => c.t, ...o }); return [b, c]; };

test('h01 starts full', () => { const [b] = mk(); assert.equal(b.available(), 10); });
test('h02 consume n at once, then not enough', () => {
  const [b] = mk(); assert.equal(b.tryConsume(7), true); assert.equal(b.tryConsume(4), false); assert.equal(b.available(), 3);
});
test('h03 failed consume takes nothing', () => {
  const [b] = mk(); b.tryConsume(8); assert.equal(b.tryConsume(5), false); assert.equal(b.available(), 2);
});
test('h04 more than capacity returns false, no throw', () => { const [b] = mk(); assert.equal(b.tryConsume(11), false); assert.equal(b.available(), 10); });
test('h05 fractions accumulate across calls', () => {
  const [b, c] = mk({ capacity: 5, refillPerSecond: 1 }); b.tryConsume(5);
  c.t = 500; assert.equal(b.tryConsume(), false); c.t = 1000; assert.equal(b.tryConsume(), true); assert.equal(b.tryConsume(), false);
});
test('h06 available shows fractions', () => {
  const [b, c] = mk({ capacity: 5, refillPerSecond: 1 }); b.tryConsume(5); c.t = 500; assert.ok(Math.abs(b.available() - 0.5) < 1e-9);
});
test('h07 capped at capacity after long idle', () => {
  const [b, c] = mk(); b.tryConsume(10); c.t = 3_600_000; assert.equal(b.available(), 10); assert.equal(b.tryConsume(10), true); assert.equal(b.tryConsume(), false);
});
test('h08 repeated available() calls do not lose refill', () => {
  const [b, c] = mk({ capacity: 5, refillPerSecond: 1 }); b.tryConsume(5);
  for (let i = 1; i <= 10; i++) { c.t = i * 100; b.available(); }
  assert.ok(Math.abs(b.available() - 1) < 1e-9);
});
test('h09 invalid constructor args throw', () => {
  for (const bad of [{ capacity: -1 }, { capacity: 1.5 }, { capacity: NaN }, { capacity: '5' }, { capacity: undefined }, { refillPerSecond: 0 }, { refillPerSecond: -1 }, { refillPerSecond: Infinity }, { refillPerSecond: NaN }, { refillPerSecond: 'x' }])
    assert.throws(() => new TokenBucket({ capacity: 5, refillPerSecond: 1, ...bad }), undefined, JSON.stringify(bad));
});
test('h10 invalid n throws', () => {
  const [b] = mk();
  for (const n of [0, -1, 1.5, NaN, '2', null]) assert.throws(() => b.tryConsume(n), undefined, String(n));
  assert.throws(() => b.msUntilAvailable(0));
  assert.equal(b.available(), 10);
});
test('h11 msUntilAvailable', () => {
  const [b, c] = mk(); assert.equal(b.msUntilAvailable(), 0); assert.equal(b.msUntilAvailable(10), 0);
  b.tryConsume(10); assert.equal(b.msUntilAvailable(), 500); assert.equal(b.msUntilAvailable(3), 1500);
  c.t = 100; assert.equal(b.msUntilAvailable(), 400);
});
test('h12 msUntilAvailable rounds up', () => {
  const [b] = mk({ capacity: 3, refillPerSecond: 3 }); b.tryConsume(3); assert.equal(b.msUntilAvailable(), 334);
});
test('h13 msUntilAvailable Infinity above capacity', () => { const [b] = mk(); assert.equal(b.msUntilAvailable(11), Infinity); });
test('h14 clock going backwards changes nothing', () => {
  const [b, c] = mk(); c.t = 10_000; b.tryConsume(10); c.t = 11_000; assert.equal(b.available(), 2);
  c.t = 5_000; assert.equal(b.available(), 2); assert.equal(b.tryConsume(3), false); assert.equal(b.tryConsume(2), true);
});
test('h15 after a backwards step, refill resumes only past the old time', () => {
  const [b, c] = mk(); c.t = 10_000; b.tryConsume(10); c.t = 11_000; b.available(); c.t = 5_000; b.available();
  c.t = 11_500; assert.ok(Math.abs(b.available() - 3) < 1e-9);
});
test('h16 default clock works', () => { const b = new TokenBucket({ capacity: 2, refillPerSecond: 1 }); assert.equal(b.tryConsume(2), true); assert.equal(b.tryConsume(), false); });
