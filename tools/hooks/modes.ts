import type { EngineInterface, Register } from 'claude-code'

// The unslop and antislop modes inject their text at every session start while their flag file exists. They were two
// command hooks in plugin.json: a shell per chat start (about 0.149 s each against about 0.05 s in the engine [M40]) to
// learn "mode off". Here `$.fs.exists` asks and the text is read only when the mode is on; same context as the shell printed.
type Dollar = Pick<EngineInterface, 'env' | 'fs' | 'plugin'>

async function flagDir($: Dollar): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg}/makarasty`
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home}/.claude/makarasty` : undefined
}

// The mode's text, or undefined when its flag is absent or the file cannot be read (the shell hook printed nothing then too).
async function mode($: Dollar, flag: string, file: string, head = ''): Promise<string | undefined> {
  try {
    const dir = await flagDir($)
    if (!dir || !(await $.fs.exists(`${dir}/${flag}`))) return undefined
    return head + String(await $.fs.read(`${$.plugin.root}/hooks/${file}`))
  } catch { return undefined }
}

export const register: Register = (on) => {
  // One handler per source: the engine refuses a second unmatched SessionStart hook, and gates.ts has one.
  for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
    on('classic.SessionStart', { source }, async ($, e, next) => {
      const out = await next(e)
      const more = [
        await mode($, 'unslop.on', 'unslop.txt'),
        // antislop.mjs prints the same root line: the pointer names files relative to it.
        await mode($, 'antislop.on', 'antislop.txt', `antislop root: ${$.plugin.root.split('\\').join('/')}\n`),
      ].filter((s): s is string => s !== undefined)
      return more.length ? { ...out, additionalContext: [...(out.additionalContext ?? []), ...more] } : out
    })
  }
}
