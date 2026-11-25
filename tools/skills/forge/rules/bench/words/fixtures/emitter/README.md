# Event emitter

Implement `src/emitter.js` (ES module, no dependencies) exporting a class `Emitter`.

## Methods

- `on(event, fn)`: registers `fn` for `event` and returns an unsubscribe function. The unsubscribe function removes exactly that registration, and calling it again does nothing. `fn` that is not a function throws a `TypeError`. `event` may be any value usable as a `Map` key.
- `once(event, fn)`: like `on`, but `fn` is called at most once: it is removed before it is called, so an `emit` of the same event made from inside `fn` does not call it again. Its unsubscribe function works before it has fired.
- `off(event, fn)`: removes the most recently added registration of `fn` for `event` (a `once` registration counts) and returns `true`; returns `false` if there is none.
- `emit(event, ...args)`: calls the listeners of `event` in registration order with `args`, then the wildcard listeners in registration order, and returns the number of listeners called. Listeners are called with `this` set to the emitter.
- `listenerCount(event)`: the number of registrations for `event`.

## Wildcard

- The event `'*'` is the wildcard. `on('*', fn)` registers a listener that runs for every emitted event, after the listeners of that event, and receives `(event, ...args)`.
- `emit('*')` throws an `Error`. `listenerCount('*')` counts wildcard registrations.

## While emitting

- The listeners to call are fixed when `emit` starts: a listener added during the emit is not called in that emit.
- A listener removed (by `off`, an unsubscribe function, or because it is a `once` listener that already fired) before its turn is not called, even though it was registered when the emit started.
- The same function registered twice is called twice.
- If a listener throws, the remaining listeners are still called. After the last one, a single error is rethrown as it is; two or more errors are thrown together as an `AggregateError` whose `errors` array lists them in the order they occurred.

## Tests

`npm test` runs `test/visible.test.mjs`. Other cases exist that you cannot see: follow this spec, not only the visible tests.
