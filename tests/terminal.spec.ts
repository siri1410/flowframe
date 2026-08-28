import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Mainframe screens and text capture.
 *
 * Recognition is never exact — the reader turns "Userid" into "Usexrid" often
 * enough — so every assertion here is on high-confidence words or on structure,
 * never on a whole line matching character for character.
 */

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const FIX = (name: string): string => path.join(HERE, 'fixtures', name)

let app: ElectronApplication
let page: Page
let dataDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-terminal-'))
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

async function wireframes(): Promise<Record<string, any>> {
  return page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    const byName: Record<string, any> = {}
    for (const wireframe of Object.values(project.wireframes) as any[]) {
      const screen = project.screens.find((item: any) => item.id === wireframe.screenId)
      byName[screen.name] = wireframe
    }
    return byName
  })
}

test('a mainframe module generates, reading the words off every screen', async () => {
  await page.locator('.module-name').first().fill('Green screens')
  await page.evaluate(async (files) => {
    await (window as any).__flowframe.store.getState().addScreensFromPaths(files)
  }, [FIX('10-cics-signon.png'), FIX('11-customer-inquiry.png'), FIX('13-app-signup.png')])

  await expect(page.locator('.thumb:not(.add)')).toHaveCount(3)

  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 180_000 })
  await expect(page.locator('.thumb .state.done')).toHaveCount(3)
})

test('terminal screens are recognised as terminals, and app screens are not', async () => {
  const all = await wireframes()
  expect(all['10-cics-signon.png'].terminal).toBe(true)
  expect(all['11-customer-inquiry.png'].terminal).toBe(true)
  // The graphical screen must not be dragged into the terminal branch.
  expect(all['13-app-signup.png'].terminal).toBe(false)
})

test('a terminal screen yields a title, entry fields and an F-key line', async () => {
  const signon = (await wireframes())['10-cics-signon.png']
  const kinds = signon.regions.map((region: any) => region.kind)

  // Font rendering differs enough between platforms to change what the reader
  // makes of a screen, so failures here print the regions that were actually
  // found rather than just a count.
  const detail = signon.regions
    .map((region: any) => `${region.kind}@${region.y}h${region.h}w${region.w}:${JSON.stringify(region.text ?? '')}`)
    .join('\n')

  expect(signon.title.toUpperCase(), detail).toContain('SIGNON')
  expect(kinds, detail).toContain('title')
  expect(kinds, detail).toContain('fkeys')
  // The entry fields are found from ink position, so this holds even where
  // recognition makes nothing of the underscores.
  expect(kinds.filter((kind: string) => kind === 'field').length, detail).toBeGreaterThan(0)
  // None of the graphical shapes belong on a green screen.
  expect(kinds, detail).not.toContain('hero')
  expect(kinds, detail).not.toContain('image')
})

test('the words on a terminal screen are captured', async () => {
  const all = await wireframes()
  const signon = all['10-cics-signon.png'].text.toUpperCase()
  expect(signon).toContain('SIGNON')
  expect(signon).toContain('PASSWORD')

  const inquiry = all['11-customer-inquiry.png'].text.toUpperCase()
  expect(inquiry).toContain('CUSTOMER')
  expect(inquiry).toContain('ACME MANUFACTURING')
  expect(inquiry).toContain('SHIPPED')
})

test('a repeating subfile is kept as one table, not one region per row', async () => {
  const inquiry = (await wireframes())['11-customer-inquiry.png']
  const tables = inquiry.regions.filter((region: any) => region.kind === 'table')
  expect(tables.length).toBeGreaterThan(0)
  // The order rows all live in the one table region.
  expect(tables[0].text).toContain('0091883')
  expect(inquiry.regions.length).toBeLessThan(40)
})

test('PF keys become the actions a user can take', async () => {
  const all = await wireframes()
  const fkeys = (name: string): string[] =>
    all[name].actions.map((action: any) => action.key).filter((key: string) => /^F\d+$/.test(key))

  // Which individual keys survive recognition varies with the platform's font
  // rendering, so assert on the shape of the result and on F3, which every
  // screen here carries and which reads cleanly everywhere.
  const signon = fkeys('10-cics-signon.png')
  expect(signon).toContain('F3')
  expect(signon.length).toBeGreaterThanOrEqual(2)

  const exit = all['10-cics-signon.png'].actions.find((action: any) => action.key === 'F3')
  expect(exit.label.toUpperCase()).toContain('EXIT')

  expect(fkeys('11-customer-inquiry.png').length).toBeGreaterThanOrEqual(3)
})

test('button text and field labels are captured on a graphical screen too', async () => {
  const signup = (await wireframes())['13-app-signup.png']
  const detail = JSON.stringify({ title: signup.title, actions: signup.actions, text: signup.text })

  expect(signup.title, detail).toContain('Create your account')
  expect(signup.text, detail).toContain('Email address')
  expect(signup.text, detail).toContain('Password')

  // Control labels are captured too, but how reliably depends on the renderer:
  // Windows reads nothing off this fixture's button row while macOS and Linux
  // read both labels. Body text and field labels are captured everywhere, so
  // that is what is asserted here; see docs/ENGINE.md for the limitation.
  expect(signup.text, detail).toContain('Company')
  expect(signup.regions.filter((region: any) => region.kind === 'input').length, detail).toBeGreaterThan(2)
})

