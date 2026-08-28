import { app } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { OcrWord } from '../shared/types'

/**
 * Owns the text-capture child process. See src/main/ocr-worker.ts for why the
 * work happens in a forked Node process rather than here.
 *
 * The language data ships with the app, so this works with no network at all.
 */

export interface OcrResult {
  text: string
  words: OcrWord[]
  confidence: number
}

const START_TIMEOUT_MS = 20_000
const RECOGNISE_TIMEOUT_MS = 60_000

let child: ChildProcess | null = null
let nextId = 1
const pending = new Map<
  number,
  { resolve: (result: OcrResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()

function langPath(): string {
  // Packaged builds keep the traineddata beside the app. Unpackaged, resolve it
  // from this file's own location — app.getAppPath() points at out/main when the
  // bundle is launched directly, which is how the tests run it.
  if (app.isPackaged) return path.join(process.resourcesPath, 'ocr')

  const fromBuild = path.join(__dirname, '..', '..', 'resources', 'ocr')
  if (existsSync(path.join(fromBuild, 'eng.traineddata'))) return fromBuild
  return path.join(app.getAppPath(), 'resources', 'ocr')
}

function workerPath(): string {
  return path.join(__dirname, 'ocr-worker.js')
}

function failAll(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
}

function ensureChild(): ChildProcess {
  if (child && child.connected) return child

  const forked = fork(workerPath(), [], {
    // ELECTRON_RUN_AS_NODE gives the child a plain Node runtime, which is where
    // Tesseract's WebAssembly core actually runs at full speed.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execPath: process.execPath,
    // Electron's own execArgv is not valid for a Node child.
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })

  let stderr = ''
  forked.stderr?.on('data', (chunk: Buffer) => {
    // Keep the head: the message that matters is on the first lines.
    if (stderr.length < 4000) stderr += chunk.toString()
  })

  forked.on(
    'message',
    (message: { id: number; ok: boolean; result?: OcrResult; error?: string }) => {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok && message.result) entry.resolve(message.result)
      else if (message.ok) entry.resolve({ text: '', words: [], confidence: 0 })
      else entry.reject(new Error(message.error ?? 'Text capture failed.'))
    }
  )

  forked.on('exit', (code) => {
    child = null
    const detail = stderr
      .replace(/\u001b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('at '))
      .slice(0, 3)
      .join(' ')
    failAll(
      detail
        ? `The text reader stopped (exit ${code}): ${detail}`
        : `The text reader stopped unexpectedly (exit ${code}).`
    )
  })

  forked.on('error', (error) => {
    child = null
    failAll(error.message)
  })

  child = forked
  return forked
}

/**
 * Reads a preprocessed PNG. The renderer inverts dark screens and upscales
 * before sending, and divides the boxes that come back by the same factor.
 */
export function recognize(base64: string): Promise<OcrResult> {
  const worker = ensureChild()
  const id = nextId++

  return new Promise<OcrResult>((resolve, reject) => {
    // A first call also pays for the engine starting up.
    const budget = pending.size === 0 ? RECOGNISE_TIMEOUT_MS + START_TIMEOUT_MS : RECOGNISE_TIMEOUT_MS
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Text capture timed out.'))
    }, budget)

    pending.set(id, { resolve, reject, timer })
    worker.send({ id, base64, langPath: langPath() })
  })
}

/** Called once a generation run finishes, so an idle app holds no reader. */
export async function shutdown(): Promise<void> {
  const current = child
  child = null
  failAll('Text capture was stopped.')
  if (!current) return
  try {
    current.kill()
  } catch {
    // Already gone.
  }
}

app.on('will-quit', () => {
  void shutdown()
})
