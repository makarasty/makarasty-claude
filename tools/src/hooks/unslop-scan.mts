#!/usr/bin/env node
// Counts the tells of stock chatbot prose in a text, and checks that a rewrite kept every fact. It counts
// surface patterns only; it does not say who wrote a text and is not a verdict on one. The rule tables are
// our own.
//
//   node unslop-scan.mjs <file>                     one line per hit, "line:col rule "match"", then a summary
//   node unslop-scan.mjs -                          the same, text from stdin
//   node unslop-scan.mjs --check <file>             the same, exit 1 when any strong hit exists
//   node unslop-scan.mjs --before <orig> <rewrite>  fact lock: LOST = in the original, missing from the
//                                                   rewrite; ADDED = new number or URL in the rewrite;
//                                                   exit 1 when anything is LOST
//
// Strong tells count on one sighting; weak tells count as a density per 1000 words. Fenced blocks, inline
// code and indented code are never scanned for tics. Exit 0 in report mode, 1 for --check / a lost fact,
// 2 for a usage or read error.

import { readFileSync } from 'node:fs';

type Tier = 'strong' | 'weak';
type Rule = { id: string; tier: Tier; re: RegExp };
type Hit = { at: number; id: string; tier: Tier; text: string };

// \b does not work for Cyrillic, so a word is bounded by lookarounds on letters and digits.
const wrap = (s: string): string => `(?<![\\p{L}\\p{N}_])(?:${s})(?![\\p{L}\\p{N}_])`;
// raw = an anchored line pattern: no word boundaries, ^ matches at every line
const rule = (id: string, tier: Tier, src: string, raw = false): Rule => ({ id, tier, re: new RegExp(raw ? src : wrap(src), raw ? 'gimu' : 'giu') });
const Q = `['’]`;

