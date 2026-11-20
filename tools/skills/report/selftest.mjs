#!/usr/bin/env node
// Self-check of report.mjs: the example builds, each picture renders, and each broken input fails with its message.
// Usage: node selftest.mjs   (exit 1 when any case behaves wrong)
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './report.mjs';

const example = readFileSync(new URL('example.md', import.meta.url), 'utf8');
const head = '# Новость одной фразой\n\nВся история для того, кто ничего не знает.\n\n';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const errs = (md) => build(md).errors.join(' | ');

const ex = build(example);
check('the example builds', ex.errors.length === 0, errs(example));
check('the example has a flow, bars, a code block and a note box', ['class="flow"', 'class="bars"', '<pre>', '<blockquote>'].every((s) => ex.html.includes(s)));
check('the title becomes the page title', ex.html.includes('<title>Ночная сборка снова проходит'));

const flow = build(`${head}\`\`\`flow\nА | Шаг -> Ещё (bad: упал)\n= подпись\n\`\`\`\n`).html;
check('flow: label, arrow, status and caption', flow.includes('flow-label') && flow.includes('step bad') && flow.includes('→') && flow.includes('<figcaption>подпись'));
const bars = build(`${head}\`\`\`bars\n* Новое: 14 мин\nСтарое: 28 мин\n= минуты сборки\n\`\`\`\n`).html;
check('bars: widths follow the numbers, the marked one is hot', bars.includes('width:50%') && bars.includes('width:100%') && bars.includes('bar hot'));
check('bars: thousands with a space parse', build(`${head}\`\`\`bars\nA: 2 400 KB\nB: 1 200 KB\n= размер\n\`\`\`\n`).html.includes('width:50%'));
const list = build(`${head}1. Открыть файл\n2. Запустить:\n\n   \`\`\`\n   npm test\n   \`\`\`\n3. Прислать результат\n`).html;
check('a numbered list keeps a code block inside its item and its numbering', /<ol><li>Открыть файл<\/li><li>Запустить:[\s\S]*<pre>[\s\S]*npm test[\s\S]*<\/li><li>Прислать/.test(list), list);
check('a table renders', build(`${head}| a | b |\n|---|---|\n| 1 | 2 |\n`).html.includes('<td>1</td>'));
check('text is escaped', build(`${head}a <b>x</b> & \`<i>\`\n`).html.includes('a &lt;b&gt;x&lt;/b&gt; &amp; <code>&lt;i&gt;</code>'));

