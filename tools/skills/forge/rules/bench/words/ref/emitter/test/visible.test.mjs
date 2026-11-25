import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/emitter.js';

test('calls listeners in order with args', () => {
  const e = new Emitter(), got = [];
  e.on('x', (a, b) => got.push(['one', a, b]));
  e.on('x', (a, b) => got.push(['two', a, b]));
  assert.equal(e.emit('x', 1, 2), 2);
  assert.deepEqual(got, [['one', 1, 2], ['two', 1, 2]]);
});

test('once fires once', () => {
  const e = new Emitter(); let n = 0;
  e.once('x', () => n++);
  e.emit('x'); e.emit('x');
  assert.equal(n, 1);
});

test('unsubscribe works', () => {
  const e = new Emitter(); let n = 0;
  const off = e.on('x', () => n++);
  off();
  e.emit('x');
  assert.equal(n, 0);
});
