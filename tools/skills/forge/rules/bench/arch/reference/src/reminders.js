import { ValidationError } from './errors.js';

export function createReminderService({ store, now }) {
    const offsets = new Map();
    const delivered = new Set();

    function setReminderOffsets(userId, list) {
        if (!Array.isArray(list) || list.length > 5 || !list.every(n => Number.isInteger(n) && n >= 1 && n <= 525600)) {
            throw new ValidationError('offsets must be at most 5 integers from 1 to 525600');
        }
        const clean = [...new Set(list)].sort((a, b) => b - a);
        offsets.set(userId, clean);
        return [...clean];
    }

    const getReminderOffsets = userId => [...(offsets.get(userId) ?? [])];

    function pollReminders(userId) {
        const t = now(), out = [];
        for (const task of store.all()) {
            if (task.userId !== userId || task.done || task.due === null) continue;
            const due = Date.parse(task.due);
            for (const offsetMinutes of getReminderOffsets(userId)) {
                const remindAtMs = due - offsetMinutes * 60e3, key = `${task.id}:${offsetMinutes}`;
                if (remindAtMs <= t && t < due && !delivered.has(key)) {
                    delivered.add(key);
                    out.push({ taskId: task.id, userId, title: task.title, due: task.due, offsetMinutes, remindAt: new Date(remindAtMs).toISOString(), ms: remindAtMs });
                }
            }
        }
        return out.sort((a, b) => a.ms - b.ms || b.offsetMinutes - a.offsetMinutes).map(({ ms, ...r }) => r);
    }

    return { setReminderOffsets, getReminderOffsets, pollReminders };
}
