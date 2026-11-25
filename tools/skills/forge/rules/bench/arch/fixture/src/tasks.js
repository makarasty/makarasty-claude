import { ConflictError, NotFoundError } from './errors.js';
import { validateListFilter, validateNewTask } from './validate.js';

// Tasks with a due date come first, earliest first; tasks without one go last.
// Equal keys keep creation order (Array.prototype.sort is stable).
function byDue(a, b) {
    if (a.due === b.due) return 0;
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
}

export function createTaskService({ store, now, nextId }) {
    const snapshot = task => ({ ...task });

    function createTask(input) {
        const data = validateNewTask(input);
        const task = {
            id: nextId(),
            userId: data.userId,
            title: data.title,
            due: data.due,
            done: false,
            createdAt: new Date(now()).toISOString(),
            completedAt: null,
        };
        store.insert(task);
        return snapshot(task);
    }

    function getTask(id) {
        const task = store.get(id);
        if (!task) throw new NotFoundError(`task ${id} not found`);
        return snapshot(task);
    }

    function listTasks(filter = {}) {
        const { userId, done } = validateListFilter(filter);
        return store
            .all()
            .filter(t => (userId === undefined || t.userId === userId) && (done === undefined || t.done === done))
            .sort(byDue)
            .map(snapshot);
    }

    function completeTask(id) {
        const task = store.get(id);
        if (!task) throw new NotFoundError(`task ${id} not found`);
        if (task.done) throw new ConflictError(`task ${id} is already completed`);
        task.done = true;
        task.completedAt = new Date(now()).toISOString();
        return snapshot(task);
    }

    return { createTask, getTask, listTasks, completeTask };
}
