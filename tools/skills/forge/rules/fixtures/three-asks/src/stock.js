import { round } from './money.js'

export const value = (rows) => round(rows.reduce((s, r) => s + r.count * r.cost, 0))
export const low = (rows, min) => rows.filter((r) => r.count < min)
