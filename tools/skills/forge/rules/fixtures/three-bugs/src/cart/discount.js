const CODES = { TEN: 0.1, FIVE: 0.05 };
export function discountFor(code, sum) {
  return Math.round(sum * (CODES[code] ?? 0));
}
