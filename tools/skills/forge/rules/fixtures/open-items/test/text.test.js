import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../src/text/slug.js';
test('accents dropped', () => {
  assert.equal(slug('Crème Brûlée'), 'creme-brulee');
});
test('no dash at the ends', () => {
  assert.equal(slug('  Hello, World!  '), 'hello-world');
});
