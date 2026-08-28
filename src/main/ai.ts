import { safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, ChatChunk, ChatRequest, ProviderId, ProviderStatus } from '../shared/types'
import { VISION_MODEL_PATTERN } from '../shared/types'
import { rootDir } from './storage'

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
  if (!key) {
    delete store[provider]
  } else if (safeStorage.isEncryptionAvailable()) {
    store[provider] = `enc:${safeStorage.encryptString(key).toString('base64')}`
  } else {
    throw new Error(
      'This machine has no OS keychain available, so FlowFrame will not store the key. Use a local Ollama model instead, or set the key as an environment variable.'
    )
  }
  await fs.mkdir(path.dirname(keysFile()), { recursive: true })
  await fs.writeFile(keysFile(), JSON.stringify(store, null, 2), { mode: 0o600 })
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

// ------------------------------------------------------------ availability

const PROBE_TIMEOUT_MS = 4000

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function probeProvider(
  provider: ProviderId,
  settings: AppSettings
): Promise<ProviderStatus> {
  const config = settings.providers[provider]
  try {
    if (provider === 'ollama') {
      const res = await fetchWithTimeout(`${config.baseUrl}/api/tags`, {}, PROBE_TIMEOUT_MS)
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`)
      const body = (await res.json()) as { models?: { name: string }[] }
      const models = (body.models ?? []).map((m) => m.name)
      const visionModels = await ollamaVisionModels(config.baseUrl, models)
      return {
        id: provider,
        reachable: true,
        models,
        visionModels,
        detail: models.length
          ? `${models.length} model${models.length === 1 ? '' : 's'} installed` +
            (visionModels.length
              ? `, ${visionModels.length} can read screenshots`
              : ', none can read screenshots — try: ollama pull llama3.2-vision')
          : 'Running, but no models pulled yet. Try: ollama pull llama3.2-vision'
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
        `${config.baseUrl}/models`,
        { headers: { Authorization: `Bearer ${key}` } },
        PROBE_TIMEOUT_MS
      )
      if (!res.ok) throw new Error(`Endpoint answered ${res.status}`)
      const body = (await res.json()) as { data?: { id: string }[] }
      const models = (body.data ?? []).map((m) => m.id).sort()
      const visionModels = models.filter((model) => VISION_MODEL_PATTERN.test(model))
      return {
        id: provider,
        reachable: true,
        models,
        visionModels,
        detail: `${models.length} models available, ${visionModels.length} read screenshots`
      }
    }

    const res = await fetchWithTimeout(
      `${config.baseUrl}/v1/models`,
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
      PROBE_TIMEOUT_MS
    )
    if (!res.ok) throw new Error(`Anthropic answered ${res.status}`)
    const body = (await res.json()) as { data?: { id: string }[] }
    const models = (body.data ?? []).map((m) => m.id)
    // Every current Claude model reads images.
    return {
      id: provider,
      reachable: true,
      models,
      visionModels: models,
      detail: `${models.length} models available, all read screenshots`
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
          ? `Not reachable at ${config.baseUrl}. Start it with: ollama serve`
          : message
    }
  }
}

/** Asks Ollama which of the installed models declare the `vision` capability. */
async function ollamaVisionModels(baseUrl: string, models: string[]): Promise<string[]> {
  const checks = await Promise.all(
    models.slice(0, 24).map(async (model) => {
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
        return body.capabilities?.includes('vision') ? model : null
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

export function cancelChat(requestId: string): void {
  inflight.get(requestId)?.abort()
  inflight.delete(requestId)
}

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

  try {
    const response = await buildRequest(request, config.baseUrl, controller.signal)
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
    }
    await consume(request, response, onChunk)
    onChunk({ requestId: request.requestId, done: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onChunk({
      requestId: request.requestId,
      error: controller.signal.aborted ? 'Stopped.' : message,
      done: true
    })
  } finally {
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

async function buildRequest(
  request: ChatRequest,
  baseUrl: string,
  signal: AbortSignal
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
      body: JSON.stringify({ model: request.model, messages, stream: true })
    })
  }

  const key = await getApiKey(request.provider)
  if (!key) throw new Error('No API key stored for this provider. Add one in Settings.')

  if (request.provider === 'openai') {
    const messages = request.messages.map((message, index) => {
      const isLastUser = index === request.messages.length - 1 && message.role === 'user'
      if (!isLastUser || !images.length) return message
      return {
        role: message.role,
        content: [
          { type: 'text', text: message.content },
          ...images.map((data) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${data}` }
          }))
        ]
      }
    })
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: request.model, messages, stream: true })
    })
  }

  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = request.messages.filter((m) => m.role !== 'system')
  const messages = rest.map((message, index) => {
    const isLastUser = index === rest.length - 1 && message.role === 'user'
    if (!isLastUser || !images.length) return { role: message.role, content: message.content }
    return {
      role: message.role,
      content: [
        ...images.map((data) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data }
        })),
        { type: 'text', text: message.content }
      ]
    }
  })
  return fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
      messages
    })
  })
}

async function consume(
  request: ChatRequest,
  response: Response,
  onChunk: (chunk: ChatChunk) => void
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      if (request.provider === 'ollama') {
        const parsed = safeParse(line)
        const delta = parsed?.message?.content
        if (delta) onChunk({ requestId: request.requestId, delta })
        continue
      }

      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      const parsed = safeParse(payload)
      if (!parsed) continue

      if (request.provider === 'openai') {
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) onChunk({ requestId: request.requestId, delta })
      } else {
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          onChunk({ requestId: request.requestId, delta: parsed.delta.text })
        }
      }
    }
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
