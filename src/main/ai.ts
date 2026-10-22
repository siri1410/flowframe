import { safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, ChatChunk, ChatRequest, ProviderId, ProviderStatus } from '../shared/types'
import { NON_CHAT_MODEL_PATTERN, VISION_MODEL_PATTERN } from '../shared/types'
import { rootDir, writeAtomic } from './storage'

/**
 * All model traffic goes through the main process on purpose. The renderer never
 * sees an API key, and calling Ollama from the main process sidesteps the CORS
 * wall a packaged renderer origin would otherwise hit on localhost:11434.
 */

function keysFile(): string {
  return path.join(rootDir(), 'keys.json')
}

type KeyStore = Partial<Record<ProviderId, string>>

async function readKeyStore(): Promise<KeyStore> {
  try {
    return JSON.parse(await fs.readFile(keysFile(), 'utf8')) as KeyStore
  } catch {
    return {}
  }
}

/** Keys are encrypted with the OS keychain when it is available, never written in the clear. */
export async function setApiKey(provider: ProviderId, key: string): Promise<void> {
  const store = await readKeyStore()
  const trimmed = key.trim()
  if (!trimmed) {
    delete store[provider]
  } else if (safeStorage.isEncryptionAvailable()) {
    store[provider] = `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
  } else {
    throw new Error(
      'This machine has no OS keychain available, so FlowFrame will not store the key. Use a local Ollama model instead, or set the key as an environment variable.'
    )
  }
  await writeAtomic(keysFile(), JSON.stringify(store, null, 2), 0o600)
}

export async function getApiKey(provider: ProviderId): Promise<string> {
  const envKey =
    provider === 'openai'
      ? process.env.OPENAI_API_KEY
      : provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : undefined
  if (envKey) return envKey

  const stored = (await readKeyStore())[provider]
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  return ''
}

export async function hasApiKey(provider: ProviderId): Promise<boolean> {
  return (await getApiKey(provider)).length > 0
}

/** Users paste base URLs with a trailing slash often enough that it is worth forgiving. */
function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// ------------------------------------------------------------ availability

const PROBE_TIMEOUT_MS = 6000

/**
 * The Anthropic API version every request is sent with. 2026-10-21 rejects
 * sampling parameters and a few document shapes; FlowFrame sends neither.
 */
const ANTHROPIC_VERSION = '2026-10-21'

/** Output caps the Anthropic models list reports, so a request never asks for more than a model allows. */
const anthropicOutputCaps = new Map<string, number>()

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
}

export async function probeProvider(
  provider: ProviderId,
  settings: AppSettings
): Promise<ProviderStatus> {
  const config = settings.providers[provider]
  const baseUrl = trimBase(config.baseUrl)
  try {
    if (provider === 'ollama') {
      const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, PROBE_TIMEOUT_MS)
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`)
      const body = (await res.json()) as { models?: { name: string }[] }
      const models = (body.models ?? []).map((m) => m.name)
      const visionModels = await ollamaVisionModels(baseUrl, models)
      return {
        id: provider,
        reachable: true,
        models,
        visionModels,
        detail: models.length
          ? `${models.length} model${models.length === 1 ? '' : 's'} installed` +
            (visionModels.length
              ? `, ${visionModels.length} can read screenshots`
              : ', none can read screenshots — try: ollama pull gemma4')
          : 'Running, but no models pulled yet. Try: ollama pull gemma4'
      }
    }

    const key = await getApiKey(provider)
    if (!key) {
      return {
        id: provider,
        reachable: false,
        models: [],
        visionModels: [],
        detail: 'Add an API key to use this provider.'
      }
    }

    if (provider === 'openai') {
      const res = await fetchWithTimeout(
        `${baseUrl}/models`,
        { headers: { Authorization: `Bearer ${key}` } },
        PROBE_TIMEOUT_MS
      )
      if (!res.ok) throw new Error(`Endpoint answered ${res.status}${await errorDetail(res)}`)
      const body = (await res.json()) as {
        data?: { id: string; architecture?: { input_modalities?: string[] } }[]
      }
      const entries = (body.data ?? []).filter((m) => m?.id && !NON_CHAT_MODEL_PATTERN.test(m.id))
      const models = entries.map((m) => m.id).sort()
      // OpenRouter says outright which models take images; everyone else is
      // judged by the model's name.
      const visionModels = entries
        .filter((m) =>
          m.architecture?.input_modalities
            ? m.architecture.input_modalities.includes('image')
            : VISION_MODEL_PATTERN.test(m.id)
        )
        .map((m) => m.id)
        .sort()
      return {
        id: provider,
        reachable: true,
        models,
        visionModels,
        detail: `${models.length} chat models available, ${visionModels.length} read screenshots`
      }
    }

    const { models, visionModels } = await anthropicModels(baseUrl, key)
    return {
      id: provider,
      reachable: true,
      models,
      visionModels,
      detail: `${models.length} models available, ${visionModels.length} read screenshots`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      id: provider,
      reachable: false,
      models: [],
      visionModels: [],
      detail:
        provider === 'ollama'
          ? `Not reachable at ${baseUrl}. Start it with: ollama serve`
          : message
    }
  }
}

