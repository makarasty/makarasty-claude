import { discountFor } from './discount.js';

// Total in cents: line prices, then the order discount, then VAT on the discounted sum.
export function total(lines, code) {
  const sum = lines.reduce((a, l) => a + l.price * l.qty, 0);
  const off = discountFor(code, sum);
  const net = sum - off;
  return Math.round((net - off) * 1.2);
}
