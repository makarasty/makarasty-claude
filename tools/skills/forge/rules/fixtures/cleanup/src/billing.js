export const total = (rows) => rows.reduce((s, r) => s + r.cents, 0)
