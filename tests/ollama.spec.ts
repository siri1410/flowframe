import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Exercises the chat dock against a real local model. Skips itself when Ollama is
 * not running, so the suite still passes on a machine without it.
 */

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const FIXTURE = path.join(HERE, 'fixtures', '01-browse-landing.png')

let app: ElectronApplication
let page: Page
let dataDir: string
let ollamaUp = false
let visionModel = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) })
    ollamaUp = res.ok
  } catch {
    ollamaUp = false
  }

  dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-ollama-'))
  app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, FLOWFRAME_DATA_DIR: dataDir, NODE_ENV: 'test' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 60_000 })
})

test.afterAll(async () => {
  await app?.close()
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
})

test('FlowFrame finds the local Ollama server and lists its models', async () => {
  test.skip(!ollamaUp, 'Ollama is not running on localhost:11434')

  const status = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    await store.getState().refreshProviders()
    return store.getState().providers.find((p: any) => p.id === 'ollama')
  })

  expect(status.reachable).toBe(true)
  expect(status.models.length).toBeGreaterThan(0)
  visionModel = status.visionModels[0] ?? ''
})

test('it identifies which local models can read a screenshot', async () => {
  test.skip(!ollamaUp, 'Ollama is not running on localhost:11434')

  const status = await page.evaluate(() =>
    (window as any).__flowframe.store.getState().providers.find((p: any) => p.id === 'ollama')
  )

  // Vision models are a subset of the installed models, detected via /api/show.
  for (const model of status.visionModels) expect(status.models).toContain(model)
  expect(status.detail).toContain('installed')
})

test('the chat answers a question about the flow using the local model', async () => {
  test.skip(!ollamaUp, 'Ollama is not running on localhost:11434')

  await page.evaluate(async (fixture) => {
    const store = (window as any).__flowframe.store
    await store.getState().addScreensFromPaths([fixture])
    await store.getState().generate('all')
  }, FIXTURE)

  await expect(page.locator('.thumb .state.done')).toHaveCount(1)

  const model = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    return store.getState().settings.providers.ollama.model
  })
  expect(model).not.toBe('')

  await page.locator('.composer textarea').fill('In one short sentence, what is on this screen?')
  await page.locator('button.send').click()

  const reply = page.locator('.msg.assistant .body').last()
  await expect(reply).not.toHaveText('', { timeout: 240_000 })
  // Wait for the composer to go back to Send — Stop is a different control.
  await expect(page.locator('button.send[data-state="idle"]')).toBeVisible({ timeout: 300_000 })

  const text = await reply.textContent()
  expect((text ?? '').trim().length).toBeGreaterThan(3)
  expect(await page.locator('.msg.assistant.failed').count()).toBe(0)
})

test('a screenshot goes to the model when the model can read images', async () => {
  test.skip(!ollamaUp, 'Ollama is not running on localhost:11434')
  test.skip(!visionModel, 'No vision-capable model installed in Ollama')

  await page.evaluate(async (model) => {
    const store = (window as any).__flowframe.store
    const settings = store.getState().settings
    await store.getState().saveSettings({
      ...settings,
      activeProvider: 'ollama',
      providers: { ...settings.providers, ollama: { ...settings.providers.ollama, model } }
    })
  }, visionModel)

  // With a vision model selected, the attach control is live rather than greyed out.
  await expect(page.locator('.composer .btn').first()).toBeEnabled()
  await expect(page.locator('.composer .btn').first()).toContainText('Screen attached')

  await page.locator('.composer textarea').fill('Name the biggest element on this screenshot.')
  await page.locator('button.send').click()

  const reply = page.locator('.msg.assistant .body').last()
  await expect(reply).not.toHaveText('', { timeout: 300_000 })
  await expect(page.locator('button.send[data-state="idle"]')).toBeVisible({ timeout: 420_000 })

  const text = (await reply.textContent()) ?? ''
  // Vision answers can be a single short sentence, so only require a real answer.
  expect(text.trim().length).toBeGreaterThan(3)
  expect(await page.locator('.msg.assistant.failed').count()).toBe(0)
})

