const notes = []

// Titles are stored trimmed, so "  Buy milk " and "Buy milk" are the same note.
export function add(title, body = '') {
  const t = String(title).trim()
  notes.push({ title: t, body })
  return notes.length
}

export const all = () => notes.slice()
