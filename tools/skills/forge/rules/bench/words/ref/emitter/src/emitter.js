const WILD = '*';
export class Emitter {
  #m = new Map();
  #add(event, fn, once) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const rec = { fn, once, removed: false };
    if (!this.#m.has(event)) this.#m.set(event, []);
    this.#m.get(event).push(rec);
    return () => this.#remove(event, rec);
  }
  #remove(event, rec) {
    if (rec.removed) return false;
    rec.removed = true;
    const l = this.#m.get(event); l.splice(l.indexOf(rec), 1); if (!l.length) this.#m.delete(event);
    return true;
  }
  on(event, fn) { return this.#add(event, fn, false); }
  once(event, fn) { return this.#add(event, fn, true); }
  off(event, fn) {
    const l = this.#m.get(event); if (!l) return false;
    for (let i = l.length - 1; i >= 0; i--) if (l[i].fn === fn) return this.#remove(event, l[i]);
    return false;
  }
  listenerCount(event) { return this.#m.get(event)?.length ?? 0; }
  emit(event, ...args) {
    if (event === WILD) throw new Error('cannot emit the wildcard');
    const todo = [...(this.#m.get(event) ?? []).map(r => [event, r, false]), ...(this.#m.get(WILD) ?? []).map(r => [event, r, true])];
    const errs = []; let n = 0;
    for (const [ev, r, wild] of todo) {
      if (r.removed) continue;
      if (r.once) this.#remove(wild ? WILD : ev, r);
      n++;
      try { r.fn.apply(this, wild ? [ev, ...args] : args); } catch (e) { errs.push(e); }
    }
    if (errs.length === 1) throw errs[0];
    if (errs.length) throw new AggregateError(errs, 'listeners threw');
    return n;
  }
}
