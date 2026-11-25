export function reserve(stock, sku, qty) {
  const have = stock.get(sku) ?? 0
  if (have < qty) return false
  stock.set(sku, have - qty)
  return true
}

export function lowStock(stock, threshold = 3) {
  return [...stock].filter(([, n]) => n <= threshold).map(([sku]) => sku)
}
