const okTtl = v => typeof v === 'number' && v > 0; // NaN fails, Infinity passes
export class LRUCache {
  #max; #ttl; #now; #on; #m = new Map(); // Map keeps insertion order: first = least recently used
  constructor({ maxSize, ttlMs, now = Date.now, onEvict } = {}) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) throw new RangeError('maxSize');
    if (ttlMs !== undefined && !okTtl(ttlMs)) throw new RangeError('ttlMs');
    if (typeof now !== 'function') throw new TypeError('now');
    if (onEvict !== undefined && typeof onEvict !== 'function') throw new TypeError('onEvict');
    this.#max = maxSize; this.#ttl = ttlMs ?? Infinity; this.#now = now; this.#on = onEvict;
  }
  #purge() {
    const t = this.#now(), out = [];
    for (const [k, e] of this.#m) if (t >= e.exp) out.push([k, e]);
    for (const [k] of out) this.#m.delete(k);
    for (const [k, e] of out) this.#on?.(k, e.v, 'expired');
  }
  #live(k) { const e = this.#m.get(k); if (!e) return undefined; if (this.#now() >= e.exp) { this.#m.delete(k); this.#on?.(k, e.v, 'expired'); return undefined; } return e; }
  set(key, value, { ttlMs } = {}) {
    if (ttlMs !== undefined && !okTtl(ttlMs)) throw new RangeError('ttlMs');
    this.#purge();
    this.#m.delete(key);
    this.#m.set(key, { v: value, exp: this.#now() + (ttlMs ?? this.#ttl) });
    const ev = [];
    while (this.#m.size > this.#max) { const [k, e] = this.#m.entries().next().value; this.#m.delete(k); ev.push([k, e.v]); }
    for (const [k, v] of ev) this.#on?.(k, v, 'capacity');
    return this;
  }
  get(key) { const e = this.#live(key); if (!e) return undefined; this.#m.delete(key); this.#m.set(key, e); return e.v; }
  peek(key) { return this.#live(key)?.v; }
  has(key) { return this.#live(key) !== undefined; }
  delete(key) { const e = this.#live(key); if (!e) return false; this.#m.delete(key); this.#on?.(key, e.v, 'deleted'); return true; }
  clear() {
    const t = this.#now(), all = [...this.#m]; this.#m.clear();
    for (const [k, e] of all) this.#on?.(k, e.v, t >= e.exp ? 'expired' : 'deleted');
  }
  get size() { this.#purge(); return this.#m.size; }
  keys() { this.#purge(); return [...this.#m.keys()].reverse(); }
}
