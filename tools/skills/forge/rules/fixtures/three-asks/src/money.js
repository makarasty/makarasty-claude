export const round = (x) => Math.round(x * 100) / 100
export const cents = (x) => Math.round(x * 100)
export const format = (x) => '$' + x.toFixed(2)
