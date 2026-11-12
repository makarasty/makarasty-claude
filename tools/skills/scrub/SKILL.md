---
description: Censors API keys, tokens, passwords and private keys pasted into this machine's chat transcripts, in place; dry run first, no value printed. Use on "зацензурь ключи в переписках", "убери секреты из чатов", "почисти токены в истории", "scrub secrets from transcripts".
argument-hint: "[--apply] [--min-age 10m]"
allowed-tools: Bash(node:*), Read
---

A script does the scan and the rewrite; the chat shows its counts, asks once, and reports.
The script is `"${CLAUDE_SKILL_DIR}/scrub.mjs"`; spell the full path in every command, shell variables do not survive between calls. It covers the transcripts (projects, subagents, history, paste-cache,
todos, handoff, the Desktop app session folders; not the installed skill folders there). Settings files, `~/.claude.json`, the
Codex, Gemini and Copilot folders and `file-history` (the /rewind checkpoints: masking one would put asterisks into the person's real file on a rewind) are only counted, never changed; say how many secrets sit in the checkpoints. With `--root <dir>` only that folder is read.

## Flow

1. `node "${CLAUDE_SKILL_DIR}/scrub.mjs"` (dry run, writes nothing). Show in the person's language: the total, counts by kind, counts
   by location, and the files with most hits, as the script prints them (kind, file, line, at most the
   known prefix like `ghp_…`). Never print, read back or quote a value; do not open the files to look.
2. Say which keys still need rotating at the provider, by kind found: scrubbing the transcript does not
   revoke a key, and everything typed into a chat was already sent to the model provider. Where to revoke:
   anthropic console.anthropic.com/settings/keys; openai platform.openai.com/api-keys; github
   github.com/settings/tokens; slack api.slack.com/apps; aws IAM access keys; google
   console.cloud.google.com/apis/credentials; telegram @BotFather `/revoke`; stripe dashboard API keys;
   jwt: rotate the signing secret if it is long-lived; private-key: a new key pair, remove the old public
   key everywhere it is trusted; bearer, url-password, keyword: the service the value belongs to. Test
   values that were never live need no rotation, but they are still scrubbed. The `elsewhere` lines are
   files the script does not touch (a key in `settings.json` env may be in use): name them so the person
   decides.
3. Ask one yes/no: censor them now? On yes, `node "${CLAUDE_SKILL_DIR}/scrub.mjs" --apply`. Each changed file keeps its size, byte
   offsets, line count and mtime; a `.jsonl` line changes only when it is still the same JSON apart from
   the asterisks. No backup is made, on purpose.
4. `node "${CLAUDE_SKILL_DIR}/scrub.mjs"` again and show that the count is zero, except the lines the script reports as `left`
   (a line that is not valid JSON, or a hit inside a JSON number) and any `busy` or
   `changed-during-scrub` file; name those.
5. List the `skipped-live` files (modified in the last 10 minutes, this chat's own transcript among them:
   a chat may be writing them right now). Say they get scrubbed on the next run, once they are older.

## When something is off

- `busy`: a `<file>.scrub-tmp` beside the file exists, from another scrub running or a crash. When no
  scrub runs, the tmp can go; then run again.
- `failed`: the copy did not match the original's size or line count, or the rename was refused (a
  process holds the file on Windows). The original is untouched; name the file and the reason.
- `over 512 MB` and binary files are not read.
- `--min-age 0` only on an explicit ask, when every other Claude chat is closed.

## Done when

The person saw the counts without any value, knows which keys to revoke and where, the second dry run shows
zero beyond the named leftovers, and the skipped live files are listed with the reason.

Status: `node "${CLAUDE_SKILL_DIR}/scrub.mjs" --selftest` covers every kind, base64 look-alikes, placeholders, a private key inside a
JSON string, a live file, CRLF, and each guard broken once; the trigger phrases were not A/B tested.
