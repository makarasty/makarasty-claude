const ZONES = { domestic: 499, eu: 1499, world: 2999 }
export function rateCents(zone, weightKg) {
  const base = ZONES[zone]
  if (base === undefined) throw new Error(`unknown zone ${zone}`)
  return base + Math.max(0, Math.ceil(weightKg - 1)) * 200
}