const rules: Rule[] = [
  // strong: one sighting is enough
  rule('compliment-open', 'strong',
    `(?:great|excellent|fantastic|wonderful|good|fascinating|interesting) (?:question|point|catch)|what an? (?:great|good|fascinating|interesting) question|(?:отличн|хорош|замечательн|прекрасн|интересн)\\p{L}* (?:вопрос|мысль|наблюдение)\\p{L}*|(?:чудов|гарн|відмінн|цікав)\\p{L}* (?:запитання|питання)`),
  rule('chat-residue', 'strong',
    `let me know if|hope (?:this|that|it) helps|i hope this helps|feel free to|would you like me to|want me to|should i continue|is there anything else|надеюсь,? (?:это |что это |эт\\p{L}+ )?(?:поможет|помогло|было полезн\\p{L}*|пригодится)|если (?:вы )?(?:хотите|желаете|нужно),? (?:я )?(?:могу|давайте)|хотите,? (?:чтобы )?(?:я|могу)|дайте знать|сподіваюсь,? (?:це |що це )?(?:допоможе|допомогло|стане у пригоді)|якщо (?:ви )?(?:хочете|бажаєте),? (?:я )?(?:можу|давайте)|хочете,? (?:щоб )?(?:я|можу)|дайте знати`),
  rule('not-just-but', 'strong',
    `not (?:just|only|merely|simply) [^.!?\\n]{1,60}?[,;\\s]+(?:but|it${Q}s|it is)|not (?:just|only) that|не (?:просто|только|лишь|тільки|лише) [^.!?\\n]{1,60}?[,;\\s]+(?:а|но и|но|а й|а ещё|але й|але)(?![\\p{L}])|не (?:просто|только|лишь) этого`),
  rule('announcement', 'strong',
    `let${Q}s (?:dive|break (?:this|it) down|unpack|delve)|without further ado|let me (?:break|walk) (?:this|it|you)|here${Q}s the thing|let me be clear|make no mistake|don${Q}t get me wrong|let me think step by step|breaking this down|давайте (?:разбер[её]м\\p{L}*|рассмотрим|погрузимся|углубимся|копн[её]м)|погрузимся в|давайте (?:розберемо|розглянемо|зануримося|розберімо)|и вот здесь начинается самое интересное`),
  rule('sycophancy', 'strong',
    `you(?:${Q}re| are) (?:absolutely|totally|completely) right|(?:вы|ты) (?:абсолютно|совершенно|полностью) прав\\p{L}*|ви (?:абсолютно|цілком|повністю) праві`),
  rule('narrated-candor', 'strong',
    `to be honest|to be fully transparent|i want to be upfront|honestly\\?|честно говоря|если честно|откровенно говоря|чесно кажучи|якщо чесно`),

  // weak: word choice and ornament
  rule('ai-word', 'weak',
    `delve\\p{L}*|tapestry|landscape\\p{L}*|realms?|leverag\\p{L}*|seamless\\p{L}*|robust\\p{L}*|pivotal|crucial\\p{L}*|foster\\p{L}*|underscor\\p{L}*|showcas\\p{L}*|testament|multifaceted|intricate|intricacies|elevat\\p{L}*|embark\\p{L}*|holistic|ever-evolving|game[- ]changer|deep dive|plethora|myriad|unlock\\p{L}*|comprehensive|cutting-edge|meticulous\\p{L}*|nuanced|journey|navigat(?:e|es|ing) (?:the |this |these |through )?(?:complex\\p{L}*|landscape|challenges|world|waters|nuances)`),
  rule('filler-adverb', 'weak',
    `simply|just|really|actually|basically|literally|genuinely|truly|essentially|fundamentally|honestly|undoubtedly|importantly|interestingly|notably|на самом деле|по сути|в принципе|буквально|насправді|по суті`),
  rule('transition', 'weak',
    `moreover|furthermore|additionally|in addition|consequently|it${Q}s worth noting|it is worth noting|it${Q}s important to note|стоит отметить|важно (?:понимать|отметить|помнить)|следует отметить|необходимо отметить|таким образом|в заключение|подводя итог|кроме того|более того|в связи с этим|варто зазначити|слід зазначити|важливо розуміти|таким чином|на завершення|підсумовуючи|крім того|більше того`),
  rule('kantselyarit', 'weak',
    `явля(?:ется|ются|лся|лась|лось|лись|ться)|осуществ\\p{L}*|данн(?:ый|ая|ое|ого|ому|ую|ой)|в рамках|в целях|на сегодняшний день|производится|посредством|в соответствии с|играет (?:важную|ключевую|значительную|большую) роль|подч[её]ркивает важность|в современном мире|комплексн\\p{L}* (?:подход|решени\\p{L}*)|раскр\\p{L}* потенциал\\p{L}*|вывест\\p{L}* на новый уровень|открывает новые (?:горизонты|возможности|перспективы)|можно с уверенностью сказать|на сьогоднішній день|з метою|здійсн\\p{L}*|у межах`),
  // a plain "not X, it's Y" can be a real correction, so it is weak; the catalog keeps those
  rule('contrast-frame', 'weak',
    `(?:(?:it${Q}s|it is|this is|that${Q}s|that is) not|(?:it|this|that) isn${Q}t) (?:an? |the )?[^.!?\\n,;]{1,40}[,;]\\s*(?:it${Q}s|it is|this is|that${Q}s|that is)|(?:это|эта|це) не [^.!?\\n,;]{1,40}[,;]\\s*(?:это|эта|це)`),
  rule('formula', 'weak',
    `at its core|the real question is|what really matters|the heart of the matter|sit with that|read that again|let that sink in|the punchline|a wide range of|numerous|worth (?:exploring|reading|checking out)|experts say|studies show|some critics`),
  rule('ing-rider', 'weak', `,\\s*(?:highlighting|underscoring|showcasing|fostering|reflecting|emphasi[sz]ing)`),
  rule('copula-avoidance', 'weak', `(?:serves?|served|serving|stands?|stood|standing) as (?:a|an|the)|boasts`),
  // markdown shape, anchored on a line
  rule('bold-label-bullet', 'weak', `^[ \\t]*(?:[-*+]|\\d+[.)]) \\*\\*[^*\\n]+(?::\\*\\*|\\*\\*:)`, true),
  rule('emoji-heading', 'weak', `^#{1,6}[ \\t]+\\p{Extended_Pictographic}`, true),
];

type Stripped = { prose: string; blocks: string[]; spans: string[] };
const blank = (s: string): string => s.replace(/[^\r\n]/g, ' ');
const LIST = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
// quote markers, indent and a list marker in front of a line: a fence can sit behind any of them
const LEAD = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?/;