// Red-team cases: code may hold what the prose checks forbid; lists, bold and tables survive real Markdown.
const fenced = build(`${head}\`\`\`bash\n# install\nnpm i # TODO later {{ x }} <style>\n\`\`\`\nА \`<script>\` и \`{{ x }}\` в тексте.\n`);
check('a # comment, {{ }}, TODO and <style> inside code are not errors', fenced.errors.length === 0 && fenced.html.includes('# install'), fenced.errors.join(' | '));
check('a BOM before the title is ignored', build(`﻿${head}`).errors.length === 0);
const loose = build(`${head}1. один\n\n2. два\n\n3. три\n`).html;
check('a loose numbered list stays one list', (loose.match(/<ol/g) ?? []).length === 1 && (loose.match(/<li>/g) ?? []).length === 3, loose);
check('bold around code keeps both', build(`${head}**запусти \`npm test\` сейчас**\n`).html.includes('<strong>запусти <code>npm test</code> сейчас</strong>'));
check('a pipe inside code stays in its cell', build(`${head}| a | b |\n|---|---|\n| x | \`p | q\` |\n`).html.includes('<td><code>p | q</code></td>'));
check('an arrow inside a flow note stays in the note', build(`${head}\`\`\`flow\nA -> B (bad: ждали 1 -> пришло 2)\n= x\n\`\`\`\n`).html.includes('ждали 1 -&gt; пришло 2'));
check('bars: the last colon holds the number', build(`${head}\`\`\`bars\nВ 12:30: 5 мин\nВ 13:00: 10 мин\n= время\n\`\`\`\n`).html.includes('width:50%'));
check('an English page says Copy', build('# News in one line\n\nThe whole story for someone new.\n\n```\nnpm test\n```\n').html.includes('>Copy<'));
check('a plain (word) in a flow step is text, not a status', build(`${head}\`\`\`flow\nLifeLines (frontend) -> Stedi (sandbox)\n= x\n\`\`\`\n`).errors.length === 0);
check('bars: the first colon with a spaced number wins', build(`${head}\`\`\`bars\nRun: 5 min at 10:30\nWalk: 10 min\n= x\n\`\`\`\n`).html.includes('width:50%'));
check('label lines keep their line breaks', build(`${head}**Что:** X\n**Где:** Y\n`).html.includes('<strong>Что:</strong> X<br>\n<strong>Где:</strong> Y'));
check('a password word and a masked connection string are not secrets', build(`${head}Поле password: обязательное. Строка \`postgres://user:***@host\`.\n`).errors.length === 0);
check('→ and --> are flow arrows too', (build(`${head}\`\`\`flow\nA → B --> C\n= x\n\`\`\`\n`).html.match(/class="step/g) ?? []).length === 3);
check('a lone parenthesis in a table cell keeps the columns', build(`${head}| a | b |\n|---|---|\n| Вариант (рекомендую | ок |\n`).html.includes('<td>ок</td>'));
const cases = [
  ['an unclosed svg', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9"><rect/>\n\`\`\`\n`, /end with <\/svg>/],
  ['a near-miss flow status', `${head}\`\`\`flow\nA -> B (failed: x)\n= x\n\`\`\`\n`, /ok, bad or wait/],
  ['a password assignment', `${head}\`\`\`\nDB_PASSWORD=hunter22x\npassword: hunter22x\n\`\`\`\n`, /password/],
  ['an svg handler after a slash', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9"/onload=alert(1)><rect/></svg>\n\`\`\`\n`, /event handler/],
  ['an svg with an encoded character', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9"><a href=&#106;avascript:x>t</a></svg>\n\`\`\`\n`, /encoded character/],
  ['an svg with a style', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9"><style>p{}</style></svg>\n\`\`\`\n`, /a style/],
  ['an svg without viewBox', `${head}\`\`\`svg\n<svg width="800"><rect/></svg>\n\`\`\`\n`, /viewBox/],
  ['a negative bar', `${head}\`\`\`bars\nA: -5\n= x\n\`\`\`\n`, /signed numbers/],
  ['a password in a connection string', `${head}\`\`\`\npostgres://app:hunter22@db:5432/x\n\`\`\`\n`, /password/],
  ['a JWT', `${head}eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop\n`, /token/],
  ['no title', 'Просто текст.\n', /exactly one/],
  ['two titles', '# А\n\nтекст\n\n# Б\n', /exactly one/],
  ['a list right under the title', '# Новость\n\n- пункт\n', /plain paragraph/],
  ['a token in the text', `${head}ключ sk-ant-api03-${'a'.repeat(30)}\n`, /key, token/],
  ['a template leftover', `${head}TODO дописать\n`, /template leftover/],
  ['raw script', `${head}<script>alert(1)</script>\n`, /raw HTML/],
  ['an svg with a handler', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9" onload="x()"><rect/></svg>\n\`\`\`\n`, /event handler/],
  ['an svg with an outside link', `${head}\`\`\`svg\n<svg viewBox="0 0 9 9"><a href="https://x.y">t</a></svg>\n\`\`\`\n`, /outside link/],
  ['bars without a caption', `${head}\`\`\`bars\nA: 1\n\`\`\`\n`, /needs a last line/],
  ['a bars line without a number', `${head}\`\`\`bars\nA: много\n= x\n\`\`\`\n`, /label: number unit/],
  ['a missing image', `${head}![подпись](nope.png)\n`, /not found/],
  ['an unclosed code block', `${head}\`\`\`\nnpm test\n`, /never closed/],
  ['a table without its line', `${head}| a | b |\n| 1 | 2 |\n`, /--- \| line/],
];
for (const [name, md, re] of cases) { const e = errs(md); check(name, re.test(e), e || '(no error)'); }

// The command line: a JSON input from the old skill gets one clear message; a good input writes the file.
const dir = mkdtempSync(join(tmpdir(), 'report-selftest-'));
const script = fileURLToPath(new URL('report.mjs', import.meta.url));
writeFileSync(join(dir, 'old.json'), '{}');
const old = spawnSync(process.execPath, [script, join(dir, 'old.json'), join(dir, 'o.html')], { encoding: 'utf8' });
check('an old JSON input is refused with a pointer to SKILL.md', old.status === 1 && /SKILL\.md/.test(old.stderr), old.stderr);
writeFileSync(join(dir, 'a.md'), example);
const ok = spawnSync(process.execPath, [script, join(dir, 'a.md'), join(dir, 'a.html')], { encoding: 'utf8' });
check('the command writes the page', ok.status === 0 && readFileSync(join(dir, 'a.html'), 'utf8').startsWith('<!doctype html>'), ok.stderr);
const colon = spawnSync(process.execPath, [script, join(dir, 'a.md'), join(dir, 'Stedi: проверка?.html')], { encoding: 'utf8' });
check('a colon or ? in the file name becomes a dash', colon.status === 0 && existsSync(join(dir, 'Stedi - проверка.html')), colon.stdout + colon.stderr);
rmSync(dir, { recursive: true, force: true });

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
