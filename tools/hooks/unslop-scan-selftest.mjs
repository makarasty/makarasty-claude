#!/usr/bin/env node
// unslop-scan-selftest.mjs - the tell scanner and its fact lock, run through the real command line.
//
//   node --test tools/hooks/unslop-scan-selftest.mjs
//
// Tests the shipped tools/hooks/unslop-scan.mjs, never tools/src/: the .mjs is what a plugin user runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const scanner = join(basename(dirname(here)) === 'src' ? join(here, '..', '..', 'hooks') : here, 'unslop-scan.mjs');
const run = (args, input = '') => {
    const r = spawnSync(process.execPath, [scanner, ...args], { input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
};
const hitsOf = (text) => run(['-'], text).out.split('\n').filter(l => /^\d+:\d+ /.test(l)).map(l => l.split(' ')[1]);
// the fact lock reads files, so the pair goes through a temp dir
function lock(orig, next) {
    const d = mkdtempSync(join(tmpdir(), 'unslop-scan-'));
    try {
        writeFileSync(join(d, 'a.md'), orig);
        writeFileSync(join(d, 'b.md'), next);
        return run(['--before', join(d, 'a.md'), join(d, 'b.md')]);
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
}
const slopEn = `Great question! Let's dive in. It's not just a cache, it's a game-changer that helps you navigate the complexities of the landscape.

Moreover, this robust tool serves as a testament to seamless design. Let me know if you want more.

- **Speed:** it is fast.`;
const slopRu = `Отличный вопрос! Давайте разберём. Стоит отметить, что это является данным решением, которое осуществляется в рамках проекта. Таким образом, всё работает. Надеюсь, это поможет.

Это не просто кеш, а целая система.`;
const clean = `The parser reads \`config.json\` and returns the first match.

\`\`\`js
const robust = leverage(landscape) — delve; // moreover, let me know if
\`\`\`

    seamless tapestry realm — pivotal — crucial

Парсер читает файл и отдаёт первое совпадение — так проще — и быстрее — чем иначе.`;
test('English slop: strong and weak rules fire', () => {
    const r = run(['-'], slopEn);
    assert.equal(r.code, 0);
    for (const id of ['compliment-open', 'announcement', 'not-just-but', 'ai-word', 'transition', 'copula-avoidance', 'chat-residue', 'bold-label-bullet'])
        assert.ok(hitsOf(slopEn).includes(id), `${id} missing in:\n${r.out}`);
    assert.match(r.out, /^1:1 compliment-open "Great question"/m);
    assert.match(r.out, /strong \d+, weak \d+$/m);
});
test('Russian slop: strong and weak rules fire', () => {
    const ids = hitsOf(slopRu);
    for (const id of ['compliment-open', 'announcement', 'transition', 'kantselyarit', 'chat-residue', 'not-just-but'])
        assert.ok(ids.includes(id), `${id} missing: ${ids.join(' ')}`);
});
test('clean technical text with code and Russian dashes has zero hits', () => {
    const r = run(['--check', '-'], clean);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /hits 0,/);
});
test('English em dashes: the second one in a paragraph is flagged, the first is not', () => {
    assert.deepEqual(hitsOf('The tool — fast — works.'), ['em-dash-density']);
    assert.deepEqual(hitsOf('The tool — fast, small.'), []);
});
test('--check exits 1 on a strong hit and 0 on weak only; report mode always 0', () => {
    assert.equal(run(['--check', '-'], 'Great question.').code, 1);
    assert.equal(run(['--check', '-'], 'This is robust.').code, 0);
    assert.equal(run(['-'], 'Great question.').code, 0);
    assert.equal(run(['/no/such/file']).code, 2);
});
test('fact lock: lost number, negation, URL, path and code are LOST and exit 1', () => {
    const orig = 'It takes 42% less time, not more. See https://example.com/a and src/hooks/x.mts, run `npm test`.';
    const r = lock(orig, 'It takes less time. See the docs.');
    assert.equal(r.code, 1);
    for (const s of ['LOST number "42%"', 'LOST url "https://example.com/a"', 'LOST path "src/hooks/x.mts"', 'LOST code "npm test"', 'LOST negation (English)'])
        assert.ok(r.out.includes(s), `${s} missing:\n${r.out}`);
});
test('fact lock: Russian and Ukrainian negation lost', () => {
    assert.match(lock('Это не работает без ключа.', 'Это работает.').out, /LOST negation \(Russian\/Ukrainian\): original 2, rewrite 0/);
    assert.match(lock('Це ніколи не працює.', 'Це працює.').out, /LOST negation \(Russian\/Ukrainian\)/);
});
test('fact lock: a fenced block that changed is LOST', () => {
    const r = lock('Run:\n\n```sh\nnpm test\n```\n', 'Run:\n\n```sh\nnpm run test\n```\n');
    assert.equal(r.code, 1);
    assert.match(r.out, /LOST code block "npm test"/);
});
test('fact lock: an added number is reported but does not fail', () => {
    const r = lock('It is fast.', 'It is fast, 7 ms.');
    assert.equal(r.code, 0);
    assert.match(r.out, /ADDED number "7 ms"/);
});
test('fact lock: a clean rewrite loses nothing and shows fewer tells', () => {
    const r = lock('Great question! The job takes 5 seconds and does not retry.', 'The job takes 5 seconds and does not retry.');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /LOST|ADDED/);
    assert.match(r.out, /was 1 strong \+ 0 weak, now 0 strong \+ 0 weak/);
});
// red-team items 1-12
test('1: fixing a not-just-but tell does not lose its negation', () => {
    assert.equal(lock("It's not just fast, but also cheap.", "It's fast and cheap.").code, 0);
    assert.equal(lock('Это не просто быстро, а ещё и дёшево.', 'Это быстро и дёшево.').code, 0);
    assert.equal(lock('It is not safe, but fast.', 'It is safe and fast.').code, 1);
});
test('2: versions and letter+digit tokens are facts', () => {
    const r = lock('Released v1.7.0 with ES2022 and H264.', 'Released.');
    for (const s of ['LOST version "v1.7.0"', 'LOST id "ES2022"', 'LOST id "H264"'])
        assert.ok(r.out.includes(s), r.out);
});
test('3: a sign is part of the number; dB is a unit', () => {
    const r = lock('Gain drops by -3 dB.', 'Gain drops by 3 dB.');
    assert.match(r.out, /LOST number "-3 dB"/);
    assert.equal(lock('Range 10-20 and 2026-10-19.', 'Range 10-20 and 2026-10-19.').code, 0);
});
test('4: more negation words count', () => {
    for (const [a, b] of [['Nobody knows.', 'Somebody knows.'], ['Nothing works.', 'Something works.'], ['Нельзя так.', 'Можно так.'], ['Ничего не сломано.', 'Всё сломано.'], ['Ніхто не знає.', 'Знає.'], ['Neither fast nor cheap.', 'Fast and cheap.']])
        assert.match(lock(a, b).out, /LOST negation/, a);
});
test('5: fences inside a blockquote or a list item are not scanned', () => {
    assert.deepEqual(hitsOf('> ```\n> Moreover robust\n> ```\n'), []);
    assert.deepEqual(hitsOf('- item\n\n    ```\n    Moreover robust\n    ```\n'), []);
    assert.deepEqual(hitsOf('1. ```sh\n   Moreover robust\n   ```\n'), []);
});
test('6: list items and table rows are separate units for dash density', () => {
    assert.deepEqual(hitsOf('- one — two\n- three — four\n'), []);
    assert.deepEqual(hitsOf('| a — b |\n| c — d |\n'), []);
    assert.deepEqual(hitsOf('One — two\nthree — four.'), ['em-dash-density']);
});
test('7: URLs, link targets, <code> and file names are not scanned', () => {
    assert.deepEqual(hitsOf('See https://example.com/robust-seamless and [x](http://a/robust.html) and robust.txt and <code>seamless landscape</code>.'), []);
});
test('8: yes/no, dates and ratios are not paths', () => {
    const r = lock('Answer yes/no/maybe on 05/01/2024 and 10/20/30.', 'Answer.');
    assert.doesNotMatch(r.out, /LOST path/);
    assert.match(lock('See src/a/b.mts and ./x and /usr/bin.', 'See.').out, /LOST path "\/usr\/bin"/);
});
test('9: unit synonyms, decimal comma and currency symbol compare equal', () => {
    const r = lock('Takes 10 ms, 1,5 s, 5 days, 3 минуты, $5.', 'Takes 10 milliseconds, 1.5 seconds, 5 d, 3 мин, 5 USD.');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /ADDED/);
});
test('10: more tells are caught', () => {
    const cases = [
        ["It's not a bug, it's a design choice.", 'contrast-frame'], ['Это не баг, это фича.', 'contrast-frame'],
        ['Хотите, я покажу?', 'chat-residue'], ['Надеюсь, помогло.', 'chat-residue'], ['Раскрыть потенциал команды.', 'kantselyarit'],
        ['Честно говоря, не знаю.', 'narrated-candor'], ['To be honest, it works.', 'narrated-candor'], ['1. **Speed:** fast.', 'bold-label-bullet'],
    ];
    for (const [t, id] of cases)
        assert.ok(hitsOf(t).includes(id), `${id} missing for: ${t}`);
});
test('11: table rows are skipped; "not just that" is caught', () => {
    assert.deepEqual(hitsOf('| Moreover | robust |\n|---|---|\n'), []);
    assert.ok(hitsOf('Not just that, it also scales.').includes('not-just-but'));
});
test('12: a BOM is stripped; --before refuses stdin', () => {
    assert.match(run(['-'], '﻿Great question.').out, /^1:1 compliment-open/);
    const r = run(['--before', '-', '-']);
    assert.equal(r.code, 2);
    assert.match(r.out, /stdin/);
});
test('normal technical Russian (nominalisations, connectives) has zero hits', () => {
    assert.deepEqual(hitsOf('Реализация кеша на основе LRU. Обеспечение порядка в условиях гонки проверено тестом. В контексте задачи это работает.'), []);
});
