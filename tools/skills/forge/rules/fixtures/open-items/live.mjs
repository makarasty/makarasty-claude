// Stands in for the one shared browser: a live check of the running app, one at a time.
import { existsSync, writeFileSync, rmSync } from 'node:fs'
if (existsSync('browser.lock')) { console.log('browser busy: another check holds it'); process.exit(1) }
writeFileSync('browser.lock', String(process.pid))
setTimeout(() => { rmSync('browser.lock'); console.log(process.argv[2] === 'phi' ? 'org 107: "Patient details (PHI)" is off in Settings > Privacy; page shows no PHI' : 'nothing to check'); }, 20000)
