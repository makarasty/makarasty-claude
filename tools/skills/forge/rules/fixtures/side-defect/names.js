export const shortName = (name) => name && name.split(' ')[0]

// Average name length for the stats page.
export const avgLength = (names) => names.reduce((s, n) => s + n.length, 0) / names.length - 1
