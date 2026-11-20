#!/usr/bin/env node
// Self-check of report.mjs: the example builds, and each broken copy of it fails with the expected message.
// Usage: node selftest.mjs   (exit 1 on the first case that behaves wrong)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = new URL('.', import.meta.url);
const script = new URL('report.mjs', here).pathname.replace(/^\/(\w:)/, '$1');
const example = JSON.parse(readFileSync(new URL('example.json', here), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'report-selftest-'));
const build = (data) => {
  const f = join(dir, 'r.json');
  writeFileSync(f, JSON.stringify(data));
  return spawnSync(process.execPath, [script, f, join(dir, 'r.html')], { encoding: 'utf8' });
};
const item = (extra) => ({ stop: 'later', owner: 'you', title: 'Проверить настройку', text: 'Короткий текст.', how: 'Ответь «да».', ...extra });
const withItem = (extra, top = {}) => ({ ...structuredClone(example), ...top, items: [...example.items, item(extra)] });

const cases = [
  ['the example builds', example, null],
  ['an unexplained name in a title', withItem({ title: 'Ставить context7?', answers: [['да', 'ставим'], ['нет', 'не ставим']] }), /names "context7" without saying/],
  ['a code in a title', withItem({ title: 'Видно ли `/focus` в приложении', text: 'Команда нужна для фокуса.' }), /names "`\/focus`" without saying/],
  ['a name explained in parentheses passes', withItem({ title: 'Подключить context7', text: 'context7 (сервис со свежей документацией библиотек) убирает устаревшие советы.' }), null],
  ['plain words first, the name in parentheses, passes', withItem({ title: 'Подключить сервис документации', text: 'Сервис свежей документации (context7) убирает устаревшие советы.' }), null],
  ['a name the reader knows passes', withItem({ title: 'Подключить Spotify', text: 'Нужно для музыки.' }, { known: ['API', 'Spotify'] }), null],
  ['a «quoted» menu label passes', withItem({ how: 'Открой «Settings → Billing» и ответь «да».' }), null],
  ['a question with no answers', withItem({ title: 'Оставить как есть?' }), /has no "answers"/],
  ['«Решить» with no answers', withItem({ title: 'Решить: машина или облако' }), /has no "answers"/],
  ['a question with answers passes', withItem({ title: 'Оставить как есть?', answers: [['да', 'ничего не меняем'], ['нет', 'переносим на облако']] }), null],
  ['an answer that is not a pair', withItem({ title: 'Оставить как есть?', answers: [['да'], ['нет', 'переносим']] }), /holds pairs/],
  ['a minor topic in two items', withItem({ text: 'И ещё про алерты.' }), /minor topic "алерт" is in 2 items/],
  ['a pointer to an agent', withItem({ text: 'Так нашёл агент 3.' }), /points into context/],
  ['a pointer to a source number', withItem({ text: 'Это видно в [4].' }), /points into context/],
  ['an unexplained variant letter', withItem({ text: 'Лучше вариант B.' }), /points into context|names "B"/],
  ['a research wave', withItem({ text: 'Первая волна ошиблась.' }), /points into context/],
  ['a question inside a tag', withItem({ tags: [['8', 'Убрать ли старые навыки?']] }), /question inside a tag/],
  ['a research file as the source', withItem({ src: '`12-verification.md`' }), /research working file/],
  ['a minor topic in the headline', { ...structuredClone(example), headline: example.headline + ' Алерты тоже.' }, /leads the page/],
  ['one number in four cards', { ...structuredClone(example), items: [...example.items, ...[1, 2, 3, 4].map((i) => item({ title: `Проверить узел ${i}`, text: 'Всего 6 429 вызовов.' }))] }, /"6 429" is in 4 cards/],
  ['a long "more"', withItem({ more: 'Слово '.repeat(250) }), /over 1200 chars/],
];
let bad = 0;
for (const [name, data, expectErr] of cases) {
  const res = build(data);
  const out = `${res.stdout}${res.stderr}`;
  const ok = expectErr ? res.status === 1 && expectErr.test(out) : res.status === 0;
  if (!ok) { bad++; console.error(`FAIL ${name}\n${out.trim()}`); } else console.log(`ok   ${name}`);
}
rmSync(dir, { recursive: true, force: true });
if (bad) { console.error(`${bad} case(s) failed`); process.exit(1); }
console.log(`all ${cases.length} cases pass`);
