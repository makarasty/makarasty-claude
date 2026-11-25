# Token bucket rate limiter

Implement `src/token-bucket.js` (ES module, no dependencies) exporting a class `TokenBucket`.

## Constructor

`new TokenBucket({ capacity, refillPerSecond, now })`

- `capacity`: positive integer, the most tokens the bucket holds.
- `refillPerSecond`: positive finite number, tokens added per second. Refill is continuous, so fractions of a token accumulate (1 token/second, two calls 500 ms apart, adds 1 token in total).
- `now`: optional function returning the current time in milliseconds. Defaults to `Date.now`. Tests inject a fake clock.
- The bucket starts full.
- Invalid `capacity` or `refillPerSecond` (not a number, NaN, zero, negative, non-integer capacity, infinite refill rate) throws.

## Methods

- `tryConsume(n = 1)`: takes `n` tokens and returns `true` if at least `n` are available, otherwise returns `false` and takes nothing. `n` must be a positive integer, otherwise throw. Asking for more than `capacity` returns `false`.
- `available()`: the current token count as a number, fractions included, never above `capacity`. Calling it any number of times does not change the outcome of later calls.
- `msUntilAvailable(n = 1)`: whole milliseconds, rounded up, until `n` tokens are available. `0` if they are available now. `Infinity` if `n` is above `capacity`. `n` is validated like in `tryConsume`.

## Clock

- Tokens never exceed `capacity`, however long the bucket sits idle.
- If the clock goes backwards (a later call sees an earlier time than before), no tokens are added or removed and the later time becomes the reference only once the clock passes the previous one again.

## Tests

`npm test` runs `test/visible.test.mjs`. Other cases exist that you cannot see: follow this spec, not only the visible tests.
