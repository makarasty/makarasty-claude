#!/usr/bin/env node
// Self-check of report.mjs: the example builds, each picture renders, and each broken input fails with its message.
// Usage: node selftest.mjs   (exit 1 when any case behaves wrong)
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build as rawBuild } from './report.mjs';

const example = readFileSync(new URL('example.md', import.meta.url), 'utf8');
const head = '# Новость одной фразой\n\nВся история для того, кто ничего не знает.\n\n';
// Every page names its chat and ends with how it was checked; cases about other rules get both.
const PROOF = '\n\n## Чем проверено\n\n- проверено.\n';
const build = (md, dir = '.', o = { chat: 'Тестовый чат' }) => rawBuild(/## Чем проверено/.test(md) ? md : md + PROOF, dir, o);
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
const looseMain = loose.split('class="ak-proof"')[0];
check('a loose numbered list stays one list', (looseMain.match(/<ol/g) ?? []).length === 1 && (looseMain.match(/<li>/g) ?? []).length === 3, looseMain);
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

// The fixed skeleton: chat bar, questions as cards on top, proof last, and each broken ask line named.
const F = '```';
const askMd = (body, info = '') => `${head}## Подробности\n\nниже.\n\n${F}ask${info}\n${body}\n${F}\n\n## Чем проверено\n\n- тест прошёл.\n- окно не открывал — не доказано.\n`;
const good = '? Перенести?\n* Да | станет рядом | высокая: прочитал код\n- Нет | как сейчас';
const page = build(askMd(good, ' Hub: cards'));
check('ask: builds', page.errors.length === 0, page.errors.join(' | '));
check('ask: the chat bar names the chat that made the page', page.html.includes('Страницу сделал чат <b>«Тестовый чат»</b>'));
check('ask: the block names the chat its answers go to', page.html.includes('data-chat="Hub: cards"') && page.html.includes('<b>«Hub: cards»</b>'));
check('ask: questions sit above the details, proof is last', page.html.indexOf('class="ak-q"') < page.html.indexOf('<h2>Подробности') && page.html.indexOf('class="ak-proof"') > page.html.indexOf('<h2>Подробности'));
check('ask: recommended and confidence are shown', page.html.includes('data-rec') && page.html.includes('рекомендую') && page.html.includes('Уверенность: высокая'));
check('ask: an unproven line is marked and counted', page.html.includes('class="ak-un"') && page.html.includes('Доказано: 1. Не доказано: 1.'));
check('ask: the runtime is inlined on every page (the chat bar copy button needs it)', page.html.includes("'ak-dock'") && build(`${head}текст\n`).html.includes("'ak-dock'"));
// Review cases (2026-11-27): one chat in two blocks, text after the cards, proof headings and lists, odd image paths.
const two = build(`${head}${F}ask X\n${good}\n${F}\n\nсередина\n\n${F}ask X\n? Ещё?\n- А | а | вкус: x\n- Б | б\n${F}\n\nпосле карточек\n\n## Чем проверено\n\n- да.\n`);
check('ask: two blocks for one chat become one section numbered 1, 2', (two.html.match(/class="ak-chat"/g) ?? []).length === 1 && two.html.includes('data-n="2"') && !two.html.includes('в 2 чат'), two.errors.join(' | '));
check('ask: text after the cards stays below them when there is no other heading', two.html.indexOf('после карточек') > two.html.indexOf('class="ak-asks"'));
check('ask: Russian plural for chats', build(askMd(good, ' A') + `\n${F}ask B\n${good}\n${F}\n`).html.includes('в 2 чатах'));
const nested = build(`${head}текст\n\n## Чем проверено\n\n- Тесты прошли\n  - e2e не проверено\n`);
check('proof: a nested unproven line marks the child, not its parent', nested.html.includes('<li class="ak-un" data-un="не доказано">e2e не проверено') && nested.html.includes('<li>Тесты прошли') && nested.html.includes('Доказано: 1. Не доказано: 1.'), nested.html.split('ak-proof"')[1]);
check('proof: "## Proof of concept" is not the proof section', /Чем проверено/.test(rawBuild(`${head}## Proof of concept\n\n- x\n`, '.', { chat: 'x' }).errors.join(' ')));
check('proof: an empty proof section is refused', /has no list/.test(rawBuild(`${head}## Чем проверено\n\nабзац.\n`, '.', { chat: 'x' }).errors.join(' ')));
check('proof: two proof sections are refused', /two "## Чем проверено"/.test(rawBuild(`${head}## Чем проверено\n\n- а\n\n## Как проверено ещё\n\n- б\n`, '.', { chat: 'x' }).errors.join(' ')));
check('ask: a page without questions says nothing is needed', build(`${head}текст\n`).html.includes('От тебя ничего не нужно'));
check('ask: a fence without a name uses the page chat', build(askMd(good)).html.includes('data-chat="Тестовый чат"'));
check('ask: a taste call reads as one', build(askMd('? Какой?\n- А | одно | вкус: чат не советовал\n- Б | другое')).html.includes('Дело вкуса'));
const askCases = [
  ['no chat name anywhere', () => rawBuild(askMd(good), '.', {}), /must name the chat/],
  ['no proof section', () => rawBuild(`${head}текст\n`, '.', { chat: 'x' }), /Чем проверено/],
  ['one option only', () => build(askMd('? А?\n* Да | x | высокая: y')), /at least two options/],
  ['two recommended', () => build(askMd('? А?\n* Да | x | высокая: y\n* Нет | z')), /one recommended/],
  ['no confidence at all', () => build(askMd('? А?\n- Да | x\n- Нет | z')), /how sure/],
  ['an option without what changes', () => build(askMd('? А?\n- Да | x | высокая: y\n- Нет')), /what changes/],
  ['an unknown confidence word', () => build(askMd('? А?\n- Да | x | уверен: y\n- Нет | z')), /how sure/],
  ['a line after the options', () => build(askMd('? А?\n- Да | x | высокая: y\n- Нет | z\nхвост')), /comes after its options/],
  ['a box on a missing shot', () => build(askMd('? А?\n![до](nope.png#box=1,1,2,2)\n- Да | x | высокая: y\n- Нет | z')), /not found/],
];
for (const [name, run, re] of askCases) { const e = run().errors.join(' | '); check(`ask error: ${name}`, re.test(e), e || '(no error)'); }
const pngDir = mkdtempSync(join(tmpdir(), 'report-shot-'));
const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
writeFileSync(join(pngDir, 's.png'), png);
const marked = build(askMd('? А?\n![до](s.png#box=1,1,5,5)\n- Да | x | высокая: y\n- Нет | z'), pngDir);
check('ask: a #box mark draws a box in % of the PNG', marked.html.includes('class="ak-mk"') && marked.html.includes('left:10.00%;top:10.00%;width:40.00%'), marked.errors.join(' | '));
check('ask: a box outside the image is refused', /inside 10x10/.test(build(askMd('? А?\n![до](s.png#box=1,1,50,5)\n- Да | x | высокая: y\n- Нет | z'), pngDir).errors.join(' ')));
writeFileSync(join(pngDir, 'Screenshot 1 (2).png'), png);
const spaced = build(askMd('? А?\n![до](Screenshot 1 (2).png "t") ![после](Screenshot%201%20(2).png)\n- Да | x | высокая: y\n- Нет | z'), pngDir);
check('ask: a shot path with spaces, parentheses, %20 or a "title" embeds', (spaced.html.match(/class="ak-shot"/g) ?? []).length === 2 && !spaced.html.includes('!['), spaced.errors.join(' | '));
rmSync(pngDir, { recursive: true, force: true });

// The command line: a JSON input from the old skill gets one clear message; a good input writes the file.
const dir = mkdtempSync(join(tmpdir(), 'report-selftest-'));
const script = fileURLToPath(new URL('report.mjs', import.meta.url));
writeFileSync(join(dir, 'old.json'), '{}');
const old = spawnSync(process.execPath, [script, join(dir, 'old.json'), join(dir, 'o.html'), '--chat', 'x'], { encoding: 'utf8' });
check('an old JSON input is refused with a pointer to SKILL.md', old.status === 1 && /SKILL\.md/.test(old.stderr), old.stderr);
writeFileSync(join(dir, 'a.md'), example);
const ok = spawnSync(process.execPath, [script, join(dir, 'a.md'), join(dir, 'a.html'), '--chat', 'Тест'], { encoding: 'utf8' });
check('the command writes the page', ok.status === 0 && readFileSync(join(dir, 'a.html'), 'utf8').startsWith('<!doctype html>'), ok.stderr);
const colon = spawnSync(process.execPath, [script, join(dir, 'a.md'), join(dir, 'Stedi: проверка?.html'), '--chat', 'Тест'], { encoding: 'utf8' });
check('a colon or ? in the file name becomes a dash', colon.status === 0 && existsSync(join(dir, 'Stedi - проверка.html')), colon.stdout + colon.stderr);
const noChat = spawnSync(process.execPath, [script, join(dir, 'a.md'), join(dir, 'b.html')], { encoding: 'utf8' });
check('the command without --chat writes nothing and says why', noChat.status === 1 && noChat.stderr.includes('--chat') && !existsSync(join(dir, 'b.html')), noChat.stderr);
rmSync(dir, { recursive: true, force: true });

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
