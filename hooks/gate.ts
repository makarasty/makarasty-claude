import type { EngineInterface, Register } from 'claude-code'

// The fleet's hooks, run only in a chat a fleet registered. A command hook is a process per tool call, and
// every chat with the plugin installed paid it: bash plus node, 0.1-0.2 s idle, about 1 s on a box a fleet
// was loading [M40]. Here the question "is this chat in a fleet?" is one file check inside the engine, and
// only a fleet chat reaches the same .mjs hooks with the same stdin and exit-code contract as before.

// The command hooks' two matchers in one literal, so the engine filters before the module runs.
const WATCHED = /^(Bash|PowerShell|Monitor|Agent|Task|Skill|Edit|Write|MultiEdit|NotebookEdit)$|^mcp__(.*[Bb]rowser|claude-in-chrome)__/
const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

type Ran = { exitCode: number; stderr: string }

// registerChip (lib.mts) writes this for every coordinator and worker, under the same configDir().
async function inFleet($: EngineInterface, sid: string): Promise<boolean> {
  if (!sid) return false
  const cfg = (await $.env.get('CLAUDE_CONFIG_DIR'))
    || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.claude`
  return $.fs.exists(`${cfg.replace(/\\/g, '/').replace(/([^:/])\/+$/, '$1')}/makarasty/fleet-sessions/${sid}`)
}

// A hook that cannot run is not a reason to block work: the command hooks this replaces failed open too.
async function hook($: EngineInterface, file: string, payload: object, timeoutMs: number): Promise<Ran | null> {
  try {
    return await $.process.run(['node', `${$.plugin.root}/hooks/${file}`], { stdin: JSON.stringify(payload), timeoutMs })
  } catch { return null }
}

// The PROMPT line dispatch prints; a run path may hold a space.
const DISPATCH = /^Read (.+?)\/tasks\/claimed\/([^/\s]+)\/(prompt|review)\.md and follow it/

type Row = { type?: string; message?: { content?: unknown } }
const textOf = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(b => (b && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n') : ''
const row = (l: string): Row | null => { try { return JSON.parse(l) } catch { return null } }

// shortcut: fs.read has no partial read, so a transcript over 4 MiB rejects and the check fails open.
async function firstPromptAndReply($: EngineInterface, path: string, last?: string): Promise<{ first: string; reply: string }> {
  const lines = (await $.fs.read(path)).split('\n').filter(Boolean)
  const first = textOf(row(lines.find(l => row(l)?.type === 'user') ?? '')?.message?.content)
  let reply = last
  for (let i = lines.length - 1; reply === undefined && i >= 0; i--) {
    const r = row(lines[i]!)
    if (r?.type === 'assistant' && textOf(r.message?.content).trim()) reply = textOf(r.message?.content)
  }
  return { first, reply: reply ?? '' }
}

export const register: Register = on => {
  on('tool.call', { tool: WATCHED }, async ($, e, next) => {
    const sid = await $.session.id()
    if (!(await inFleet($, sid))) return next(e)
    const { tool, tool_use_id: _id, agentId, consent: _c, ...input } = e as Record<string, unknown> & { tool: string; agentId?: string }
    const edit = EDITS.test(tool)
    const ran = await hook($, edit ? 'fleet-contract.mjs' : 'fleet-memory.mjs', {
      hook_event_name: 'PreToolUse', session_id: sid, cwd: await $.session.cwd(),
      tool_name: tool, tool_input: input, ...(agentId ? { agent_id: agentId } : {}),
    }, edit ? 5000 : 6000)
    return ran?.exitCode === 2 ? { deny: ran.stderr.trim() || 'refused by the fleet' } : next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    if (!(await inFleet($, e.session_id))) return done
    const ran = await hook($, 'fleet-guard.mjs', e, 5000)
    return ran?.exitCode === 2 ? { ...done, block: ran.stderr.trim() || 'refused by the fleet' } : done
  }).catch(($, e, next) => next(e))

  // A worker spawned from a dispatch prompt keeps the full report in the run and answers the coordinator in a few lines.
  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    if (e.stop_hook_active || !e.agent_transcript_path || !(await inFleet($, e.session_id))) return done
    const { first, reply } = await firstPromptAndReply($, e.agent_transcript_path, e.last_assistant_message)
    const m = DISPATCH.exec(first.split('\n')[0] ?? '')
    if (!m) return done
    const chars = reply.trim().length
    const lines = reply.split('\n').filter(l => l.trim()).length
    if (chars <= 400 && lines <= 3) return done
    const [, run, id, kind] = m
    return { ...done, block: `Your reply is ${chars} chars / ${lines} lines. Write the full report to ${run}/reports/${id}${kind === 'review' ? '.review' : ''}.md (review: ${id}.review.md), then reply with at most 3 lines and 400 characters ending in ${kind === 'review' ? 'PASS or DEFECTS: <count>' : 'DONE, DONE_WITH_CONCERNS: <line> or BLOCKED: <line>'}.` }
  }).catch(($, e, next) => next(e))
}
