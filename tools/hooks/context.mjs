#!/usr/bin/env node
// context.mjs - tells the chat, not the person, when its own context has grown past the point where a
// handoff still comes out clean.
//
//   node context.mjs     UserPromptSubmit hook: the event on stdin; prints one line of context or nothing,
//                        never blocks, never exits non-zero. On SessionStart with source compact it
//                        prints where the full pre-compaction transcript lives instead.
//
// Context, not quota, is the limit people hit: over 2026-09, 208 of 533 chats passed 400k tokens and 94
// passed 600k. At 400k the reminder came too often for the operator's taste on 1M-context models, so since
// makarasty-tools 1.5.5 it fired at 600k, and since 1.5.6 at 700k, where the operator draws the yellow line;
// auto-compaction starts a little past 900k.
//
// The size is the last main-chain assistant turn's input + cache read + cache creation tokens, read from
// the tail of the transcript. The first reminder fires at MAKARASTY_HANDOFF_AT (default 700000), again
// every MAKARASTY_HANDOFF_STEP (default 150000) above that, once each. A /compact that drops it under the
// threshold, or by more than a step, re-arms it. 0 turns it off. A prompt that already asks for the
// handoff gets no reminder and does not use the level up.
//
// State: ${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/context/<session_id>, the last level reminded at.

import { openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const at = Number(process.env.MAKARASTY_HANDOFF_AT ?? 700000);
const step = Number(process.env.MAKARASTY_HANDOFF_STEP ?? 150000) || 150000;

// The last assistant usage, or the size a /compact left when its boundary comes later (a /compact fires
// no UserPromptSubmit, so the next prompt is the first to see it). Read backwards in 2 MB chunks, since
// screenshots and big tool results can fill one, up to 16 MB. null when that holds neither: an unknown
// size must not clear the marker.
const CHUNK = 2 * 1024 * 1024;
const LIMIT = 16 * 1024 * 1024;
function lastContext(path) {
  const fd = openSync(path, 'r');
  try {
    let end = fstatSync(fd).size;
    const stop = Math.max(0, end - LIMIT);
    let carry = Buffer.alloc(0); // the head of a line the later chunk cut, completed by this one
    while (end > stop) {
      const len = Math.min(CHUNK, end - stop);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, end - len);
      end -= len;
      const all = Buffer.concat([buf, carry]);
      // Only what follows the first newline is whole lines, unless this chunk starts the file. A newline
      // byte never sits inside a UTF-8 character, so cutting there is safe.
      const cut = end > 0 ? all.indexOf(10) : -1;
      if (end > 0 && cut < 0) { carry = all; continue; }
      carry = cut < 0 ? Buffer.alloc(0) : all.subarray(0, cut);
      const lines = all.subarray(cut + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const boundary = lines[i].includes('"compact_boundary"');
        if (!boundary && !lines[i].includes('"usage"')) continue;
        let d;
        try { d = JSON.parse(lines[i]); } catch { continue; }
        if (boundary && d.subtype === 'compact_boundary') return d.compactMetadata?.postTokens || 0;
        if (d.type !== 'assistant' || d.isSidechain) continue;
        const u = d.message?.usage;
        const n = (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
        if (n) return n; // a synthetic turn (an API error, an interrupt) carries zeros
      }
    }
  } finally {
    closeSync(fd);
  }
  return null;
}

try {
  const ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
  // SessionStart after a compaction: the summary that replaced the conversation drops detail, but the
  // conversation itself is still on disk. A chat that knows where reads the exact wording instead of
  // guessing or asking the person again.
  if (ev.hook_event_name === 'SessionStart') {
    if (ev.source === 'compact' && ev.transcript_path) {
      console.log(
        `This chat was just compacted. The full conversation before it is still on disk, one JSON object ` +
        `per line: ${ev.transcript_path}. When the summary lacks a detail that matters - the person's exact ` +
        `request, an error string, a decision - search that file for it (grep, or a short node script over ` +
        `the user and assistant lines) rather than guessing or asking again. Never read it whole.`,
      );
    }
    process.exit(0);
  }
  if (!(at > 0)) process.exit(0);
  if (!ev.transcript_path || !ev.session_id) process.exit(0);
  // The prompt asks for the handoff already: say nothing, and leave the level for the next prompt. Only
  // the command, an imperative, or the word nearly alone; a prompt that merely mentions it still gets
  // the reminder. A miss only defers the reminder by one prompt.
  const p = String(ev.prompt || '').trim();
  const word = '(hand-?\\s?off|хенд-?\\s?офф)';
  if (
    /^\/(makarasty-tools:)?handoff\b/i.test(p) ||
    new RegExp(`^(сделай|давай|do|make)\\s.{0,40}${word}`, 'i').test(p) ||
    new RegExp(`^(\\S+\\s+)?${word}(\\s+\\S+)?[.!?]*$`, 'i').test(p)
  ) process.exit(0);
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty');
  const sid = String(ev.session_id).replace(/[^\w.-]/g, '_');
  // A fleet coordinator or worker (makarasty's fleet.sh records it here): the run's own marks watch its
  // context and the coordinator asks the operator once. This reminder there only produced handoff offers,
  // twelve from one coordinator on 2026-10-05, and one handoff nobody asked for. A record outlives its run
  // when the run is abandoned rather than landed: one whose run FINISHED, is gone, or was not rewritten for
  // two days (every worker call rewrites it) is deleted, and the reminder comes back.
  const rec = join(base, 'fleet-sessions', sid);
  let fleetRun = null;
  try { fleetRun = readFileSync(rec, 'utf8').split('\n')[0].trim(); } catch {}
  if (fleetRun !== null) {
    let live = false;
    try { live = Date.now() - statSync(rec).mtimeMs < 2 * 86400000 && statSync(fleetRun).isDirectory() && !existsSync(join(fleetRun, 'FINISHED')); } catch {}
    if (live) process.exit(0);
    rmSync(rec, { force: true });
  }
  const tokens = lastContext(ev.transcript_path);
  if (tokens === null) process.exit(0);
  const dir = join(base, 'context');
  const file = join(dir, String(ev.session_id).replace(/[^\w.-]/g, '_'));
  if (tokens < at) {
    rmSync(file, { force: true }); // back under after a /compact: the next crossing reminds again
    process.exit(0);
  }
  let last = 0;
  try { last = Number(readFileSync(file, 'utf8')) || 0; } catch {}
  if (tokens < last - step) last = 0;
  const level = at + Math.floor((tokens - at) / step) * step;
  if (level <= last) process.exit(0);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, String(level));

  const k = Math.round(tokens / 1000);
  console.log(
    `This chat's context is at ${k}k tokens. Answer the person's message as usual; then, unless this ` +
    `session is a fleet worker or the task ends within this turn, add one line offering to hand the rest ` +
    `to a fresh chat with /makarasty-tools:handoff, in the person's language; a fleet coordinator ignores this ` +
    `line; its marks come from the watch (COORDINATOR CONTEXT), and its relaunch is in fleet-plan 8b. Offer it at a natural break, ` +
    `not mid-edit: if this turn ends with work half-done, offer it at the next break. Do not run it unasked.`,
  );
} catch {
  // A hook that fails must not cost the person their prompt.
}
