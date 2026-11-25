import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../src/csv.js';

test('c01 empty text and trailing terminators', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('a,b\r\n'), [['a', 'b']]);
  assert.deepEqual(parse('a\nb'), [['a'], ['b']]);
  assert.deepEqual(parse('a\r\nb\r\n'), [['a'], ['b']]);
});
test('c02 empty fields', () => {
  assert.deepEqual(parse('a,,c\n,\n'), [['a', '', 'c'], ['', '']]);
  assert.deepEqual(parse('a,\n'), [['a', '']]);
});
test('c03 blank line in the middle is a row with one empty field', () => {
  assert.deepEqual(parse('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(parse('a\r\n\r\nb'), [['a'], [''], ['b']]);
});
test('c04 quoted delimiter and escaped quotes', () => {
  assert.deepEqual(parse('"a,b","c""d","""",""""""'), [['a,b', 'c"d', '"', '""']]);
});
test('c05 quoted line breaks kept as written', () => {
  assert.deepEqual(parse('"a\nb","c\r\nd",e\n'), [['a\nb', 'c\r\nd', 'e']]);
});
test('c06 empty quoted field and quoted field at line end', () => {
  assert.deepEqual(parse('"",x\n"a"\n"b"'), [['', 'x'], ['a'], ['b']]);
  assert.deepEqual(parse('x,""'), [['x', '']]);
});
test('c07 quote inside unquoted field is literal', () => {
  assert.deepEqual(parse('ab"c,d"e'), [['ab"c', 'd"e']]);
});
test('c08 text after closing quote throws SyntaxError', () => {
  assert.throws(() => parse('"a"b,c'), SyntaxError);
  assert.throws(() => parse('"a" ,c'), SyntaxError);
});
test('c09 unterminated quote throws SyntaxError', () => {
  assert.throws(() => parse('a,"b'), SyntaxError);
  assert.throws(() => parse('"a""'), SyntaxError);
});
test('c10 spaces are kept', () => {
  assert.deepEqual(parse(' a , b \n'), [[' a ', ' b ']]);
  assert.deepEqual(parse('" a ",b'), [[' a ', 'b']]);
});
test('c11 lone CR stays in the field', () => {
  assert.deepEqual(parse('a\rb,c\r\nd'), [['a\rb', 'c'], ['d']]);
});
test('c12 BOM dropped', () => {
  assert.deepEqual(parse('﻿a,b'), [['a', 'b']]);
  assert.deepEqual(parse('﻿"a",b'), [['a', 'b']]);
});
test('c13 custom delimiter', () => {
  assert.deepEqual(parse('a;"b;c";d', { delimiter: ';' }), [['a', 'b;c', 'd']]);
  assert.deepEqual(parse('a,b\tc', { delimiter: '\t' }), [['a,b', 'c']]);
});
test('c14 invalid arguments', () => {
  for (const d of ['', ',,', '"', '\n', '\r']) assert.throws(() => parse('a', { delimiter: d }), undefined, JSON.stringify(d));
  for (const t of [null, undefined, 5, {}, ['a']]) assert.throws(() => parse(t), TypeError);
});
test('c15 stringify basics', () => {
  assert.equal(stringify([]), '');
  assert.equal(stringify([['a', 'b'], ['1', '2']]), 'a,b\r\n1,2');
  assert.equal(stringify([[1, null, undefined, true]]), '1,,,true');
});
test('c16 stringify quoting and delimiter', () => {
  assert.equal(stringify([['a"b', 'c\nd', 'e\rf', 'g,h', ' i ']]), '"a""b","c\nd","e\rf","g,h", i ');
  assert.equal(stringify([['a;b', 'c,d']], { delimiter: ';' }), '"a;b";c,d');
});
test('c17 single empty field row survives round trip', () => {
  assert.equal(stringify([['a'], ['']]), 'a\r\n""');
  assert.deepEqual(parse(stringify([['a'], [''], ['']])), [['a'], [''], ['']]);
});
test('c18 round trip', () => {
  const rows = [['a', 'b,c', 'd"e'], ['', 'line1\nline2', 'x\r\ny'], [' ', '"', ',']];
  assert.deepEqual(parse(stringify(rows)), rows);
});
