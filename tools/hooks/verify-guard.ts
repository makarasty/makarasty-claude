import type { Register } from 'claude-code'

// "Done" with no check behind it: the person's most repeated correction («ты уверен?», «перепроверь», «я не верю, что
// ты всё починил»: about 47 of 181 complaints 2026-06..11 [M73], docs/COMPLAINTS.md C01). The end-of-turn box is
// refused once when this chat edited code since its last passing box, ran nothing that checks it after the last edit,
// and the recap says it is done, fixed or works without saying what was not checked. A second call passes: the guard
// asks for a check, it never traps a turn. Docs (.md, .txt) and scratch or temp files need no run.
// A check is read from the command's words, not its exit code, so a failed test still counts as run.
// MAKARASTY_VERIFY_GUARD=off drops it.

export const MESSAGE =
  'Not wrapped up: this turn edited code and ran no check after the last edit, yet the recap says it is done, fixed or ' +
  'works. Run the cheapest check that would show it false (the scoped test, typecheck or build, the script itself, or ' +
  'open it in the browser pane), or say in the recap plainly what is not checked. Then call wrap_up again.'

const EDIT = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const NO_RUN = /\.(md|mdx|txt|rst)$|[\\/](scratchpad|Temp|tmp)[\\/]/i
// A shell line that edits files in place.
const EDIT_CMD = /\bsed\s+(-[a-z]*i|--in-place)|\bsg\b[^|;&]*\s-U\b|\b(Set-Content|Add-Content|Out-File)\b|writeFileSync|\bgit\s+apply\b|\bperl\s+-[a-z]*i/i
// A segment that checks: a test, typecheck, build, lint or format check, a script or app run, a request to it.
const CHECK = /\b(test|tests|spec|vitest|jest|mocha|pytest|pester|phpunit|rspec|tsc|tsx|typecheck|lint|eslint|ruff|prettier|analyze|build|compile|selftest|verify|check|cargo|go|dotnet|gradle|gradlew|mvn|make|msbuild|xcodebuild|node|deno|bun|py|python3?|pwsh|powershell|npm|npx|pnpm|yarn|curl|wget|Invoke-WebRequest|iwr|claude)\b|\.(ps1|sh|py|mjs|js|ts)\b/i
// A segment that only reads, installs or records: never a check, whatever words it holds.
const NOT_CHECK = /^\s*(git|cat|type|ls|dir|echo|Get-Content|gc|Get-ChildItem|gci|Select-Object|Select-String|grep|rg|find|head|tail|sed|awk|wc|less|more|stat|tree|cd|mkdir|cp|mv|rm|code|start|npm\s+(i|install|ci)\b|pnpm\s+(i|install|add)\b|yarn\s+(add|install)\b)\b/i
const isCheck = (cmd: string): boolean => cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""').split(/&&|\|\||[;|\n]/).some((s) => !NOT_CHECK.test(s) && CHECK.test(s))
// A claim of done, not "не готово" / "not done yet".
const DONE = /(?<!(?:не|ещё не|еще не|not|not yet|n't)\s)(готово|готов(?![а-яё])|исправил|исправлен|исправлено|починил|починен|почин(ено|ил)|работает|работают|сделано|сделал|\bdone\b|\bfixed\b|\bworks\b|\bpass(es|ed)\b|\bready\b|\bresolved\b|\bcompleted?\b)/i
const ADMITS = /(не провер|не делал провер|провер[а-я]* не делал|not yet|не запуска|не гонял|не прогон|не прогнал|без проверки|не тестир|не смотрел|проверка пропущ|not (checked|verified|tested|run)|unverified|untested|no tests? (were |was )?run|did not (check|run|test|verify)|didn['’]?t (check|run|test|verify)|haven['’]?t (run|checked|tested)|wasn['’]?t (run|checked|tested|verified)|skipped)/i

// The same once-only refusal for research: a reply that states numbers, versions or verdicts its subagents handed back
// with no source check after them. A report of 11-17 (c46c3894) said "такого хука нет" while verify-guard existed and
// "105 из 195 коммитов" for the inbox where 32 of 106 was true; the chat had run nine reads of its own, on other facts.
// So one or two hand-backs are covered by any own read, search, fetch or shell count after the last of them; three or
// more need a pass that checks them (a red team, a review, a subagent sent to verify), or «не проверено» on each line.
// Over 14 days it fires on 0.27% of turn ends, mostly reports built on subagents' numbers [M79].
// A reply with no subagent behind it is never read: the person's question answered from the repo is its own source.
export const RESEARCH =
  'Not finished: these lines state numbers or conclusions from subagents, and no source check ran after them. Check the ' +
  'sources (Read, Grep, a count, WebFetch), run /makarasty-tools:redteam, or write «не проверено» on those lines. Lines:'
// A line that claims: a percentage, money, "N из M", a count with "+", a verdict of existence, a cited study. Not a version
// and not "подтверждено": over 14 days version lines (a release, a dependency bump) and the chat's own "Подтверждено кодом"
// were most of the false fires.
const CLAIM = /\d+(?:[.,]\d+)?\s?%|[$€£]\s?\d|\d\s?(?:\$|usd\b|долл)|(?<![\w.])\d+\+?\s+(?:из|of|out of)\s+\d+|(?<![\w.])\d{2,}\+(?!\w)|(?<![a-zа-яё])(?:(?:такого|такой|таких|этого)(?:\s+[а-яё]+)?\s+нет|нет такого|не существует|не найден[оа]?|does(?: not|n['’]t) exist|no such|исследовани[ея] показал|research shows|studies show|по данным|according to)(?![a-zа-яё])/i
// The line says where it stands: unchecked, a guess, or a source named on it.
const SOURCED = /не провер|не подтвержд|не сверял|unverified|not (verified|checked|confirmed)|догадк|предполож|\bguess|проверил|сверил|посчитал|verified|checked|\[M\d+\]|https?:\/\/|\w\.\w+:\d+/i
// A test result or a run's progress ("773 из 773 проходят", "28 of 54 tasks are done", "Gate reads 3 of 6"): the chat's
// own run says it, and over 14 days these were most of what fired on a fleet coordinator.
// The run word must stand next to the count: "не проходит без проверки" two clauses away is no test result.
const RUN_WORD = String.raw`тест[а-яё]*|tests?|прош(ли|ёл|ло)|проход[а-яё]*|pass[a-z]*|green|зелён[а-яё]*|упал[а-яё]*|fail[a-z]*|задач[а-яё]*|батч[а-яё]*|batch[a-z]*|маркер[а-яё]*|markers?|gate|прогон[а-яё]*|runs?|раунд[а-яё]*|rounds?|круг[а-яё]*|готов[а-яё]*|done|guarded|covered`
const PROGRESS = new RegExp(String.raw`(?<![a-zа-яё])(${RUN_WORD})(?![a-zа-яё])[^.\n]{0,25}\d+\s*(из|of|/)\s*\d+|\d+\s*(из|of|/)\s*\d+[^.\n]{0,25}(?<![a-zа-яё])(${RUN_WORD})(?![a-zа-яё])`, 'i')
export function claimLines(text: string): string[] {
  if (typeof text !== 'string' || text.length > 200000) return []
  return text.replace(/```[\s\S]*?```/g, '').split(/\n/).map((l) => l.trim()).filter((l) => CLAIM.test(l) && !SOURCED.test(l) && !PROGRESS.test(l))
}
// A pass that checks what came back: by its skill, or a subagent sent to verify, recount or red-team.
const VERIFY_SKILL = /(redteam|review|finish|selfreview)$/
const VERIFY_AGENT = /red.?team|verif|fact.?check|recount|пересч|перепровер|провер|ревью|review|audit the (claims|report)/i
export type Research = { producers: number; own: number; warned: boolean; recap: string }
export const freshResearch = (): Research => ({ producers: 0, own: 0, warned: false, recap: '' })
let research = freshResearch()
// What a tool call does to the research state; `input` is the call's own fields.
export function noteTool(st: Research, tool: string, input: Record<string, unknown>): void {
  if (/^(Agent|Task)$/.test(tool)) {
    const kind = String(input.subagent_type ?? '')
    // By its description only: a research brief often says "review" or "проверь" in passing (c46c3894's consults did).
    if (VERIFY_AGENT.test(String(input.description ?? '')) || /reviewer$/.test(kind)) { st.producers = 0; st.warned = false }
    // A coder or a fleet lead hands back a change and its test run, not findings to repeat.
    else if (!/(coder|lead)$/.test(kind)) { st.producers++; st.own = 0 }
  } else if (tool === 'Skill' && VERIFY_SKILL.test(String(input.skill ?? ''))) { st.producers = 0; st.warned = false }
  else if (/^(Read|Grep|Glob|WebFetch|Bash|PowerShell|mcp__terminal__run_in_terminal)$/.test(tool)) st.own++
}
// The lines that refuse this text, or none. A refusal is once: the next ending passes, and a passing ending with claims
// clears the hand-backs it was about.
export function researchRefusal(text: string, st: Research): string[] {
  if (!st.producers) return []
  const bad = claimLines(text)
  if (bad.length < 3) return []
  const verified = st.producers < 3 && st.own > 0
  if (st.warned || verified) { Object.assign(st, freshResearch()); return [] }
  st.warned = true
  return bad
}
const listed = (l: string[]) => l.slice(0, 4).map((x, i) => `\n${i + 1}. ${x.slice(0, 160)}`).join('')
// What this turn said: every assistant text since the message that started it (a prompt, a hand-back, a notification).
// The report is often not the last message: in c46c3894 a question and a note came after it.
type Msg = { role: string; text: string }
export function turnText(msgs: readonly Msg[]): string {
  let k = msgs.length
  while (k > 0 && !(msgs[k - 1]!.role === 'user' && msgs[k - 1]!.text.trim() && !msgs[k - 1]!.text.trimStart().startsWith('<system-reminder>'))) k--
  return msgs.slice(k).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')
}
// The end of a main turn: gates.ts owns the one Stop hook and calls this after routes.ts.
export async function researchStop($: { env: { get(k: string): Promise<string | undefined> }; session: { messages(): Promise<readonly Msg[]> } }, e: { stop_hook_active?: boolean; last_assistant_message?: string }): Promise<string | undefined> {
  const recap = research.recap
  research.recap = ''
  if (e.stop_hook_active || !research.producers || (await $.env.get('MAKARASTY_VERIFY_GUARD')) === 'off') return undefined
  const said = turnText(await $.session.messages().catch(() => [])) || (e.last_assistant_message ?? '')
  const text = `${recap}\n${said}`
  const bad = researchRefusal(text, research)
  return bad.length ? RESEARCH + listed(bad) : undefined
}

let state = { edited: false, checked: true, warned: false }

export function shouldRefuse(recap: string, s = state): boolean {
  return s.edited && !s.checked && !s.warned && DONE.test(recap) && !ADMITS.test(recap)
}
const edited = () => { state.edited = true; state.checked = false; state.warned = false }

export const register: Register = (on) => {
  state = { edited: false, checked: true, warned: false }
  research = freshResearch()

  on('tool.call', { tool: /^(Agent|Task|Skill|Read|Grep|Glob|WebFetch|Bash|PowerShell|mcp__terminal__run_in_terminal)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (!('deny' in (r as object))) noteTool(research, e.tool, e as unknown as Record<string, unknown>)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: EDIT }, async ($, e, next) => {
    const r = await next(e)
    const i = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    if (!('deny' in (r as object)) && !NO_RUN.test(String(i.file_path ?? i.notebook_path ?? ''))) edited()
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Bash|PowerShell|Monitor|mcp__terminal__run_in_terminal)$/ }, async ($, e, next) => {
    const r = await next(e)
    const command = String((e as unknown as { command?: unknown }).command ?? '')
    if (!('deny' in (r as object))) { if (EDIT_CMD.test(command)) edited(); else if (isCheck(command)) state.checked = true }
    return r
  }).catch(($, e, next) => next(e))

  // A subagent that may have run the checks (not a read-only search), a skill run (review, finish), the browser pane.
  on('tool.call', { tool: /^(Agent|Task|SendMessage|Skill|mcp__Claude_Browser__.*)$/ }, async ($, e, next) => {
    const r = await next(e)
    const kind = String((e as unknown as { subagent_type?: unknown }).subagent_type ?? '')
    if (!('deny' in (r as object)) && !/^(Explore|Plan|claude-code-guide)$/.test(kind)) state.checked = true
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const recap = String((e as unknown as { recap?: unknown }).recap ?? '')
    if ((await $.env.get('MAKARASTY_VERIFY_GUARD')) !== 'off' && shouldRefuse(recap)) { state.warned = true; return { deny: MESSAGE } }
    const r = await next(e)
    if (!('deny' in (r as object))) { state = { edited: false, checked: true, warned: false }; research.recap = recap }
    return r
  }).catch(($, e, next) => next(e))
}
