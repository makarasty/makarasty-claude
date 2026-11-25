const DAYS = { domestic: 3, eu: 7, world: 14 }
export const etaDays = (zone) => DAYS[zone] ?? 21
