import type { Register } from 'claude-code'
import { register as router } from './router.ts'
import { register as gitGuard } from './git-guard.ts'
import { register as reads } from './reads.ts'

// The engine loads one hooks module per plugin: this is it.
export const register: Register = (on, options) => {
  router(on, options)
  gitGuard(on, options)
  reads(on, options)
}
