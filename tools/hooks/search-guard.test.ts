import { expect, test } from 'claude-code/testing'
import { MESSAGE, check } from './search-guard.ts'

const HOME = 'C:\\Users\\dev', CWD = 'C:\\Users\\dev\\Desktop\\LiveProjects\\app'

test('a home, Desktop or drive root is refused, whatever the pattern, in every spelling', () => {
  for (const path of ['C:\\Users\\dev', 'C:\\Users\\dev\\', 'c:/users/dev', '/c/Users/dev', 'C:\\Users\\dev\\Desktop', 'C:/Users/dev/Desktop/', 'C:\\', 'C:', '/', '/mnt/c/'])
    for (const tool of ['Glob', 'Grep']) expect([path, tool, check({ tool, pattern: '*.bat', path }, CWD, HOME)]).toEqual([path, tool, MESSAGE])
  expect(check({ tool: 'Grep', pattern: 'x', path: 'C:\\Users\\dev', glob: '*.ts', type: 'ts' }, CWD, HOME)).toBe(MESSAGE)
})

test('a missing path is the working folder: refused at a root, fine in a project', () => {
  expect(check({ tool: 'Glob', pattern: '*.bat' }, 'C:\\Users\\dev\\Desktop', HOME)).toBe(MESSAGE)
  expect(check({ tool: 'Glob', pattern: '**/*.md' }, 'C:\\', HOME)).toBe(MESSAGE)
  expect(check({ tool: 'Glob', pattern: '**/*.md' }, CWD, HOME)).toBeNull()
})

test('a folder under a root is narrow: a project, .claude/projects, a sibling of Desktop', () => {
  for (const path of [CWD, 'C:\\Users\\dev\\.claude\\projects', 'C:\\Users\\dev\\Documents', 'C:\\Users\\dev\\Desktop\\notes', 'D:\\data', 'C:\\Users\\other']) {
    expect([path, check({ tool: 'Glob', pattern: '*.jsonl', path }, CWD, HOME)]).toEqual([path, null])
    expect([path, check({ tool: 'Grep', pattern: 'x', path }, CWD, HOME)]).toEqual([path, null])
  }
})

test('LiveProjects is refused for a recursive Glob and an unfiltered Grep only', () => {
  const path = 'C:\\Users\\dev\\Desktop\\LiveProjects'
  expect(check({ tool: 'Glob', pattern: '**/x.md', path }, CWD, HOME)).toBe(MESSAGE)
  expect(check({ tool: 'Grep', pattern: 'x', path }, CWD, HOME)).toBe(MESSAGE)
  expect(check({ tool: 'Glob', pattern: 'app/*.md', path }, CWD, HOME)).toBeNull()
  expect(check({ tool: 'Grep', pattern: 'x', path, glob: '*.md' }, CWD, HOME)).toBeNull()
  expect(check({ tool: 'Grep', pattern: 'x', path, type: 'ts' }, CWD, HOME)).toBeNull()
})

test('an unknown home never matches a folder by accident', () => {
  expect(check({ tool: 'Glob', pattern: '*.md', path: CWD }, CWD, '')).toBeNull()
})

test('a relative, dotted or home-spelled path is resolved against the working folder and the home before it is judged', () => {
  const at = (cwd: string, path: string, tool = 'Glob'): string | null => check({ tool, pattern: '*.md', path }, cwd, HOME)
  for (const [cwd, path] of [[HOME, '.'], [HOME, './'], [HOME, '..'], ['C:\\Users\\dev\\Desktop', '..'], [HOME, 'Desktop'], [HOME, 'Desktop\\'], [CWD, '..\\..'], [CWD, '../../..'], [CWD, '..\\..\\..\\..'],
    ['D:\\x', '~'], ['D:\\x', '~/Desktop'], ['D:\\x', '~\\Desktop\\'], ['D:\\x', '$HOME'], ['D:\\x', '${HOME}/Desktop'], ['D:\\x', '$env:USERPROFILE'], ['D:\\x', '$USERPROFILE\\Desktop'],
    ['D:\\x', '%USERPROFILE%'], ['D:\\x', '%USERPROFILE%\\Desktop'], ['D:\\x', '\\'], ['D:\\x', 'D:\\'], ['D:\\x', '..']])
    for (const tool of ['Glob', 'Grep']) expect([cwd, path, tool, at(cwd!, path!, tool)]).toEqual([cwd, path, tool, MESSAGE])
  for (const [cwd, path] of [[CWD, '.'], [CWD, 'src'], [CWD, '..'], [HOME, 'Documents'], [HOME, '.claude\\projects'], [HOME, '~/Documents'], ['D:\\x', '~/.claude/projects'], ['D:\\x', '$HOME/Desktop/notes'], [HOME, '%USERPROFILE%\\.claude']])
    expect([cwd, path, at(cwd!, path!)]).toEqual([cwd, path, null])
})

test('with no path, an absolute pattern starts where its first glob does', () => {
  const glob = (pattern: string, cwd = CWD): string | null => check({ tool: 'Glob', pattern }, cwd, HOME)
  for (const p of ['C:/Users/dev/**/*.md', 'C:\\Users\\dev\\*.bat', 'C:/Users/dev/Desktop/**/x.md', 'C:/**/*.md', '/**/*.md', '~/**/*.md', '$HOME/Desktop/*.md', '%USERPROFILE%\\**\\*.md', 'C:/Users/dev/*/package.json'])
    expect([p, glob(p)]).toEqual([p, MESSAGE])
  for (const p of ['C:/Users/dev/.claude/projects/**/*.jsonl', 'C:/Users/dev/Desktop/LiveProjects/app/**/*.ts', '~/.claude/*.json', 'C:/Users/dev/Desktop/notes/a.md', '**/*.md', 'src/**/*.ts'])
    expect([p, glob(p)]).toEqual([p, null])
  // a given path wins over the pattern
  expect(check({ tool: 'Glob', pattern: 'C:/Users/dev/**/*.md', path: CWD }, CWD, HOME)).toBeNull()
})
