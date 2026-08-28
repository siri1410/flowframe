import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/** Captures the app for the README. Run with: npx playwright test tests/screenshot.spec.ts */

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const SHOTS = path.join(HERE, '..', 'docs')
const FIX = (name: string): string => path.join(HERE, 'fixtures', name)

let app: ElectronApplication
let page: Page
let dataDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-shots-'))
  app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, FLOWFRAME_DATA_DIR: dataDir, NODE_ENV: 'test' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 60_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
})

test.afterAll(async () => {
  await app?.close()
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
})

test('capture', async () => {
  await page.locator('.module-name').first().fill('Browse')
  await page.evaluate(async (files) => {
    const store = (window as any).__flowframe.store
    await store.getState().addScreensFromPaths(files)
  }, [FIX('01-browse-landing.png'), FIX('02-browse-results.png')])

  await page.locator('.module-new').fill('Checkout')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.evaluate(async (files) => {
    const store = (window as any).__flowframe.store
    await store.getState().addScreensFromPaths(files)
  }, [FIX('03-checkout-details.png'), FIX('04-checkout-confirmed.png')])

  await page.waitForTimeout(4200) // let the "screens added" toast fade
  await page.screenshot({ path: path.join(SHOTS, '01-upload.png') })

  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 180_000 })
  await page.locator('.module').first().locator('.thumb:not(.add)').first().click()
  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOTS, '02-wireframe.png') })

  await page.getByRole('button', { name: 'Flow', exact: true }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(SHOTS, '03-flow.png') })

  // A mainframe module, showing terminal detection and captured text.
  await page.getByRole('button', { name: 'Screens', exact: true }).click()
  await page.locator('.module-new').fill('Mainframe')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.evaluate(async (files) => {
    const store = (window as any).__flowframe.store
    await store.getState().addScreensFromPaths(files)
  }, [FIX('11-customer-inquiry.png'), FIX('12-order-detail.png')])

  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 180_000 })
  await page.locator('.module').nth(2).locator('.thumb:not(.add)').first().click()
  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOTS, '04-mainframe.png') })
})
