import { ValidationError } from './errors.js';

const DAY = 86400e3;
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function validateRecurrence(r) {
    if (r === undefined || r === null) return null;
    if (typeof r !== 'object' || Array.isArray(r)) throw new ValidationError('recurrence must be an object');
    if (r.type === 'daily') return { type: 'daily' };
    if (r.type === 'weekly') {
        if (!Array.isArray(r.days) || r.days.length === 0 || !r.days.every(d => isInt(d, 0, 6)) || new Set(r.days).size !== r.days.length) {
            throw new ValidationError('weekly recurrence needs days: distinct integers 0-6');
        }
        return { type: 'weekly', days: [...r.days] };
    }
    if (r.type === 'monthly') {
        if (!isInt(r.day, 1, 31)) throw new ValidationError('monthly recurrence needs day: integer 1-31');
        return { type: 'monthly', day: r.day };
    }
    if (r.type === 'yearly') return { type: 'yearly' };
    if (r.type === 'interval') {
        if (!isInt(r.days, 2, 365)) throw new ValidationError('interval recurrence needs days: integer 2-365');
        return { type: 'interval', days: r.days };
    }
    throw new ValidationError('unknown recurrence type');
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// Next due (ISO) strictly after `dueIso`, same time of day.
export function nextDue(dueIso, r) {
    const d = new Date(dueIso);
    if (r.type === 'daily') return new Date(d.getTime() + DAY).toISOString();
    if (r.type === 'interval') return new Date(d.getTime() + r.days * DAY).toISOString();
    if (r.type === 'yearly') {
        const n = new Date(d); n.setUTCFullYear(d.getUTCFullYear() + 1);
        if (n.getUTCMonth() !== d.getUTCMonth()) n.setTime(Date.UTC(d.getUTCFullYear() + 1, 1, 28) + d.getTime() % DAY);
        return n.toISOString();
    }
    if (r.type === 'weekly') {
        for (let i = 1; i <= 7; i++) {
            const c = new Date(d.getTime() + i * DAY);
            if (r.days.includes(c.getUTCDay())) return c.toISOString();
        }
    }
    const tod = d.getTime() % DAY + (d.getTime() < 0 ? DAY : 0);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let k = 0; k <= 1; k++) {
        const yy = y + Math.floor((m + k) / 12), mm = (m + k) % 12;
        const c = Date.UTC(yy, mm, Math.min(r.day, daysInMonth(yy, mm))) + tod;
        if (c > d.getTime()) return new Date(c).toISOString();
    }
}