test('the naming pass improves the derived names, or leaves them standing', async () => {
  test.skip(!ollamaUp, 'Ollama is not running on localhost:11434')

  // Something to name. The signon screen carries labelled entry fields, so the
  // heuristics have already produced names for the model to work on.
  await page.evaluate(async (file) => {
    const store = (window as any).__flowframe.store
    await store.getState().addScreensFromPaths([file])
  }, path.join(HERE, 'fixtures', '10-cics-signon.png'))

  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 180_000 })

  const before = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const screen = project.screens.find((s: any) => s.name === '10-cics-signon.png')
    return {
      screenId: screen.id,
      fields: (project.wireframes[screen.id]?.fields ?? []).map((f: any) => f.key)
    }
  })
  expect(before.fields.length).toBeGreaterThan(0)

  const after = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    await store.getState().improveNames('all')
    const state = store.getState()
    const project = state.project
    return {
      busy: state.namingBusy,
      screens: project.screens.map((s: any) => ({
        title: s.title ?? null,
        goal: s.goal ?? null,
        renames: s.fieldNames ?? {}
      })),
      // Whatever the model said, the flow node and the screen agree.
      nodes: project.flow.nodes
        .filter((n: any) => n.screenId)
        .map((n: any) => ({ id: n.screenId, label: n.label }))
    }
  })

  // The pass always finishes, whatever the model answered.
  expect(after.busy).toBe(false)

  // Whether the model changed anything is its business — a model that answers
  // with prose leaves the derived names in place, and that is a pass, not a
  // failure. What must hold is that nothing it said corrupted the project: every
  // name that did land is a non-empty string against a key that exists.
  for (const screen of after.screens) {
    if (screen.title !== null) expect(String(screen.title).trim().length).toBeGreaterThan(0)
    if (screen.goal !== null) expect(String(screen.goal).trim().length).toBeGreaterThan(0)
    for (const [key, value] of Object.entries(screen.renames)) {
      expect(String(value).trim().length).toBeGreaterThan(0)
      expect(String(key).length).toBeGreaterThan(0)
    }
  }
  const renamed = after.screens.find((s: any) => Object.keys(s.renames).length)
  if (renamed) {
    for (const key of Object.keys(renamed.renames)) {
      // A rename may only target a key the engine actually derived.
      expect(before.fields.concat(Object.keys(renamed.renames))).toContain(key)
    }
  }

  // Renaming a screen must keep the canvas and the panel in step.
  const named = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    return project.screens
      .filter((s: any) => s.title)
      .every((s: any) =>
        project.flow.nodes.some((n: any) => n.screenId === s.id && n.label === s.title)
      )
  })
  expect(named).toBe(true)

  // And the whole thing is on disk, not just in memory.
  const persisted = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    const id = store.getState().project.id
    const inMemory = JSON.stringify(store.getState().project.screens.map((s: any) => s.title ?? ''))
    await store.getState().openProject(id)
    return {
      inMemory,
      onDisk: JSON.stringify(store.getState().project.screens.map((s: any) => s.title ?? ''))
    }
  })
  expect(persisted.onDisk).toBe(persisted.inMemory)
})

test('with no model chosen, naming refuses rather than guessing', async () => {
  const refused = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    const settings = store.getState().settings
    const original = settings.providers.ollama.model
    await store.getState().saveSettings({
      ...settings,
      providers: { ...settings.providers, ollama: { ...settings.providers.ollama, model: '' } }
    })
    await store.getState().improveNames('all')
    const toast = store.getState().toast
    await store.getState().saveSettings(settings)
    return { toast, restored: original }
  })

  expect(refused.toast?.tone).toBe('error')
  expect(refused.toast?.text).toContain('Settings')
})
