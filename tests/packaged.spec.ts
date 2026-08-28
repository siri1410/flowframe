import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * Runs the packaged binary rather than the bundle. Text capture depends on files
 * resolving outside the asar archive, which only breaks once the app is packed —
 * so it has to be proven here, not in the dev suite.
 *
 * Skips itself when `npm run pack` has not been run.
 */

const CANDIDATES = [
  'mac-arm64/FlowFrame.app/Contents/MacOS/FlowFrame',
  'mac/FlowFrame.app/Contents/MacOS/FlowFrame',
  'linux-unpacked/flowframe',
  'win-unpacked/FlowFrame.exe'
]

test('the packaged app reads text off a screen', async () => {
  test.setTimeout(300_000)

  const root = path.resolve(__dirname, '..')
  const binary = CANDIDATES.map((candidate) => path.join(root, 'release', candidate)).find(existsSync)
  test.skip(!binary, 'No packaged build found — run: npm run pack')

  const dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-packaged-'))
  const app = await electron.launch({
    executablePath: binary!,
    args: [],
    env: { ...process.env, FLOWFRAME_DATA_DIR: dataDir, NODE_ENV: 'test' }
  })

  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 90_000 })

    const result = await page.evaluate(async (fixture) => {
      const store = (window as any).__flowframe.store
      await store.getState().addScreensFromPaths([fixture])
      await store.getState().generate('all')
      const project = store.getState().project
      const wireframe = Object.values(project.wireframes)[0] as any
      return { terminal: wireframe.terminal, text: wireframe.text, actions: wireframe.actions }
    }, path.join(__dirname, 'fixtures', '11-customer-inquiry.png'))

    expect(result.terminal).toBe(true)
    expect(result.text.toUpperCase()).toContain('CUSTOMER')
    expect(result.actions.map((action: any) => action.key)).toContain('F3')
  } finally {
    await app.close()
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  }
})
