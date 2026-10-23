import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Drives the provider layer against a stand-in server on localhost, so every
 * path a real model can take — paged model lists, an overloaded first answer,
 * a refusal, an error half way through a stream — is exercised with no key and
 * no network. The Anthropic key comes from the environment, as a user's would.
 */

const ROOT = path.resolve(__dirname, '..')

let app: ElectronApplication
let page: Page
let dataDir: string
let server: Server
let baseUrl = ''

/** What the stand-in does next on /v1/messages and /chat/completions. */
let anthropicScript: ((req: IncomingMessage, res: ServerResponse, body: any) => void)[] = []
let openaiScript: ((res: ServerResponse) => void)[] = []
const anthropicRequests: { headers: IncomingMessage['headers']; body: any }[] = []

function sse(res: ServerResponse, events: object[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
}

function text(delta: string): object {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (url.pathname === '/v1/models') {
        // Two pages, to prove the probe follows has_more.
        const second = url.searchParams.get('after_id') === 'claude-opus-5-5'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            second
              ? {
                  data: [
                    { id: 'claude-text-only', max_tokens: 8192, capabilities: { image_input: { supported: false } } }
                  ],
                  has_more: false
                }
              : {
                  data: [
                    { id: 'claude-opus-5-5', max_tokens: 128000, capabilities: { image_input: { supported: true } } }
                  ],
                  has_more: true,
                  last_id: 'claude-opus-5-5'
                }
          )
        )
        return
      }

      if (url.pathname === '/v1/messages') {
        anthropicRequests.push({ headers: req.headers, body })
        const step = anthropicScript.shift()
        if (step) step(req, res, body)
        else sse(res, [text('ok'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
        return
      }

      if (url.pathname === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'local-text' }]
          })
        )
        return
      }

      if (url.pathname === '/chat/completions') {
        const step = openaiScript.shift()
        if (step) step(res)
        else sse(res, [{ choices: [{ delta: { content: 'ok' } }] }])
        return
      }

      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-providers-'))
  app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      FLOWFRAME_DATA_DIR: dataDir,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'test-key',
      OPENAI_API_KEY: 'test-key'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 60_000 })

  // Point both cloud providers at the stand-in. The model ids are deliberately
  // ones the stand-in does not list, so the re-pick has something to do.
  await page.evaluate(async (url) => {
    const store = (window as any).__flowframe.store
    const settings = store.getState().settings
    await store.getState().saveSettings({
      ...settings,
      activeProvider: 'anthropic',
      providers: {
        ...settings.providers,
        ollama: { ...settings.providers.ollama, baseUrl: 'http://127.0.0.1:9' },
        anthropic: { ...settings.providers.anthropic, baseUrl: `${url}/`, model: 'claude-retired-model' },
        openai: { ...settings.providers.openai, baseUrl: url, model: '' }
      }
    })
  }, baseUrl)
})

test.afterAll(async () => {
  await app?.close()
  server?.close()
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
})

async function chat(question: string): Promise<{ content: string; error?: boolean }> {
  return page.evaluate(async (q) => {
    const store = (window as any).__flowframe.store
    await store.getState().sendChat(q, false)
    const started = Date.now()
    while (store.getState().chatBusy && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const chat = store.getState().project.chat
    return chat[chat.length - 1]
  }, question)
}

test('the probe reads every page of the model list and which models take images', async () => {
  const status = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    await store.getState().refreshProviders()
    return store.getState().providers.find((p: any) => p.id === 'anthropic')
  })
  expect(status.reachable).toBe(true)
  expect(status.models).toEqual(['claude-opus-5-5', 'claude-text-only'])
  expect(status.visionModels).toEqual(['claude-opus-5-5'])
})

test('a model that is no longer offered is replaced, and an empty one is filled in', async () => {
  const settings = await page.evaluate(() => (window as any).__flowframe.store.getState().settings)
  expect(settings.providers.anthropic.model).toBe('claude-opus-5-5')
  // Embeddings and speech models never reach the picker, and a model that reads images wins.
  expect(settings.providers.openai.model).toBe('gpt-5-mini')
  const openai = await page.evaluate(() =>
    (window as any).__flowframe.store.getState().providers.find((p: any) => p.id === 'openai')
  )
  expect(openai.models).toEqual(['gpt-5-mini', 'local-text'])
})

test('an overloaded first answer is retried, and the request is shaped for the current API', async () => {
  anthropicRequests.length = 0
  anthropicScript = [
    (_req, res) => {
      res.writeHead(529, { 'Content-Type': 'application/json', 'retry-after': '0' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    },
    (_req, res) =>
      sse(res, [
        { type: 'message_start' },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        text('The flow '),
        text('has a dead end.'),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      ])
  ]

  const answer = await chat('Where does the flow end?')
  expect(answer.error).toBeFalsy()
  expect(answer.content).toBe('The flow has a dead end.')

  expect(anthropicRequests).toHaveLength(2)
  const { headers, body } = anthropicRequests[1]
  expect(headers['anthropic-version']).toBe('2026-10-21')
  expect(body.model).toBe('claude-opus-5-5')
  expect(body.fallbacks).toBe('default')
  expect(body.max_tokens).toBeGreaterThan(4096)
  expect(body.messages[0].role).toBe('user')
  expect(body).not.toHaveProperty('temperature')
})

test('a refusal is shown as an error, not as an empty answer', async () => {
  anthropicScript = [
    (_req, res) =>
      sse(res, [
        { type: 'message_start' },
        { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation: 'not here' } } }
      ])
  ]
  const answer = await chat('Something the model will decline')
  expect(answer.error).toBe(true)
  expect(answer.content).toContain('declined')
})

test('an error event part way through a stream reaches the user', async () => {
  anthropicScript = [
    (_req, res) =>
      sse(res, [text('Half an '), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
  ]
  const answer = await chat('Tell me about the checkout')
  expect(answer.error).toBe(true)
  expect(answer.content).toContain('Overloaded')
})

test('a proxy that does not know the fallback field still gets an answer', async () => {
  anthropicRequests.length = 0
  anthropicScript = [
    (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fallbacks: Extra inputs are not permitted' } }))
    }
  ]
  const answer = await chat('Hello')
  expect(answer.error).toBeFalsy()
  expect(answer.content).toBe('ok')
  expect(anthropicRequests[1].body).not.toHaveProperty('fallbacks')
})

test('an output cap the model will not take is lowered and the request sent again', async () => {
  anthropicRequests.length = 0
  anthropicScript = [
    (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'max_tokens: 32000 > 8192, the maximum allowed' } }))
    }
  ]
  const answer = await chat('Hello again')
  expect(answer.error).toBeFalsy()
  expect(anthropicRequests[1].body.max_tokens).toBe(8192)
})

test('an OpenAI-shaped endpoint reports a mid-stream error and a cut-off answer', async () => {
  await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    await store.getState().saveSettings({ ...store.getState().settings, activeProvider: 'openai' })
  })

  openaiScript = [(res) => sse(res, [{ choices: [{ delta: { content: 'Par' } }] }, { error: { message: 'quota exceeded' } }])]
  const failed = await chat('First question')
  expect(failed.error).toBe(true)
  expect(failed.content).toContain('quota exceeded')

  openaiScript = [
    (res) =>
      sse(res, [
        { choices: [{ delta: { content: 'A long answer' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] }
      ])
  ]
  const cut = await chat('Second question')
  expect(cut.error).toBeFalsy()
  expect(cut.content).toContain('A long answer')
  expect(cut.content).toContain('cut short')
})
