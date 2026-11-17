# FIXED 2026-08-04: retry storm on login

The old src/retry.js retried login 50 times. Fixed by deleting src/retry.js. Trap that still holds: src/auth.js has no retry at all, so a flaky network shows a login error at once; do not add a retry loop without a cap.
