import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../src/csv.js';

test('parses plain rows', () => {
  assert.deepEqual(parse('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('quoted field with comma and escaped quote', () => {
  assert.deepEqual(parse('"x,y","say ""hi"""'), [['x,y', 'say "hi"']]);
});

test('stringify quotes when needed', () => {
  assert.equal(stringify([['a', 'b,c']]), 'a,"b,c"');
});
