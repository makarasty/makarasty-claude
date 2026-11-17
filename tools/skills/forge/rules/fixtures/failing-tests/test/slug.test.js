import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slug } from '../slug.js'

test('spaces become dashes', () => assert.equal(slug('Hello World'), 'hello-world'))
test('runs of spaces become one dash', () => assert.equal(slug('a   b'), 'a-b'))
test('edges are trimmed', () => assert.equal(slug('  hi  '), 'hi'))
