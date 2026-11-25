// Amounts live in integer cents; this is the one place that turns them into text for people.
export function cents2str(cents, currency = 'USD') {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer')
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}

export function totalOf(items) {
  return items.reduce((s, i) => s + i.priceCents * i.qty, 0)
}
