import type { Register } from 'claude-code'
import { register as router } from './router.ts'
import { register as gitGuard } from './git-guard.ts'
import { register as killGuard } from './kill-guard.ts'
import { register as reads } from './reads.ts'
import { register as deleteGuard } from './delete-guard.ts'
import { register as loopGuard } from './loop-guard.ts'
import { register as budgetGuard } from './budget-guard.ts'
import { register as secretGuard } from './secret-guard.ts'
import { register as generatedGuard } from './generated-guard.ts'
import { register as gates } from './gates.ts'
import { register as inbox } from './inbox.ts'
import { register as askGuard } from './ask-guard.ts'

// The engine loads one hooks module per plugin: this is it.
export const register: Register = (on, options) => {
  // First: a hook sees another hook's refusal only when it is registered before it.
  loopGuard(on, options)
  router(on, options)
  gitGuard(on, options)
  killGuard(on, options)
  reads(on, options)
  deleteGuard(on, options)
  budgetGuard(on, options)
  secretGuard(on, options)
  generatedGuard(on, options)
  gates(on, options)
  // Before the inbox: a refused question never becomes an inbox item.
  askGuard(on, options)
  // Last: it waits on the dialog beneath, so every guard above has already let the call through.
  inbox(on, options)
}
