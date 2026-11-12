# Fleet configuration

<!-- A sample. /makarasty:fleet-init writes the real one at your project root after reading the project
     and asking what it cannot find. Every line is optional except where a command says otherwise.
     The full description is docs/PROTOCOL.md, "Project configuration". -->

- App origin: http://[::1]:5173
- Services: http://[::1]:5173 (start: npm run dev); http://127.0.0.1:5001 (start: operator)
- Login runbook: docs/HOW_TO_LOGIN_AS_AI.md
- Naming: user facing names come from mainNav labels and router meta.title
- Actions reserved for the operator: anything that dials, charges, ships, or messages a real person
- Verification cost: full test suite 63s, full typecheck 30s, both memory heavy
- Accelerators present: rg, sg. Absent: fd, jq.
- Concurrency: pane lane max 10 (display), repo lane max 10 (16 GB / 16 cores), verify lane 1
- Subscription: max tier, rate limits are not the binding constraint on this machine

<!-- The Services line has one fixed shape because the watch in fleet-wait parses it:
     <url> (start: <command>|operator); <url> (start: ...)
     A URL with a command is restarted by the coordinator when it goes down; `operator` means only you start it.
     A project with no app leaves out App origin, Services and Login runbook: the browser half is skipped. -->
