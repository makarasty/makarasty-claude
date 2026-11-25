# taskly

A small task tracker: a library plus an HTTP server (`node:http`), in-memory storage, no dependencies.

    npm test         # node --test test/
    npm start        # PORT=3000 node src/main.js

Layout: `src/index.js` is the public entry. `tasks.js` holds the task service, `validate.js` input checks,
`store.js` the in-memory store, `server.js` + `router.js` the HTTP layer, `errors.js` the error classes.

## Public API (current)

```js
import { createTracker, createServer, ValidationError, NotFoundError, ConflictError } from './src/index.js';

const tracker = createTracker({ now: () => Date.now() });   // `now` returns epoch milliseconds
tracker.createTask({ userId, title, due? })   // -> task; due is an ISO 8601 string, stored as ISO UTC
tracker.getTask(id)                           // -> task, NotFoundError if unknown
tracker.listTasks({ userId?, done? })         // -> task[], due ascending, tasks without due last
tracker.completeTask(id)                      // -> the completed task; ConflictError if already completed
const server = createServer({ tracker });     // -> node:http Server (call server.listen yourself)
```

A task: `{ id, userId, title, due, done, createdAt, completedAt }` (`due`, `completedAt` are ISO UTC strings or null).

HTTP routes (JSON in and out; errors are `{ error: { code, message } }`):

| Route | Success | Errors |
|---|---|---|
| `GET /health` | 200 `{ ok: true }` | |
| `POST /tasks` body `{ userId, title, due? }` | 201 task | 400 |
| `GET /tasks?userId=&done=true\|false` | 200 `{ tasks: [...] }` | 400 |
| `GET /tasks/:id` | 200 task | 404 |
| `POST /tasks/:id/complete` | 200 task | 404, 409 |

`ValidationError` -> 400, `NotFoundError` -> 404, `ConflictError` -> 409.

## Specification: recurring tasks and reminders (to be implemented)

All times are UTC. Weekdays are numbers 0 (Sunday) to 6 (Saturday), as in `Date#getUTCDay()`.
Existing behaviour must stay as it is.

### Recurrence

`createTask` (and `POST /tasks`) accept an optional `recurrence`:

- `{ type: 'daily' }`
- `{ type: 'weekly', days: [1, 3] }`: `days` is a non-empty array of distinct integers 0-6
- `{ type: 'monthly', day: 31 }`: `day` is an integer 1-31

A task with a `recurrence` must have a `due`; otherwise (or for any other invalid recurrence) `ValidationError` / 400.
The created task has `recurrence` (the object as given, `null` when absent) and `nextTaskId` (`null` until completed).

Completing a recurring task creates the next task. The next task has the same `userId`, `title` and `recurrence`, is not done,
has `createdAt` = now, `nextTaskId: null`, and a new id. The completed task's `nextTaskId` is that new id (`completeTask`
and `POST /tasks/:id/complete` return the completed task with `nextTaskId` set). Completing a non-recurring task
leaves `nextTaskId: null`. Completing an already completed task is still a `ConflictError` and creates nothing.

The next `due` is computed from the completed task's `due` (not from the current time), keeping its time of day:

- daily: one day later.
- weekly: the first date strictly after the due date whose weekday is in `days`.
- monthly: the first date strictly after the due date that is day `min(day, days in that month)` of its month.
  So `day: 31` gives Jan 31, Feb 28 (29 in a leap year), Mar 31, Apr 30, and so on.

### Reminders (per user)

Each user has reminder offsets: minutes before a task's `due` at which that user wants a reminder. Default: none.

```js
tracker.setReminderOffsets(userId, [60, 10])  // -> [60, 10]. Replaces the offsets.
tracker.getReminderOffsets(userId)            // -> [60, 10]
tracker.pollReminders(userId)                 // -> reminder[], each reminder is returned by exactly one poll
```

Offsets: an array of at most 5 integers from 1 to 525600; duplicates are dropped and the result is sorted descending
(`[10, 60, 10]` -> `[60, 10]`). Anything else is a `ValidationError`. An empty array is allowed (no reminders).

A reminder `{ taskId, userId, title, due, offsetMinutes, remindAt }` exists for every task of that user that has a
`due`, for every offset, with `remindAt = due - offsetMinutes`. `pollReminders` returns the reminders with
`remindAt <= now < due` for tasks that are not done, ordered by `remindAt` ascending (ties: larger offset first),
and never returns the same (task, offset) pair twice, even if the offsets are changed afterwards.
Offsets are read at poll time, so a changed offset list applies to existing tasks. A task that is completed or whose
due time has passed yields nothing. The next task of a recurring task is a new task and has its own reminders.

HTTP:

| Route | Success | Errors |
|---|---|---|
| `PUT /users/:userId/reminders` body `{ offsetsMinutes: [60, 10] }` | 200 `{ userId, offsetsMinutes }` | 400 |
| `GET /users/:userId/reminders` | 200 `{ userId, offsetsMinutes }` | |
| `POST /users/:userId/reminders/poll` | 200 `{ reminders: [...] }` | |
