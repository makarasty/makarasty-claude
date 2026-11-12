import type { EngineInterface, Register } from 'claude-code'

// The fleet's hooks, run only in a chat a fleet registered. A command hook is a process per tool call, and
// every chat with the plugin installed paid it: bash plus node, 0.1-0.2 s idle, about 1 s on a box a fleet
// was loading [M40]. Here the question "is this chat in a fleet?" is one file check inside the engine, and
// only a fleet chat reaches the same .mjs hooks with the same stdin and exit-code contract as before.

// The command hooks' two matchers in one literal, so the engine filters before the module runs.
const WATCHED = /^(Bash|PowerShell|Monitor|Agent|Task|Skill|Edit|Write|MultiEdit|NotebookEdit)$|^mcp__(.*[Bb]rowser|claude-in-chrome)__/
const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

type Ran = { exitCode: number; stderr: string }

// registerChip (lib.mts) writes this for every coordinator and worker, under the same configDir(). A record outlives its run
// (50 of 61 on one box named a gone or FINISHED run), so it counts as tools/hooks/gates.ts fleetLive counts it (the two
// plugins cannot import each other): its run folder exists without FINISHED, and it was rewritten in the last two days.
async function inFleet($: EngineInterface, sid: string): Promise<boolean> {
  if (!sid) return false
  const cfg = (await $.env.get('CLAUDE_CONFIG_DIR'))
    || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.claude`
  const rec = `${cfg.replace(/\\/g, '/').replace(/([^:/])\/+$/, '$1')}/makarasty/fleet-sessions/${sid}`
  let run: string
  try { run = (await $.fs.read(rec)).split('\n')[0]!.trim() } catch { return false }
  try {
    if (!run || (await $.fs.stat(run)).kind !== 'dir' || (await $.fs.exists(`${run}/FINISHED`))) return false
    // The record is written only at chips or a take-over, so a run that works for days outlives it: the run folder, and the
    // claimed and done folders the queue touches on every claim and finish, count as the run's own pulse.
    const now = await $.clock.now()
    for (const p of [rec, run, `${run}/tasks/claimed`, `${run}/tasks/done`]) {
      if (now - (await $.fs.stat(p).then(s => s.mtimeMs, () => 0)) < 2 * 86400000) return true
    }
    return false
  } catch { return false }
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

// The first user row from the head of the file: fs.read has no partial read and rejects over 4 MiB (172 of 6277 subagent
// transcripts were), so a big transcript is opened by a node one-liner that reads 256 KiB. A prompt longer than that is not a dispatch line.
// Line 1 is that row; line 2 is the message of the last SubagentHandback call in the file's last 256 KiB (JSON string), or empty.
const HEAD = "const fs=require('fs'),fd=fs.openSync(process.argv[1],'r'),b=Buffer.alloc(262144),n=fs.readSync(fd,b,0,b.length,0);" +
  "let f='';for(const l of b.toString('utf8',0,n).split('\\n')){try{if(JSON.parse(l).type==='user'){f=l;break}}catch{}}console.log(f);" +
  "const z=fs.fstatSync(fd).size,s=Math.max(0,z-262144),m=fs.readSync(fd,b,0,b.length,s);let o='';" +
  "const t=b.toString('utf8',0,m).split('\\n');for(let i=t.length-1;i>=0&&!o;i--){try{const c=JSON.parse(t[i]).message.content;" +
  "const h=c.find(x=>x.type==='tool_use'&&x.name==='SubagentHandback');if(h)o=JSON.stringify(String(h.input.message))}catch{}}console.log(o)"

// The SubagentHandback call's message in these rows, last one first; undefined when there is none.
function handbackIn(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = row(lines[i]!)?.message?.content
    const hb = Array.isArray(c) ? c.find(b => b && (b as { type?: string; name?: string }).type === 'tool_use' && (b as { name?: string }).name === 'SubagentHandback') as { input?: { message?: unknown } } | undefined : undefined
    if (hb) return String(hb.input?.message ?? '')
  }
  return undefined
}

// handback: the reply was the SubagentHandback call's message, so a block must ask for another call of it: plain text after
// a handback never reaches the caller, and the second stop is skipped (stop_hook_active).
async function firstPromptAndReply($: EngineInterface, path: string, last?: string): Promise<{ first: string; reply: string; handback: boolean }> {
  let text: string
  try { text = await $.fs.read(path) } catch {
    const out = await $.process.run(['node', '-e', HEAD, path], { timeoutMs: 5000 }).then(r => r.stdout.split('\n'), () => [])
    let hb: string | undefined
    try { hb = out[1]?.trim() ? String(JSON.parse(out[1])) : undefined } catch { /* no tail */ }
    return { first: textOf(row((out[0] ?? '').trim())?.message?.content), reply: hb ?? last ?? '', handback: hb !== undefined }
  }
  const lines = text.split('\n').filter(Boolean)
  const first = textOf(row(lines.find(l => row(l)?.type === 'user') ?? '')?.message?.content)
  // A subagent that ends with the SubagentHandback tool (any depth) has its reply in that call's input, not in a text
  // block: its transcript ends tool_use + tool_result, so the text fallback saw '' and every long reply passed [M61].
  const hb = handbackIn(lines)
  let reply = hb ?? last
  for (let i = lines.length - 1; reply === undefined && i >= 0; i--) {
    const r = row(lines[i]!)
    if (r?.type === 'assistant' && textOf(r.message?.content).trim()) reply = textOf(r.message?.content)
  }
  return { first, reply: reply ?? '', handback: hb !== undefined }
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
    const { first, reply, handback } = await firstPromptAndReply($, e.agent_transcript_path, e.last_assistant_message)
    const m = DISPATCH.exec(first.split('\n')[0] ?? '')
    if (!m) return done
    const chars = reply.trim().length
    const lines = reply.split('\n').filter(l => l.trim()).length
    if (chars <= 400 && lines <= 3) return done
    const [, run, id, kind] = m
    return { ...done, block: `Your reply is ${chars} chars / ${lines} lines. Write the full report to ${run}/reports/${id}${kind === 'review' ? '.review' : ''}.md (review: ${id}.review.md), then ${handback ? 'call SubagentHandback again with' : 'reply with'} at most 3 lines and 400 characters ending in ${kind === 'review' ? 'PASS or DEFECTS: <count>' : 'DONE, DONE_WITH_CONCERNS: <line> or BLOCKED: <line>'}.` }
  }).catch(($, e, next) => next(e))
}
