import type { Register } from 'claude-code'

// "Done" with no check behind it: the person's most repeated correction («ты уверен?», «перепроверь», «я не верю, что
// ты всё починил»: about 47 of 181 complaints 2026-06..11 [M73], docs/COMPLAINTS.md C01). The end-of-turn box is
// refused once when this chat edited code since its last passing box, ran nothing that checks it after the last edit,
// and the recap says it is done, fixed or works without saying what was not checked. A second call passes: the guard
// asks for a check, it never traps a turn. Docs (.md, .txt) and scratch or temp files need no run.
// shortcut: a check is read from the command's words, not its exit code; a failed test still counts as run.
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

let state = { edited: false, checked: true, warned: false }

export function shouldRefuse(recap: string, s = state): boolean {
  return s.edited && !s.checked && !s.warned && DONE.test(recap) && !ADMITS.test(recap)
}
const edited = () => { state.edited = true; state.checked = false; state.warned = false }

export const register: Register = (on) => {
  state = { edited: false, checked: true, warned: false }

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
    if (!('deny' in (r as object))) state = { edited: false, checked: true, warned: false }
    return r
  }).catch(($, e, next) => next(e))
}
