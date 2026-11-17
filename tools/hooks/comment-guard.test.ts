import { expect, test } from 'claude-code/testing'
import { added, shellAdds } from './comment-guard.ts'

test('a new shortcut or ponytail comment in any common comment style is caught', () => {
  for (const l of ['// shortcut: only ISO, add more later', '  # shortcut: no retry', '/* shortcut: x */', ' * shortcut: y', '-- shortcut: sql', '<!-- shortcut: html -->', "' shortcut: vba", '// ponytail: old form', '//Shortcut: caps', 'const x = 1 // shortcut: trailing', 'x = 1  # shortcut: py']) {
    expect([l, added(`const a = 1\n${l}\n`)]).toEqual([l, [l]])
  }
})

test('kept lines, prose and code that only mention the word pass', () => {
  expect(added('// shortcut: old\nconst b = 2', '// shortcut: old\nconst a = 1')).toEqual([])
  for (const t of ['A `shortcut:` comment is banned.', 'const shortcut = { key: "shortcut:" }', 'grep -n "shortcut:" src', '- no shortcut: comments', 'keyboard shortcut: Ctrl+K']) {
    expect([t, added(t)]).toEqual([t, []])
  }
})

test('a shell line counts only when it writes a file with such a comment', () => {
  expect(shellAdds("cat > a.js <<'EOF'\n// shortcut: x\nEOF")).toBe(true)
  expect(shellAdds('Set-Content a.ps1 "# shortcut: x`n"\n# shortcut: x')).toBe(true)
  expect(shellAdds("sed -i 's/a/b/' a.js\n// shortcut: x")).toBe(true)
  expect(shellAdds('grep -rn "// shortcut:" .')).toBe(false)
  expect(shellAdds("node -e 'console.log(1)'\n// shortcut: not written anywhere")).toBe(false)
})
