import { createIdGenerator } from './ids.js';
import { createStore } from './store.js';
import { createTaskService } from './tasks.js';

// `now` returns the current time as epoch milliseconds; tests pass a fake clock.
export function createTracker({ now = Date.now } = {}) {
    const store = createStore();
    return createTaskService({ store, now, nextId: createIdGenerator() });
}

export { createServer } from './server.js';
export { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
