// Old CSV import, replaced by the API sync in 2025.
export function importCsv(text) {
  return text.split('\n').map((l) => l.split(','))
}