// Same length as the input, code replaced by spaces, so offsets in `prose` are offsets in the text.
// shortcut: an indented line is code unless it follows a list item, as CommonMark has it; lazy continuation is not modelled.
function strip(text: string): Stripped {
  const blocks: string[] = [], spans: string[] = [];
  let fence = '', cur: string[] = [], inList = false;
  const prose = text.split('\n').map((line): string => {
    const rest = line.slice(LEAD.exec(line)![0].length);
    const m = /^(`{3,}|~{3,})/.exec(rest);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^[`~]+\s*$/.test(rest)) { blocks.push(cur.join('\n').trim()); fence = ''; cur = []; } else cur.push(line.trimEnd());
      return blank(line);
    }
    if (m) { fence = m[1]; return blank(line); }
    if (line.trim()) { if (LIST.test(line)) inList = true; else if (!/^\s/.test(line)) inList = false; }
    if (/^(?: {4}|\t)/.test(line) && line.trim() && !inList) { blocks.push(line.trim()); return blank(line); }
    return line.replace(/(`+)(.+?)\1/g, (s, _t: string, inner: string) => { spans.push(inner.trim()); return ' '.repeat(s.length); });
  }).join('\n').replace(/<code>([\s\S]*?)<\/code>/gi, (s, inner: string) => { spans.push(inner.trim()); return blank(s); });
  if (fence) blocks.push(cur.join('\n').trim());
  return { prose, blocks, spans };
}

const countWords = (prose: string): number => prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;

// URLs, link targets, file names and table rows hold names and data, not prose: blanked before the tic rules run.
const FILE = /(?<![\p{L}\p{N}_/\\.@-])[\p{L}\p{N}_-]+\.(?:mts|mjs|cjs|tsx?|jsx?|json|md|txt|py|sh|ya?ml|toml|css|html|vue|lock)(?![\p{L}\p{N}_])/giu;
const forScan = (prose: string): string => prose
  .replace(/https?:\/\/[^\s<>"')\]]+/g, blank).replace(/\]\([^)\s]*\)/g, blank).replace(FILE, blank).replace(/^[ \t]*\|.*$/gm, blank);

function scan(prose: string): Hit[] {
  const hits: Hit[] = [];
  for (const r of rules) for (const m of prose.matchAll(r.re)) hits.push({ at: m.index, id: r.id, tier: r.tier, text: m[0] });
  // A paragraph is a unit, but each list item and each table row is its own unit.
  const units: { at: number; text: string }[] = [];
  let unit: { at: number; text: string } | null = null, off = 0;
  for (const line of prose.split('\n')) {
    if (!line.trim()) unit = null;
    else if (!unit || LIST.test(line) || /^[ \t]*\|/.test(line)) { unit = { at: off, text: line }; units.push(unit); } else unit.text += `\n${line}`;
    off += line.length + 1;
  }
  // English dashes: more than one per unit. A dash near Cyrillic is Russian/Ukrainian punctuation, never flagged.
  for (const p of units) {
    const dashes = [...p.text.matchAll(/—|(?<=\s)(?:--|–)(?=\s)/g)]
      .map(d => ({ at: p.at + d.index, text: d[0] }))
      .filter(d => !/\p{Script=Cyrillic}/u.test(prose.slice(Math.max(0, d.at - 25), d.at + 26)));
    for (const d of dashes.slice(1)) hits.push({ at: d.at, id: 'em-dash-density', tier: 'weak', text: d.text });
  }
  return hits.sort((a, b) => a.at - b.at);
}

const tally = (hits: Hit[]): { strong: number; weak: number } => ({ strong: hits.filter(h => h.tier === 'strong').length, weak: hits.filter(h => h.tier === 'weak').length });
const proseOf = (text: string): string => forScan(strip(text).prose);

function report(text: string): { lines: string[]; strong: number; weak: number } {
  const prose = proseOf(text);
  const hits = scan(prose);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lines = hits.map(h => {
    let l = starts.length - 1;
    while (starts[l] > h.at) l--;
    return `${l + 1}:${h.at - starts[l] + 1} ${h.id} "${h.text.replace(/\s+/g, ' ')}"`;
  });
  const words = countWords(prose), { strong, weak } = tally(hits);
  lines.push(`words ${words}, hits ${hits.length}, ${words ? ((hits.length * 1000) / words).toFixed(1) : '0.0'} per 1000 words, strong ${strong}, weak ${weak}`);
  return { lines, strong, weak };
}

// Fact lock: what the original said that a rewrite must still say.
const UNITS = 'ms|µs|ns|s|с|sec|secs|seconds?|milliseconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|y|yrs?|years?|kib|mib|gib|kb|mb|gb|tb|b|bytes?|db|px|rem|em|pt|khz|mhz|ghz|hz|kg|mg|g|km|cm|mm|m|k|x|×|usd|eur|gbp|rub|uah|мс|милли\\p{L}*|мілі\\p{L}*|сек\\p{L}*|мин\\p{L}*|хв\\p{L}*|ч|час\\p{L}*|годин\\p{L}*|дн\\p{L}*|день|недел\\p{L}*|тиж\\p{L}*|мес\\p{L}*|міс\\p{L}*|год\\p{L}*|рок\\p{L}*|лет|кб|мб|гб|тб|байт\\p{L}*|шт|млн|млрд|тыс\\p{L}*|руб\\p{L}*|грн';
const NUMBER = new RegExp(`(?<![\\p{L}\\p{N}_.])([-−])?([$€£₽₴]\\s?)?(\\d+(?:[.,]\\d+)*)(?:\\s?(%|‰|(?:${UNITS})(?![\\p{L}\\p{N}_])))?`, 'giu');
const CURRENCY: Record<string, string> = { $: 'usd', '€': 'eur', '£': 'gbp', '₽': 'rub', '₴': 'uah' };
// one key per unit, so "10 ms" = "10 milliseconds" and "5 days" = "5 d"; the first match wins ("годин" before "год")
const UNIT_KEYS: [RegExp, string][] = [
  [/^(?:ms|milliseconds?|мс|милли\p{L}*|мілі\p{L}*)$/u, 'ms'], [/^(?:s|secs?|seconds?|с|сек\p{L}*)$/u, 's'],
  [/^(?:min|mins|minutes?|мин\p{L}*|хв\p{L}*)$/u, 'min'], [/^(?:h|hrs?|hours?|ч|час\p{L}*|годин\p{L}*)$/u, 'h'],
  [/^(?:d|days?|дн\p{L}*|день)$/u, 'd'], [/^(?:w|weeks?|недел\p{L}*|тиж\p{L}*)$/u, 'w'],
  [/^(?:months?|мес\p{L}*|міс\p{L}*)$/u, 'mo'], [/^(?:y|yrs?|years?|год\p{L}*|лет|рок\p{L}*)$/u, 'y'],
  [/^(?:b|bytes?|байт\p{L}*)$/u, 'b'], [/^(?:kb|кб)$/u, 'kb'], [/^(?:mb|мб)$/u, 'mb'], [/^(?:gb|гб)$/u, 'gb'], [/^(?:tb|тб)$/u, 'tb'],
  [/^(?:rub|руб\p{L}*)$/u, 'rub'], [/^(?:uah|грн)$/u, 'uah'],
];
const unitKey = (u: string): string => UNIT_KEYS.find(([re]) => re.test(u))?.[1] ?? (u.length > 3 ? u.slice(0, 3) : u);
const VERSION = /(?<![\p{L}\p{N}_.])(?:v\d+(?:\.\d+)*|\d+\.\d+\.\d+(?:\.\d+)*)(?:-[\p{L}\p{N}.]*[\p{L}\p{N}])?(?![\p{L}\p{N}_])/giu;
const IDTOKEN = /(?<![\p{L}\p{N}_.])[A-Za-z]+\d[A-Za-z\d]*(?![\p{L}\p{N}])/gu;
const SEG = '[\\p{L}\\p{N}_.@~-]+';
const PATH = new RegExp(`(?<![\\p{L}\\p{N}_/\\\\.:])(?:(?:[A-Za-z]:)?(?:\\.{1,2}|~)?(?:[\\\\/]${SEG})+|${SEG}(?:[\\\\/]${SEG})+)`, 'gu');
const NEG_EN = new RegExp(`(?<![\\p{L}\\p{N}_'’])(?:not|never|no|without|cannot|nothing|none|nobody|nowhere|nor|neither|\\p{L}+n${Q}t)(?![\\p{L}\\p{N}_])`, 'giu');
const NEG_CYR = new RegExp(wrap('не|нет|никогда|ни|без|нельзя|ничего|никто|нигде|никуда|невозможно|ні|ніколи|ніщо|ніхто|ніде|неможливо|немає|нема'), 'giu');

type Facts = { items: Map<string, string>; neg: { en: number; cyr: number } };

function facts(text: string): Facts {
  const { blocks, spans } = strip(text);
  let { prose } = strip(text);
  const items = new Map<string, string>();
  const add = (kind: string, key: string, shown = key): void => { items.set(`${kind}\0${key}`, shown.length > 70 ? `${shown.slice(0, 67)}...` : shown); };
  for (const b of blocks) if (b) add('code block', b.replace(/\s+/g, ' '));
  for (const s of spans) if (s) add('code', s);
  prose = prose.replace(/https?:\/\/[^\s<>"')\]]+/g, m => { add('url', m.replace(/[.,;:!?]+$/, '')); return ' '.repeat(m.length); });
  prose = prose.replace(PATH, m => {
    const p = m.replace(/[.,]+$/, '');
    // a path leads with ./ ~ / \ or a drive and has a letter, or ends in a name with an extension; "yes/no", "10/20/30", "05/01/2024" are not paths
    if (!((/^(?:[.~\\/]|[A-Za-z]:)/.test(p) && /\p{L}/u.test(p.slice(1))) || /(?:^|[\\/])\p{L}[^\\/]*\.\p{L}[\p{L}\p{N}]{0,4}$/u.test(p))) return m;
    add('path', p);
    return ' '.repeat(m.length);
  });
  prose = prose.replace(FILE, m => { add('path', m); return ' '.repeat(m.length); });
  prose = prose.replace(VERSION, m => { add('version', m.toLowerCase(), m); return ' '.repeat(m.length); });
  prose = prose.replace(IDTOKEN, m => { add('id', m.toLowerCase(), m); return ' '.repeat(m.length); });
  prose = prose.replace(/^[ \t]*\d+[.)](?=[ \t])/gm, s => ' '.repeat(s.length)); // list numbering is not a number
  for (const m of prose.matchAll(NUMBER)) {
    const cur = (m[2] ?? '').trim(), unit = unitKey((m[4] ?? '').toLowerCase()) || (cur ? CURRENCY[cur] : '');
    add('number', `${m[1] ? '-' : ''}${m[3].replace(/,/g, '.')}${unit}`, m[0].trim());
  }
  // the negation of "not just X, but Y" goes with the tell when a rewrite fixes it
  prose = prose.replace(rules.find(r => r.id === 'not-just-but')!.re, blank);
  return { items, neg: { en: prose.match(NEG_EN)?.length ?? 0, cyr: prose.match(NEG_CYR)?.length ?? 0 } };
}

function compare(orig: string, next: string): { lines: string[]; lost: number } {
  const a = facts(orig), b = facts(next), lines: string[] = [];
  let lost = 0, added = 0;
  for (const [k, shown] of a.items) if (!b.items.has(k)) { lost++; lines.push(`LOST ${k.split('\0')[0]} "${shown}"`); }
  for (const [k, shown] of b.items) {
    const kind = k.split('\0')[0];
    if ((kind === 'number' || kind === 'url') && !a.items.has(k)) { added++; lines.push(`ADDED ${kind} "${shown}"`); }
  }
  for (const g of ['en', 'cyr'] as const) if (b.neg[g] < a.neg[g]) { lost++; lines.push(`LOST negation (${g === 'en' ? 'English' : 'Russian/Ukrainian'}): original ${a.neg[g]}, rewrite ${b.neg[g]}`); }
  const was = tally(scan(proseOf(orig))), now = tally(scan(proseOf(next)));
  lines.push(`facts: lost ${lost}, added ${added}; tells: was ${was.strong} strong + ${was.weak} weak, now ${now.strong} strong + ${now.weak} weak`);
  return { lines, lost };
}

const read = (p: string): string => readFileSync(p === '-' ? 0 : p, 'utf8').replace(/^\uFEFF/, '');
const args = process.argv.slice(2);
const check = args.includes('--check');
const rest = args.filter(a => a !== '--check');
try {
  if (rest[0] === '--before' && rest.length === 3) {
    if (rest[1] === '-' || rest[2] === '-') throw new Error('--before reads two files; stdin (-) is not allowed');
    const { lines, lost } = compare(read(rest[1]), read(rest[2]));
    console.log(lines.join('\n'));
    process.exit(lost ? 1 : 0);
  } else if (rest.length === 1 && rest[0] !== '--before') {
    const { lines, strong } = report(read(rest[0]));
    console.log(lines.join('\n'));
    process.exit(check && strong ? 1 : 0);
  } else {
    console.error('usage: node unslop-scan.mjs [--check] <file | ->\n       node unslop-scan.mjs --before <original> <rewritten>');
    process.exit(2);
  }
} catch (e) {
  console.error(`unslop-scan: ${(e as Error).message}`);
  process.exit(2);
}
