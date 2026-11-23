const DAY = 24 * 60 * 60 * 1000;
// Working days from the order day to delivery, both ends counted, weekends skipped.
export function workingDays(from, to) {
  let n = 0;
  for (let t = Date.parse(from); t < Date.parse(to); t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}