/** Every page of the Anthropic models list, with each model's image support and output cap. */
async function anthropicModels(
  baseUrl: string,
  key: string
): Promise<{ models: string[]; visionModels: string[] }> {
  const models: string[] = []
  const visionModels: string[] = []
  let after = ''
  // A handful of pages at most; the guard only stops a misbehaving proxy looping forever.
  for (let page = 0; page < 10; page += 1) {
    const url = `${baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
    const res = await fetchWithTimeout(
      url,
      { headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } },
      PROBE_TIMEOUT_MS
    )
    if (!res.ok) throw new Error(`Anthropic answered ${res.status}${await errorDetail(res)}`)
    const body = (await res.json()) as {
      data?: {
        id: string
        max_tokens?: number
        capabilities?: { image_input?: { supported?: boolean } }
      }[]
      has_more?: boolean
      last_id?: string
    }
    for (const model of body.data ?? []) {
      if (!model?.id) continue
      models.push(model.id)
      if (model.max_tokens) anthropicOutputCaps.set(model.id, model.max_tokens)
      // Every Claude model reads images; trust the list when it says otherwise.
      if (model.capabilities?.image_input?.supported !== false) visionModels.push(model.id)
    }
    if (!body.has_more || !body.last_id) break
    after = body.last_id
  }
  return { models, visionModels }
}

/** Asks Ollama which of the installed models declare the `vision` capability. */
async function ollamaVisionModels(baseUrl: string, models: string[]): Promise<string[]> {
  const checks = await Promise.all(
    models.slice(0, 48).map(async (model) => {
      try {
        const res = await fetchWithTimeout(
          `${baseUrl}/api/show`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
          },
          PROBE_TIMEOUT_MS
        )
        if (!res.ok) throw new Error('show failed')
        const body = (await res.json()) as { capabilities?: string[] }
        if (!body.capabilities) throw new Error('no capabilities')
        return body.capabilities.includes('vision') ? model : null
      } catch {
        // Older Ollama builds have no /api/show capabilities. Fall back to the name.
        return VISION_MODEL_PATTERN.test(model) ? model : null
      }
    })
  )
  return checks.filter((model): model is string => Boolean(model))
}

export async function probeAll(settings: AppSettings): Promise<ProviderStatus[]> {
  return Promise.all(
    (['ollama', 'openai', 'anthropic'] as ProviderId[]).map((id) => probeProvider(id, settings))
  )
}

// ------------------------------------------------------------------- chat

const inflight = new Map<string, AbortController>()

/**
 * How long a stream may go without a single byte before it is called dead.
 * Generous on purpose: a local model can spend a minute loading into memory,
 * and a reasoning model can think for a long while before its first word.
 */
const IDLE_TIMEOUT_MS = 300_000

/** Statuses worth one more try: rate limits, overload and a gateway having a bad moment. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529])
const MAX_RETRIES = 2

/** The Claude models that accept `fallbacks: "default"` on a refusal. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

export function cancelChat(requestId: string): void {
  inflight.get(requestId)?.abort()
  inflight.delete(requestId)
}

/** A request the model answered, but not with the answer: a refusal or a stream-level error. */
class StreamError extends Error {}

/**
 * Streams a completion, calling `onChunk` for each delta. Every provider is
 * normalised to the same {delta} / {done} / {error} shape.
 */
export async function streamChat(
  request: ChatRequest,
  settings: AppSettings,
  onChunk: (chunk: ChatChunk) => void
): Promise<void> {
  const controller = new AbortController()
  inflight.set(request.requestId, controller)
  const config = settings.providers[request.provider]
  let idle: NodeJS.Timeout | undefined
  let idleFired = false
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      idleFired = true
      controller.abort()
    }, IDLE_TIMEOUT_MS)
  }

  try {
    if (!request.model) throw new Error('No model is chosen for this provider. Pick one in Settings.')
    touch()
    const response = await sendWithRetry(request, trimBase(config.baseUrl), controller.signal)
    touch()
    await consume(request, response, onChunk, touch)
    onChunk({ requestId: request.requestId, done: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onChunk({
      requestId: request.requestId,
      error: idleFired
        ? `The model stopped answering for ${IDLE_TIMEOUT_MS / 60_000} minutes, so the request was dropped.`
        : controller.signal.aborted
          ? 'Stopped.'
          : message,
      done: true
    })
  } finally {
    clearTimeout(idle)
    inflight.delete(request.requestId)
  }
}

/**
 * The whole answer as one string, for callers that are not a conversation.
 *
 * The naming pass needs a model's answer without it appearing in the user's
 * chat transcript, and it needs the complete text before it can be parsed as
 * JSON. It is the same request path as the chat — only the delivery differs.
 */
export async function completeChat(
  request: ChatRequest,
  settings: AppSettings
): Promise<{ text: string; error?: string }> {
  let text = ''
  let error: string | undefined
  await streamChat(request, settings, (chunk) => {
    if (chunk.delta) text += chunk.delta
    if (chunk.error) error = chunk.error
  })
  return { text, error }
}

/**
 * Sends the request, retrying the failures that are worth retrying. Only the
 * opening of the stream is retried: once text has reached the user, a retry
 * would print the answer twice.
 */
async function sendWithRetry(
  request: ChatRequest,
  baseUrl: string,
  signal: AbortSignal
): Promise<Response> {
  let useFallbacks = true
  let outputCap: number | undefined
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      response = await buildRequest(request, baseUrl, signal, useFallbacks, outputCap)
    } catch (error) {
      // A dropped connection before any answer is as retryable as a 503. fetch
      // reports those as a TypeError; anything else (no key) will not get better.
      if (!(error instanceof TypeError) || signal.aborted || attempt >= MAX_RETRIES) throw error
      await wait(backoff(attempt, null), signal)
      continue
    }
    if (response.ok && response.body) return response

    const detail = await errorDetail(response)
    // A proxy or an older gateway may not know the refusal-fallback field. It
    // is a nicety, so drop it and ask again rather than fail the request.
    if (response.status === 400 && useFallbacks && /fallback/i.test(detail)) {
      useFallbacks = false
      continue
    }
    // Before the models list has been read, an older model's output cap is a
    // guess. If the guess is too high, ask again with one every model allows.
    if (response.status === 400 && outputCap === undefined && /max_tokens/i.test(detail)) {
      outputCap = 8192
      continue
    }
    if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
      await wait(backoff(attempt, response.headers.get('retry-after')), signal)
      continue
    }
    throw new Error(`${response.status} ${response.statusText}${detail}`)
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const told = retryAfter ? Number(retryAfter) * 1000 : NaN
  if (Number.isFinite(told) && told >= 0) return Math.min(told, 30_000)
  return 1000 * 2 ** attempt + Math.random() * 400
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Stopped.'))
      },
      { once: true }
    )
  })
}

/** The useful part of an error body, kept short enough to show in a toast. */
async function errorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '')
  if (!raw) return ''
  const parsed = safeParse(raw)
  const message =
    parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : null) ?? parsed?.message
  return ` — ${String(message ?? raw).slice(0, 400)}`
}

/** Images are sent as they are stored, so name their real type rather than assume PNG. */
function mediaType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  return 'image/png'
}

async function buildRequest(
  request: ChatRequest,
  baseUrl: string,
  signal: AbortSignal,
  useFallbacks: boolean,
  outputCap?: number
): Promise<Response> {
  const images = request.images ?? []

  if (request.provider === 'ollama') {
    const messages = request.messages.map((message, index) => {
      const isLastUser = index === request.messages.length - 1 && message.role === 'user'
      return isLastUser && images.length ? { ...message, images } : message
    })
    return fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages,
        stream: true,
        ...(request.json ? { format: 'json' } : {})
      })
    })
  }

  const key = await getApiKey(request.provider)
  if (!key) throw new Error('No API key stored for this provider. Add one in Settings.')

  if (request.provider === 'openai') {
    const messages = request.messages.map((message, index) => {
      const isLastUser = index === request.messages.length - 1 && message.role === 'user'
      if (!isLastUser || !images.length) return { role: message.role, content: message.content }
      return {
        role: message.role,
        content: [
          { type: 'text', text: message.content },
          ...images.map((data) => ({
            type: 'image_url',
            image_url: { url: `data:${mediaType(data)};base64,${data}` }
          }))
        ]
      }
    })
    // No token cap is sent: reasoning models reject `max_tokens`, and many
    // OpenAI-shaped servers do not know `max_completion_tokens`.
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: request.model, messages, stream: true })
    })
  }

  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = request.messages.filter((m) => m.role !== 'system' && m.content)
  // The conversation has to open with the user. A trimmed history can start on
  // an answer, which the API refuses outright.
  while (rest.length && rest[0].role !== 'user') rest.shift()
  const messages = rest.map((message, index) => {
    const isLastUser = index === rest.length - 1 && message.role === 'user'
    if (!isLastUser || !images.length) return { role: message.role, content: message.content }
    return {
      role: message.role,
      content: [
        ...images.map((data) => ({
          type: 'image',
          source: { type: 'base64', media_type: mediaType(data), data }
        })),
        { type: 'text', text: message.content }
      ]
    }
  })
  const fallbacks = useFallbacks && FALLBACK_MODELS.has(request.model)
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(fallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {})
    },
    body: JSON.stringify({
      model: request.model,
      // Streaming, so a generous cap costs nothing unless it is used — and a
      // naming pass over many screens must not be cut off half way through its JSON.
      max_tokens: outputCap ?? Math.min(anthropicOutputCaps.get(request.model) ?? 32_000, 32_000),
      stream: true,
      ...(fallbacks ? { fallbacks: 'default' } : {}),
      ...(system ? { system } : {}),
      messages
    })
  })
}

async function consume(
  request: ChatRequest,
  response: Response,
  onChunk: (chunk: ChatChunk) => void,
  touch: () => void
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let truncated = false

  const handle = (rawLine: string): void => {
    const line = rawLine.trim()
    if (!line) return

    if (request.provider === 'ollama') {
      const parsed = safeParse(line)
      if (parsed?.error) throw new StreamError(String(parsed.error))
      const delta = parsed?.message?.content
      if (delta) onChunk({ requestId: request.requestId, delta })
      if (parsed?.done_reason === 'length') truncated = true
      return
    }

    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    const parsed = safeParse(payload)
    if (!parsed) return

    if (request.provider === 'openai') {
      if (parsed.error) throw new StreamError(String(parsed.error.message ?? parsed.error))
      const choice = parsed.choices?.[0]
      const delta = choice?.delta?.content
      if (delta) onChunk({ requestId: request.requestId, delta })
      if (choice?.finish_reason === 'length') truncated = true
      if (choice?.finish_reason === 'content_filter') {
        throw new StreamError('The provider filtered this answer.')
      }
      return
    }

    if (parsed.type === 'error') {
      throw new StreamError(`Anthropic: ${parsed.error?.message ?? 'the stream failed'}`)
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      onChunk({ requestId: request.requestId, delta: parsed.delta.text })
    }
    if (parsed.type === 'message_delta') {
      const reason = parsed.delta?.stop_reason
      if (reason === 'max_tokens') truncated = true
      if (reason === 'refusal') {
        const explanation = parsed.delta?.stop_details?.explanation
        throw new StreamError(
          `The model declined to answer this one${explanation ? `: ${explanation}` : '.'}`
        )
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    touch()
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  }
  // A server that does not end its last event with a newline still meant it.
  buffer += decoder.decode()
  if (buffer.trim()) handle(buffer)

  if (truncated) {
    onChunk({ requestId: request.requestId, delta: '\n\n[The answer hit the model’s length limit and was cut short.]' })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
