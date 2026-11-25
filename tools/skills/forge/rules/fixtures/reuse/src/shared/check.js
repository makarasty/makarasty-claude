export function need(obj, fields) {
  const missing = fields.filter((f) => obj?.[f] === undefined || obj?.[f] === null)
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
}
