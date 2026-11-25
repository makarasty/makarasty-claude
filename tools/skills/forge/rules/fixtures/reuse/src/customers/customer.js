import { need } from '../shared/check.js'

export function displayName(c) {
  need(c, ['first', 'last'])
  return `${c.first} ${c.last}`.trim()
}

export function initials(c) {
  return `${c.first?.[0] ?? ''}${c.last?.[0] ?? ''}`.toUpperCase()
}
