#!/usr/bin/env node
// The Telegram watcher's stable entry: `inbox.mjs scheduler on` copies it to <config>/makarasty/bin/ and Task Scheduler
// starts it. It finds makarasty-tools where Claude Code loads it now, so a plugin update moves nothing the task points at.
//   node tg-watch.mjs [--config <claude config dir>]
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const at = process.argv.indexOf('--config')
if (at > 0 && process.argv[at + 1]) process.env.CLAUDE_CONFIG_DIR = process.argv[at + 1]
const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const json = (/** @type {string} */ p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) } catch { return undefined } }
const has = (/** @type {string} */ r) => existsSync(join(r, 'skills', 'inbox', 'watcher.mjs'))

// A folder marketplace loads the plugin in place; any other install runs from its cache folder. Disabled: none.
export function pluginRoot() {
  if (json(join(cfg, 'settings.json'))?.enabledPlugins?.['makarasty-tools@makarasty'] === false) return undefined
  const m = json(join(cfg, 'plugins', 'known_marketplaces.json'))?.makarasty
  if (m?.source?.source === 'directory' && m.source.path) {
    const entry = json(join(m.source.path, '.claude-plugin', 'marketplace.json'))?.plugins?.find((/** @type {any} */ p) => p.name === 'makarasty-tools')
    if (typeof entry?.source === 'string' && has(join(m.source.path, entry.source))) return join(m.source.path, entry.source)
  }
  const inst = json(join(cfg, 'plugins', 'installed_plugins.json'))
  const rows = (inst?.plugins ?? inst)?.['makarasty-tools@makarasty']
  const r = Array.isArray(rows) ? rows[0]?.installPath : undefined
  return typeof r === 'string' && has(r) ? r : undefined
}

const root = pluginRoot()
if (root) {
  const { runWatcher } = await import(pathToFileURL(join(root, 'skills', 'inbox', 'watcher.mjs')).href)
  process.exitCode = await runWatcher({ root, pluginRoot })
}
