import { expect, test } from 'claude-code/testing'
import { check, denial } from './kill-guard.ts'

const BLOCK = ['taskkill /IM node.exe', 'taskkill /F /IM node.exe', 'taskkill /f /im node.exe /t', 'taskkill //F //IM node.exe', 'taskkill.exe /IM chrome.exe',
  'taskkill /FI "IMAGENAME eq node.exe"', 'taskkill /F /FI "WINDOWTITLE eq x"', 'pkill node', 'pkill -f vite', 'killall node', 'sudo killall -9 node',
  'kill $(pgrep node)', 'kill -9 `pidof node`', 'pgrep -f vite | xargs kill', 'pgrep node | xargs kill -9',
  'cmd /c "taskkill /F /IM node.exe"', 'cmd /c taskkill /IM node.exe', 'powershell -Command "Stop-Process -Name node -Force"', 'bash -c "pkill node"',
  "pwsh -c 'Get-Process node | Stop-Process'", 'echo $(pkill node)', 'cd x && pkill node', 'npm test; taskkill /IM node.exe', 'timeout 5 pkill node',
  'bash <<EOF\npkill node\nEOF', '"taskkill" /IM node.exe',
  // Review round 2: each of these once returned null.
  'cmd //c taskkill //IM node.exe', 'cmd /k taskkill /IM node.exe', 'taskkill /F /FI "IMAGENAME eq node.exe" /T',
  'ps aux | grep vite | awk \'{print $2}\' | xargs kill', 'kill $(ps aux | grep vite | awk \'{print $2}\')', 'kill "$(pgrep -f vite)"', 'kill -9 $(pidof node)',
  'cat <<EOF | sh\npkill node\nEOF', 'bash -s <<EOF\npkill node\nEOF', 'cat <<EOF | bash -s\ntaskkill /IM node.exe\nEOF',
  'pgrep node | xargs -r kill', 'pgrep -f vite | xargs -r kill -9', 'ps aux | grep vite | awk \'{print $2}\' | xargs -r kill -9', 'pgrep node | xargs -t kill',
  'xargs -r kill < <(pgrep node)', 'pgrep node | xargs -n 1 kill', 'pgrep node | xargs -I {} kill {}',
  'echo "a <<b"\npkill node', 'echo $((1<<2))\ntaskkill /IM node.exe', 'x=$((1<<3))\nkillall node', "echo 'a <<b'\npkill node", 'cat <<EOF\nno end\npkill node',
  'sudo -u root pkill node', 'timeout -s KILL 5 pkill node', 'timeout 5 taskkill /IM node.exe', 'env -u X pkill node', 'nice -n 5 killall node', 'FOO=1 sudo pkill node']
const BLOCK_PS2 = ['Stop-Process -Id (Get-Process node).Id -Force', 'Stop-Process -Id $(Get-Process node).Id', 'Stop-Process -Id (gps node).Id',
  'Get-Process node | ForEach-Object { Stop-Process -Id $_.Id }', 'Get-Process node | % { Stop-Process -Id $_.Id -Force }', 'gps node | foreach { spps $_.Id }',
  'Get-Process node | ForEach-Object { $_.Id } | Stop-Process', 'ps node | Stop-Process', 'taskkill /F /FI "IMAGENAME eq node.exe"', 'sudo -u x Stop-Process -Name node']
const BLOCK_PS = ['Stop-Process -Name node', 'Stop-Process -Name node -Force', 'Stop-Process -name:node', 'Stop-Process -N node', 'spps -Name node', 'kill -Name node',
  'Get-Process node | Stop-Process', 'Get-Process node | Stop-Process -Force', 'gps node | spps', 'Get-Process | Where-Object { $_.Name -like "node*" } | Stop-Process -Force',
  'Get-Process -Name node | Stop-Process', 'Get-Process node,chrome | Stop-Process', 'if ($x) { Stop-Process -Name node }', 'taskkill /IM node.exe', 'pkill node']
const TREE_BLOCK = ['taskkill /PID 4242 /T', 'taskkill /F /T /PID 4242', 'taskkill /pid 4242 /t /f', 'taskkill /PID 4242 /t', 'taskkill -T -PID 4242', 'taskkill //F //PID 4242 //T',
  'taskkill /FI "PID eq 4242" /T', 'cmd /c "taskkill /PID 4242 /T /F"', 'cmd //c taskkill //PID 4242 //T']
