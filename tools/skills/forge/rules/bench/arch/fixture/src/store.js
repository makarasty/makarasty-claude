// In-memory storage. Insertion order is the creation order.
export function createStore() {
    const tasks = new Map();
    return {
        insert(task) {
            tasks.set(task.id, task);
            return task;
        },
        get(id) {
            return tasks.get(id);
        },
        all() {
            return [...tasks.values()];
        },
    };
}
