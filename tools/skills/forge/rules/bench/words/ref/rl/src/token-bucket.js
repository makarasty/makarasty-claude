const pos = n => Number.isInteger(n) && n > 0;
export class TokenBucket {
  #cap; #rate; #now; #tokens; #last;
  constructor({ capacity, refillPerSecond, now = Date.now } = {}) {
    if (!pos(capacity)) throw new RangeError('capacity');
    if (typeof refillPerSecond !== 'number' || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0) throw new RangeError('refill');
    this.#cap = capacity; this.#rate = refillPerSecond; this.#now = now; this.#tokens = capacity; this.#last = now();
  }
  #refill() {
    const t = this.#now();
    if (t <= this.#last) return;
    this.#tokens = Math.min(this.#cap, this.#tokens + (t - this.#last) * this.#rate / 1000);
    this.#last = t;
  }
  tryConsume(n = 1) { if (!pos(n)) throw new RangeError('n'); this.#refill(); if (n > this.#tokens) return false; this.#tokens -= n; return true; }
  available() { this.#refill(); return this.#tokens; }
  msUntilAvailable(n = 1) { if (!pos(n)) throw new RangeError('n'); if (n > this.#cap) return Infinity; this.#refill(); return n <= this.#tokens ? 0 : Math.ceil((n - this.#tokens) / this.#rate * 1000); }
}
