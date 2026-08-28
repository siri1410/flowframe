#!/usr/bin/env node
/**
 * One way to start FlowFrame, on any operating system.
 *
 * It works out where it is and what is missing, then does only what is needed:
 * checks Node, installs dependencies on a fresh clone, builds when the bundle is
 * absent or older than the source, and launches the app. Running it twice in a
 * row is fast, because the second run finds nothing left to do.
 *
 *   node scripts/start.mjs           launch the built app
 *   node scripts/start.mjs --dev     launch with hot reload instead
 *   node scripts/start.mjs --rebuild build even if the bundle looks current
 *
 * Windows, macOS and Linux each get the same behaviour; the only differences
 * this file cares about are the name of the npm executable and how a Linux
 * machine with no display has to be told to use a virtual one.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm'
const MINIMUM_NODE = 20

const args = new Set(process.argv.slice(2))
const dev = args.has('--dev') || args.has('-d')
const forceBuild = args.has('--rebuild')
const checkOnly = args.has('--check')

if (args.has('--help') || args.has('-h')) {
  process.stdout.write(
    [
      'Start FlowFrame.',
      '',
      '  node scripts/start.mjs             build if needed, then open the app',
      '  node scripts/start.mjs --dev       open with hot reload instead',
      '  node scripts/start.mjs --rebuild   build even if the bundle looks current',
      '  node scripts/start.mjs --check     report what it would do, and stop',
      '',
      'Or, from anywhere: npm start · ./start.sh (macOS, Linux) · start.cmd (Windows)',
      ''
    ].join('\n')
  )
  process.exit(0)
}

const PLATFORM_NAME =
  { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] ?? process.platform

function say(message) {
  process.stdout.write(`\x1b[36m▣\x1b[0m ${message}\n`)
}

function fail(message) {
  process.stderr.write(`\x1b[31m▣\x1b[0m ${message}\n`)
  process.exit(1)
}

/** Runs a command to completion, inheriting the terminal. */
function run(command, commandArgs, extraEnv = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
    env: { ...process.env, ...extraEnv }
  })
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed.`)
}

/** The newest mtime under a directory, or 0 when it is not there. */
function newestFile(dir, skip = new Set(['node_modules', '.git', 'out', 'dist', 'release'])) {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestFile(full, skip))
    else newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

// ------------------------------------------------------------------ checks

const nodeMajor = Number(process.versions.node.split('.')[0])
if (Number.isFinite(nodeMajor) && nodeMajor < MINIMUM_NODE) {
  fail(
    `FlowFrame needs Node ${MINIMUM_NODE} or newer; this is Node ${process.versions.node}.\n` +
      '  Install the current release from https://nodejs.org and run this again.'
  )
}

say(`FlowFrame on ${PLATFORM_NAME} · Node ${process.versions.node}`)

// A Linux box with no display cannot open a window. Say so plainly rather than
// letting Electron fail with something cryptic.
const headlessLinux =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
if (headlessLinux && !process.env.FLOWFRAME_ALLOW_HEADLESS) {
  fail(
    'No display found. FlowFrame is a desktop app and needs one.\n' +
      '  On a headless machine, run it under a virtual display:\n' +
      '    xvfb-run -a node scripts/start.mjs'
  )
}

// ------------------------------------------------------------- dependencies

if (!existsSync(path.join(ROOT, 'node_modules'))) {
  say('Installing dependencies — this only happens once.')
  run(NPM, ['install'])
}

// ------------------------------------------------------------------ launch

if (dev) {
  if (checkOnly) {
    say('Would start with hot reload.')
    process.exit(0)
  }
  say('Starting with hot reload. Press Ctrl+C to stop.')
  const child = spawn(NPM, ['run', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS })
  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
} else {
  // Rebuild when there is no bundle, or when something in src is newer than it.
  const bundle = path.join(ROOT, 'out', 'main', 'index.js')
  const stale = existsSync(bundle) && newestFile(path.join(ROOT, 'src')) > statSync(bundle).mtimeMs
  const needsBuild = forceBuild || !existsSync(bundle) || stale
  if (checkOnly) {
    say(needsBuild ? 'Would build, then open the app.' : 'Bundle is current; would open the app.')
    process.exit(0)
  }
  if (needsBuild) {
    say(existsSync(bundle) ? 'Source has changed; rebuilding.' : 'Building for the first time.')
    run(NPM, ['run', 'build'])
  }

  say('Opening FlowFrame.')
  const child = spawn(NPM, ['run', 'preview'], { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS })
  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGINT', () => child.kill('SIGINT'))
}
