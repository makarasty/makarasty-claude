---
description: Monthly review of how the person works with Claude, from all their chat transcripts - corrections, context size, clones, skill use, instructions typed again and again - against the month before. Use on "проанализируй мои чаты", "разбор моих чатов", "как я работаю с клодом", "ежемесячный разбор", "analyze my chats". Not for a fleet run's speed or cost (/makarasty:fleet-analyze).
argument-hint: [--since YYYY-MM-DD] [--until YYYY-MM-DD]
---

The owner wants one question answered every month: is the way I work with Claude getting better? A
script reads every transcript (about 1,700 files, 5 GB, under a minute), merges cloned chats, drops
machine prompts, and prints the numbers for a window and the window before it. You read the numbers; the
script judges nothing.

## Flow

1. Run `node "${CLAUDE_SKILL_DIR}/selfreview.mjs" --save` (add `--since` and `--until` from the arguments; the
   default window is the last 30 days). `--save` stores the result so the next run also shows the change
   since this one. The last stderr line is the run time and peak memory.
2. Report in the person's language, short, plain words:
   - **Three headline numbers with their change:** strict corrections %, chats over 700k, clone %. A rise in
     strict corrections or in chats over 700k is worse; a rise in clone % means more chats start by copying
     another chat.
   - **What improved and what got worse**, from the table. Name a number only when the change is larger than
     a few points and the counts behind it are not tiny; say so when it is noise.
   - **Skills to consider removing:** the installed-but-unused list. Every installed description is paid on
     every turn, so a skill unused for a month is a candidate, not a verdict; ask before deleting any.
   - **Repeated instructions:** phrases typed in three or more chats are tool candidates. Point to
     `/makarasty-tools:forge` for building one, and skip a phrase that is pasted data, not an instruction.
   - **One line on what the numbers cannot tell:** they count words and sizes, not whether the work was
     right; a correction is a regex hit on a prompt, and a quiet month can mean fewer chats, not better ones.
3. Offer once to run this monthly with the host's scheduling tool. Create a schedule only when the person says
   yes.

## Notes

- Windows are UTC days, `until` included; the previous window has the same length.
- Prompt text in the output is cut to 120 characters and tokens, keys and passwords are masked. Do not paste
  longer prompt text from the transcripts into the report.
- Self-tooling share counts projects named makarasty-claude, sunup or claude-desktop-toolbox.
- `node "${CLAUDE_SKILL_DIR}/selfreview.mjs" --selftest` checks the script on fake transcripts.

## Done when

The three headline numbers are given with their change, what got better and worse is named, the unused skills
and repeated instructions are listed, the limit of the numbers is stated, and the monthly schedule was
offered once.
