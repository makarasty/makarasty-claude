import { ValidationError } from './errors.js';

const MAX_TITLE = 200;

function parseDue(due) {
    if (due === undefined || due === null) return null;
    const ms = typeof due === 'string' ? Date.parse(due) : NaN;
    if (Number.isNaN(ms)) throw new ValidationError('due must be an ISO 8601 date string');
    return new Date(ms).toISOString();
}

export function validateNewTask(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('task must be an object');
    }
    const { userId, title, due } = input;
    if (typeof userId !== 'string' || userId.trim() === '') {
        throw new ValidationError('userId is required');
    }
    if (typeof title !== 'string' || title.trim() === '') {
        throw new ValidationError('title is required');
    }
    if (title.trim().length > MAX_TITLE) {
        throw new ValidationError(`title must be at most ${MAX_TITLE} characters`);
    }
    return { userId: userId.trim(), title: title.trim(), due: parseDue(due) };
}

export function validateListFilter(filter = {}) {
    const { userId, done } = filter;
    if (userId !== undefined && typeof userId !== 'string') {
        throw new ValidationError('userId filter must be a string');
    }
    if (done !== undefined && typeof done !== 'boolean') {
        throw new ValidationError('done filter must be true or false');
    }
    return { userId, done };
}
