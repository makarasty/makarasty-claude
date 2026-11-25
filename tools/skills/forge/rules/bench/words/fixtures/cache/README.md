# LRU cache with expiry

Implement `src/lru-cache.js` (ES module, no dependencies) exporting a class `LRUCache`.

## Constructor

`new LRUCache({ maxSize, ttlMs, now, onEvict })`

- `maxSize`: positive integer, the most live entries kept.
- `ttlMs`: optional default time to live in milliseconds: a positive number (`Infinity` allowed, meaning never). Without it entries never expire.
- `now`: optional function returning the time in milliseconds, default `Date.now`.
- `onEvict`: optional function `(key, value, reason)` called whenever an entry leaves the cache, after the cache state is already updated (for a `set`, the new entry is already stored). `reason` is `'capacity'` (pushed out by a newer entry), `'expired'` (its time ran out) or `'deleted'` (`delete` or `clear`). Replacing the value of an existing key is not an eviction and does not call it.
- Invalid `maxSize`, `ttlMs`, `now` or `onEvict` throws. An invalid per-call `ttlMs` in `set` throws before the cache changes.

## Methods

- `set(key, value, { ttlMs } = {})`: stores the entry as the most recently used and returns the cache (chainable). The per-call `ttlMs` (same rules as above) overrides the default for this entry. Setting an existing key replaces its value, resets its expiry and makes it most recently used. When the cache then holds more than `maxSize` live entries, expired entries are removed first (reason `'expired'`), and if it is still too large the least recently used entries are removed one by one (reason `'capacity'`). The entry just set is never the one removed.
- `get(key)`: the value, or `undefined` if missing or expired. A hit makes the entry most recently used. It does not extend its expiry.
- `peek(key)`: like `get` but changes nothing about recency.
- `has(key)`: `true` if the key is present and not expired. Does not change recency. A value of `undefined` can be stored, so `has` can be `true` while `get` returns `undefined`.
- `delete(key)`: removes the entry and returns `true` if it was present and live (reason `'deleted'`). Returns `false` otherwise.
- `clear()`: removes every entry, least recently used first, reason `'deleted'` for live entries.
- `size` (a getter): the number of live entries.
- `keys()`: an array of the live keys, most recently used first.

## Expiry

- An entry set at time `t` with a time to live `d` is expired from time `t + d` on (at exactly `t + d` it is already expired).
- An expired entry is never returned and does not count towards `size` or `maxSize`. Whenever an operation finds expired entries it removes them and reports `'expired'` to `onEvict`, so every entry that leaves is reported exactly once.
- Keys are compared like a `Map` does (`NaN` is a usable key; `1` and `'1'` differ).

## Tests

`npm test` runs `test/visible.test.mjs`. Other cases exist that you cannot see: follow this spec, not only the visible tests.