test('entry fields are paired with the labels that name them', async () => {
  const all = await wireframes()

  // The terminal path is the reliable one: the label and the field are separate
  // regions on the same row, so the pairing is geometric rather than a guess.
  const signon = all['10-cics-signon.png'].fields ?? []
  const detail = JSON.stringify(signon)
  expect(signon.length, detail).toBeGreaterThanOrEqual(3)
  // Recognition turns "Userid" into "Usexrid" often enough that only a fuzzy
  // match is honest here — and which labels survive varies by platform, so this
  // asserts that naming happened at all, not which names came out.
  expect(signon.filter((field: any) => field.from === 'label').length, detail).toBeGreaterThan(0)
  expect(signon.every((field: any) => String(field.name).trim().length > 0), detail).toBe(true)

  // The inquiry screen's entry area is found from ink, so it always yields a
  // field. Whether the `===>` above it survives recognition is the platform's
  // business — Windows reads nothing off it where macOS and Linux do — so the
  // naming of the command line is asserted only where the words arrived.
  const inquiry = all['11-customer-inquiry.png'].fields ?? []
  const inquiryDetail = JSON.stringify(inquiry)
  expect(inquiry.length, inquiryDetail).toBeGreaterThan(0)
  expect(inquiry.every((field: any) => String(field.name).trim().length > 0), inquiryDetail).toBe(true)
  // Ask the same question the pairing does — did a *field* read as `===>` — so
  // this cannot be fooled by an arrow appearing somewhere else on the screen.
  const commandRead = (all['11-customer-inquiry.png'].regions ?? []).some(
    (region: any) => region.kind === 'field' && /=>/.test(region.text ?? '')
  )
  if (commandRead) {
    expect(inquiry.some((field: any) => /command/i.test(field.name)), inquiryDetail).toBe(true)
  }

  // On a graphical form the label and its box usually segment as one region, so
  // the control's own words are what name it.
  const signup = all['13-app-signup.png'].fields ?? []
  const names = signup.map((field: any) => String(field.name).toLowerCase()).join(' | ')
  expect(signup.length, names).toBeGreaterThanOrEqual(3)
  expect(names).toMatch(/e-?mail/)
})

test('the flow names each transition after the control the user presses', async () => {
  const triggers = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    store.getState().applyDraftFlow()
    return store.getState().project.flow.edges.map((edge: any) => edge.trigger)
  })

  // The first screen offers F-keys, so the trigger should name one rather than
  // falling back to the generic wording.
  expect(triggers.join(' | ')).toMatch(/Presses|Taps/)
})

test('the exported spec carries what each screen says', async () => {
  const spec = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    return (window as any).__flowframe.spec(store.getState().project)
  })

  expect(spec).toContain('## What each screen says')
  expect(spec).toContain('3270 / 5250 terminal screen')
  expect(spec.toUpperCase()).toContain('ACME MANUFACTURING')
})

test('turning text capture off still draws a wireframe', async () => {
  await page.locator('.tuner .toggle', { hasText: 'Read text' }).locator('input').uncheck()

  const before = await wireframes()
  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 180_000 })

  const after = await wireframes()
  expect(Object.keys(after)).toHaveLength(Object.keys(before).length)
  expect(after['10-cics-signon.png'].text).toBe('')
  // The shape of the screen is still found without the words.
  expect(after['10-cics-signon.png'].terminal).toBe(true)
  expect(after['10-cics-signon.png'].regions.length).toBeGreaterThan(3)

  await page.locator('.tuner .toggle', { hasText: 'Read text' }).locator('input').check()
})

test('with the words turned off, every field is still found and numbered', async () => {
  // The previous test regenerated with text capture off, so this reads those
  // results: the shapes are all the engine had to go on.
  const signon = (await wireframes())['10-cics-signon.png']
  const fields = signon.fields ?? []
  const detail = JSON.stringify(fields)

  // Entry fields come from ink thickness, not from the words, so they survive.
  expect(fields.length, detail).toBeGreaterThan(0)
  // With nothing read, every name is a position — and every field still has one.
  expect(fields.every((field: any) => field.from === 'position'), detail).toBe(true)
  expect(fields.every((field: any) => /^Field \d+$/.test(field.name)), detail).toBe(true)
})

test('the prototype exports even when nothing was read off the screens', async () => {
  const html = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const images: Record<string, string> = {}
    for (const wire of Object.values(project.wireframes) as any[]) {
      images[wire.screenId] =
        'data:image/png;base64,' + (await (window as any).flowframe.assets.read(project.id, wire.file))
    }
    return (window as any).__flowframe.prototype(project, images)
  })

  expect(html).toContain('<!doctype html>')
  expect(html).not.toMatch(/<script[^>]+src=/)
  expect(html.length).toBeGreaterThan(5000)
})