const ALLOW = ['taskkill /PID 4242', 'taskkill /PID 4242 /F', 'taskkill //F //PID 4242', 'taskkill /?', 'kill 4242', 'kill -9 4242',
  'kill -TERM 4242 4243', 'kill %1', 'kill -l', 'pgrep node', 'pgrep -f vite | head', 'ps aux | grep node', 'echo pkill node', 'echo "taskkill /IM node.exe"',
  "git commit -m 'stop using taskkill /IM'", 'git commit -F - <<EOF\ntaskkill /IM node.exe\nEOF', 'grep -rn pkill src', 'cat killall.txt', 'npm run kill-port', 'killport 3000',
  'cmd /c "taskkill /PID 4242 /F"', 'powershell -Command "Stop-Process -Id 4242 -Force"', 'bash -c "kill 4242"', 'cd x && kill 4242', 'netstat -ano | grep 3000',
  'taskkill /FI "PID eq 4242"', 'taskkill /F /FI "PID eq 4242"', 'taskkill /PID 4242 /FI "STATUS eq RUNNING"', 'cmd //c taskkill //PID 4242 //F', 'sudo -u root kill 4242',
  'timeout -s KILL 5 kill 4242', 'netstat -ano | grep :3000 | awk \'{print $5}\' | xargs kill', 'kill $(lsof -t -i:3000)', 'cat <<EOF | tee out.txt\npkill node\nEOF',
  'bash -s <<EOF\nkill 4242\nEOF',
  'echo "it\'s" && git commit -F - <<EOF\npkill node is the old way\nEOF', 'git commit -m "don\'t" && cat <<EOF > n.md\ntaskkill /IM node.exe was bad\nEOF',
  "echo 'say \"hi\"' && cat <<EOF > n.md\npkill node\nEOF"]
const ALLOW_PS = ['Stop-Process -Id 4242', 'Stop-Process -Id 4242 -Force', 'Stop-Process -Id:4242', 'Stop-Process 4242', 'Stop-Process -Id 4242, 4243', 'spps -Id 4242', 'kill 4242',
  'Get-Process -Id 4242 | Stop-Process', 'Get-Process -Id 4242 | Stop-Process -Force', '(Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process',
  'Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | Stop-Process -Id $_', 'Stop-Process -Id $pid', 'foreach ($p in $ids) { Stop-Process -Id $p }',
  'Get-Process node', 'Get-Process node | Select-Object Id,CommandLine', 'taskkill /PID 4242 /F', 'taskkill /F /PID 4242',
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select ProcessId,CommandLine', 'Write-Output "Stop-Process -Name node"',
  'Get-Process node | Where-Object { $_.Id -eq 4242 } | Stop-Process', 'Get-Process | ? { $_.Id -eq 4242 } | ForEach-Object { Stop-Process -Id $_.Id }',
  'Get-Process -Id 4242 | ForEach-Object { Stop-Process -Id $_.Id }', 'Stop-Process -Id (Get-Process -Id 4242).Id', 'taskkill /FI "PID eq 4242"',
  'Get-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess }']

test('kill by name is refused, in Bash and PowerShell, direct or through a nested shell', () => {
  expect(BLOCK.filter((c) => !check(c))).toEqual([])
  expect(BLOCK_PS.filter((c) => !check(c, 'PowerShell'))).toEqual([])
  expect(BLOCK_PS2.filter((c) => !check(c, 'PowerShell'))).toEqual([])
})

test('taskkill /T (tree kill) is refused even with a PID, in any case and dash form', () => {
  expect(TREE_BLOCK.filter((c) => !check(c))).toEqual([])
  expect(check('taskkill /PID 4242 /T', 'PowerShell')).toContain('whole child tree')
  expect(denial('taskkill /PID 4242 /T /F', false)).toContain('taskkill /PID n /F')
  expect(denial('taskkill /PID 4242 /T /F', true)).toBeNull()
})

test('a long hostile line is read in linear time', () => {
  const t = Date.now()
  for (const c of ['<<a '.repeat(50000), '<<a\n'.repeat(20000), '$('.repeat(20000), '`a'.repeat(20000), '{ '.repeat(30000), '| '.repeat(30000)]) check(c)
  expect(Date.now() - t).toBeLessThan(2000)
})

test('kill by PID is allowed, and so is text that only mentions a kill command', () => {
  expect(ALLOW.filter((c) => check(c))).toEqual([])
  expect(ALLOW_PS.filter((c) => check(c, 'PowerShell'))).toEqual([])
})

test('the refusal says how to kill by PID, and the switch turns the guard off', () => {
  const m = denial('taskkill /F /IM node.exe', false)!
  expect(m).toContain('taskkill /PID <n> /F')
  expect(m).toContain('Stop-Process -Id <n>')
  expect(m).toContain('MAKARASTY_KILL_GUARD=off')
  expect(denial('taskkill /F /IM node.exe', true)).toBeNull()
  expect(denial('git status', false)).toBeNull()
  expect(denial('taskkill /PID 4242 /F', false)).toBeNull()
})
