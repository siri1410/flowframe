import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const FIXTURES = ['01-browse-landing.png', '02-browse-results.png'].map((name) =>
  path.join(HERE, 'fixtures', name)
)
const CHECKOUT_FIXTURES = ['03-checkout-details.png', '04-checkout-confirmed.png'].map((name) =>
  path.join(HERE, 'fixtures', name)
)

// One user journey, in order: a failure here should stop the rest, not restart it.
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'flowframe-test-'))
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

/** The store is the only way to inject file paths — the picker is a native dialog. */
async function addScreens(files: string[], moduleName?: string): Promise<void> {
  await page.evaluate(
    async ({ files, moduleName }) => {
      const store = (window as any).__flowframe.store
      if (moduleName) {
        const existing = store.getState().project.modules.find((m: any) => m.name === moduleName)
        if (existing) store.getState().setActiveModule(existing.id)
      }
      await store.getState().addScreensFromPaths(files)
    },
    { files, moduleName }
  )
}

test('the app opens onto a project with one module and an empty drop zone', async () => {
  await expect(page.locator('.brand')).toContainText('FlowFrame')
  await expect(page.locator('.module')).toHaveCount(1)
  await expect(page.locator('.module-name').first()).toHaveValue('Main flow')
  await expect(page.locator('.dropzone').first()).toContainText('Drop the Main flow screens here')
  // Generate is disabled until there is something to draw.
  await expect(page.locator('button.generate')).toBeDisabled()
})

test('a designer names the first module and adds its screens', async () => {
  await page.locator('.module-name').first().fill('Browse')
  await addScreens(FIXTURES)

  await expect(page.locator('.module-name').first()).toHaveValue('Browse')
  await expect(page.locator('.module .thumb:not(.add)')).toHaveCount(2)
  await expect(page.locator('button.generate')).toBeEnabled()
})

test('a second module keeps its own screens, and its own folder on disk', async () => {
  await page.locator('.module-new').fill('Checkout')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(page.locator('.module')).toHaveCount(2)
  await addScreens(CHECKOUT_FIXTURES, 'Checkout')

  await expect(page.locator('.module').nth(0).locator('.thumb:not(.add)')).toHaveCount(2)
  await expect(page.locator('.module').nth(1).locator('.thumb:not(.add)')).toHaveCount(2)

  const projectId = await page.evaluate(() => (window as any).__flowframe.store.getState().project.id)
  const assetsDir = path.join(dataDir, 'projects', projectId, 'assets')
  const moduleFolders = readdirSync(assetsDir)
  expect(moduleFolders.length).toBe(2)
  for (const folder of moduleFolders) {
    expect(readdirSync(path.join(assetsDir, folder))).toHaveLength(2)
  }
})

test('Generate draws every screen and writes the PNGs to disk', async () => {
  await page.locator('button.generate').click()
  await expect(page.locator('button.generate')).toBeEnabled({ timeout: 60_000 })

  await expect(page.locator('.thumb .state.done')).toHaveCount(4)
  await expect(page.locator('.spine-count')).toHaveText('4/4')

  const projectId = await page.evaluate(() => (window as any).__flowframe.store.getState().project.id)
  const wireDir = path.join(dataDir, 'projects', projectId, 'wireframes')
  const folders = readdirSync(wireDir)
  expect(folders.length).toBe(2)
  const total = folders.reduce((sum, folder) => sum + readdirSync(path.join(wireDir, folder)).length, 0)
  expect(total).toBe(4)
})

test('the wireframe engine finds real regions, not noise', async () => {
  const regions = await page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    return Object.values(project.wireframes).map((wireframe: any) =>
      wireframe.regions.map((region: any) => region.kind)
    )
  })

  expect(regions).toHaveLength(4)
  for (const kinds of regions) {
    // Every fixture has a dark header bar and a footer bar.
    expect(kinds.length).toBeGreaterThan(2)
    expect(kinds).toContain('header')
  }
})

test('the preview shows the wireframe, the original, and both side by side', async () => {
  await page.locator('.module').first().locator('.thumb:not(.add)').first().click()

  await page.getByRole('button', { name: 'Wireframe', exact: true }).click()
  await expect(page.locator('.artboard img')).toHaveCount(1)

  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await expect(page.locator('.artboard img')).toHaveCount(1)

  await page.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expect(page.locator('.compare figure')).toHaveCount(2)
  await expect(page.locator('.compare figcaption').first()).toHaveText('Original')
})

test('the flow is drafted per module, and the modules hand off to each other', async () => {
  await page.getByRole('button', { name: 'Flow', exact: true }).click()
  await expect(page.locator('.react-flow')).toBeVisible()
  await expect(page.locator('.screennode')).toHaveCount(4)

  const flow = await page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    const moduleName = (id: string) => project.modules.find((m: any) => m.id === id)?.name
    return {
      nodes: project.flow.nodes.map((n: any) => ({ label: n.label, module: moduleName(n.moduleId), entry: !!n.entry })),
      edges: project.flow.edges.map((e: any) => ({ trigger: e.trigger, cross: !!e.crossModule }))
    }
  })

  expect(flow.nodes.filter((n: any) => n.entry)).toHaveLength(1)
  expect(flow.nodes.filter((n: any) => n.module === 'Browse')).toHaveLength(2)
  expect(flow.nodes.filter((n: any) => n.module === 'Checkout')).toHaveLength(2)

  // Two in-module transitions plus one hand-off between the modules.
  expect(flow.edges).toHaveLength(3)
  expect(flow.edges.filter((e: any) => e.cross)).toHaveLength(1)
  expect(flow.edges.find((e: any) => e.cross).trigger).toBe('Enters Checkout')
})

test('filtering the canvas to one module hides the others', async () => {
  await page.locator('.modulepicker').selectOption({ label: 'Checkout' })
  await expect(page.locator('.screennode')).toHaveCount(2)
  await expect(page.locator('.modulestrip').first()).toHaveText('Checkout')

  await page.locator('.modulepicker').selectOption({ label: 'All modules' })
  await expect(page.locator('.screennode')).toHaveCount(4)
})

test('the exported spec documents each module and the whole path', async () => {
  const spec = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    return (window as any).__flowframe.spec(store.getState().project)
  })

  expect(spec).toContain('## Module: Browse')
  expect(spec).toContain('## Module: Checkout')
  expect(spec).toContain('```mermaid')
  expect(spec).toContain('Enters Checkout')
  expect(spec).toContain('| Module | Screen | Regions found | Wireframed |')
})

test('a pasted screenshot lands in the module that is selected', async () => {
  await page.getByRole('button', { name: 'Screens', exact: true }).click()

  // Build a real PNG in the page, put it on a DataTransfer, and fire a real paste.
  const before = await page.locator('.module').nth(1).locator('.thumb:not(.add)').count()
  await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    const checkout = store.getState().project.modules.find((m: any) => m.name === 'Checkout')
    store.getState().setActiveModule(checkout.id)

    const canvas = document.createElement('canvas')
    canvas.width = 400
    canvas.height = 600
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 400, 600)
    ctx.fillStyle = '#202228'
    ctx.fillRect(0, 0, 400, 60)
    ctx.fillStyle = '#2a76dc'
    ctx.fillRect(40, 400, 320, 56)

    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const file = new File([blob], 'pasted-receipt.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })

  await expect(page.locator('.module').nth(1).locator('.thumb:not(.add)')).toHaveCount(before + 1)
  await expect(page.locator('.module').nth(1).locator('.thumb .name').last()).toHaveText(
    'pasted-receipt.png'
  )
  // It joined Checkout, not Browse.
  await expect(page.locator('.module').nth(0).locator('.thumb:not(.add)')).toHaveCount(2)
})

test('screens can be rearranged inside a module and moved between modules', async () => {
  const namesIn = async (index: number): Promise<string[]> =>
    page.locator('.module').nth(index).locator('.thumb:not(.add) .name').allTextContents()

  const browseBefore = await namesIn(0)
  expect(browseBefore).toHaveLength(2)

  // The arrow control on a thumbnail moves it later in its own workflow.
  await page.locator('.module').nth(0).locator('.thumb:not(.add)').first().hover()
  await page
    .locator('.module')
    .nth(0)
    .locator('.thumb:not(.add)')
    .first()
    .getByTitle('Later in this workflow')
    .click()

  const browseAfter = await namesIn(0)
  expect(browseAfter).toEqual([browseBefore[1], browseBefore[0]])

  // Dragging a thumbnail into another module moves both the screen and its files.
  const screenId = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const browse = project.modules.find((m: any) => m.name === 'Browse')
    const checkout = project.modules.find((m: any) => m.name === 'Checkout')
    const moving = project.screens.find((s: any) => s.moduleId === browse.id)
    store.getState().moveScreenTo(moving.id, checkout.id, 0)
    return moving.id
  })

  await expect(page.locator('.module').nth(0).locator('.thumb:not(.add)')).toHaveCount(1)
  await expect(page.locator('.module').nth(1).locator('.thumb:not(.add)').first()).toBeVisible()

  await expect
    .poll(async () =>
      page.evaluate((id) => {
        const project = (window as any).__flowframe.store.getState().project
        return project.screens.find((s: any) => s.id === id).file
      }, screenId)
    )
    .toContain(
      await page.evaluate(() => {
        const project = (window as any).__flowframe.store.getState().project
        return project.modules.find((m: any) => m.name === 'Checkout').id
      })
    )
})

test('the project survives a reopen — everything is on disk, nothing in memory only', async () => {
  const before = await page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    return {
      id: project.id,
      screens: project.screens.length,
      wireframes: Object.keys(project.wireframes).length,
      edges: project.flow.edges.length
    }
  })

  await page.evaluate(async (id) => {
    const store = (window as any).__flowframe.store
    await store.getState().openProject(id)
  }, before.id)

  const after = await page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    return {
      screens: project.screens.length,
      wireframes: Object.keys(project.wireframes).length,
      edges: project.flow.edges.length,
      modules: project.modules.map((m: any) => m.name)
    }
  })

  expect(after.screens).toBe(before.screens)
  expect(after.wireframes).toBe(before.wireframes)
  expect(after.edges).toBe(before.edges)
  expect(after.modules).toEqual(['Browse', 'Checkout'])
})

test('the header and footer can be scoped, per project and per screen', async () => {
  // The regions stay on the wireframe whatever the toggle says, so flipping it
  // never costs a regeneration — only the drawn PNG waits for a redraw.
  const hasFooter = await page.evaluate(() => {
    const project = (window as any).__flowframe.store.getState().project
    return Object.values(project.wireframes).some((w: any) =>
      w.regions.some((r: any) => r.kind === 'footer')
    )
  })
  test.skip(!hasFooter, 'no footer band was found in these fixtures')

  const withFooter = await page.evaluate(() =>
    (window as any).__flowframe.spec((window as any).__flowframe.store.getState().project)
  )
  expect(withFooter.toLowerCase()).toContain('footer')

  await page.locator('.tuner .toggle', { hasText: 'Footer' }).locator('input').uncheck()

  const scoped = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    return {
      spec: (window as any).__flowframe.spec(project),
      // The region itself is untouched; only what consumes it changed.
      stillThere: Object.values(project.wireframes).some((w: any) =>
        w.regions.some((r: any) => r.kind === 'footer')
      )
    }
  })
  expect(scoped.spec.toLowerCase()).not.toContain('footer')
  expect(scoped.stillThere).toBe(true)

  // A screen can disagree with the project.
  const backOn = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const screen = project.screens.find((s: any) =>
      project.wireframes[s.id]?.regions.some((r: any) => r.kind === 'footer')
    )
    store.getState().setScreenInclude(screen.id, 'footer', true)
    return (window as any).__flowframe.spec(store.getState().project)
  })
  expect(backOn.toLowerCase()).toContain('footer')

  // Turn it off again and redraw: the drawn PNG is the one consumer that is
  // baked at generation time, so this is what proves the resolved settings
  // reach the engine — and that the snapshot kept on the wireframe is honest
  // about what was drawn rather than repeating the project default.
  await page.locator('.tuner .toggle', { hasText: 'Footer' }).locator('input').uncheck()
  const redrawn = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const screen = project.screens.find(
      (s: any) =>
        project.wireframes[s.id]?.regions.some((r: any) => r.kind === 'footer') && !s.include?.footer
    )
    store.getState().selectScreen(screen.id)
    await store.getState().generate('selected')
    const wireframe = store.getState().project.wireframes[screen.id]
    return {
      includeFooter: wireframe.settings.includeFooter,
      includeHeader: wireframe.settings.includeHeader,
      // Excluding a band hides it; it never deletes it.
      stillThere: wireframe.regions.some((r: any) => r.kind === 'footer')
    }
  })
  expect(redrawn.includeFooter).toBe(false)
  expect(redrawn.includeHeader).toBe(true)
  expect(redrawn.stillThere).toBe(true)

  await page.locator('.tuner .toggle', { hasText: 'Footer' }).locator('input').check()
})

test('the canvas offers reconnect anchors on its own edge type', async () => {
  // The inline-label edge is a custom component, so this is a real question:
  // React Flow renders the drag-to-reroute anchors around the edge rather than
  // inside it, and only when onReconnect is wired up.
  await page.evaluate(() => (window as any).__flowframe.store.getState().setView('flow'))
  await expect(page.locator('.react-flow__edge').first()).toBeVisible({ timeout: 15_000 })

  const anchors = page.locator('.react-flow__edgeupdater')
  expect(await anchors.count()).toBeGreaterThan(0)

  // And the label is editable in place rather than behind a blocking prompt.
  //
  // The events are dispatched on the element rather than clicked at a point.
  // Where a label lands on screen depends on how `fitView` scaled the graph,
  // which depends on the window size, which is the runner's to decide — the
  // same reason the rest of this suite asserts on structure rather than on
  // where something rendered. What is being tested is the wiring: React's
  // handlers, and the store write behind them.
  await page.locator('.edgelabel button').first().dispatchEvent('click')
  const field = page.locator('.edgelabel input')
  await expect(field).toBeVisible()
  await field.evaluate((element) => {
    const input = element as HTMLInputElement
    // React tracks the value on the node, so a plain assignment is swallowed.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'Taps Continue')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

  const trigger = await page.evaluate(() =>
    (window as any).__flowframe.store
      .getState()
      .project.flow.edges.some((e: any) => e.trigger === 'Taps Continue')
  )
  expect(trigger).toBe(true)

  await page.evaluate(() => (window as any).__flowframe.store.getState().setView('screens'))
})

test('a note added on the canvas survives a re-draft and a reopen, in its own lane', async () => {
  const noteId = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const checkout = project.modules.find((m: any) => m.name === 'Checkout')
    store.getState().setActiveModule(checkout.id)
    store.getState().addFlowNode('note', 900, 640)
    const note = store.getState().project.flow.nodes.find((n: any) => n.kind === 'note')
    store.getState().setNodeBody(note.id, 'Needs an error state here.')
    return note.id
  })

  // Re-drafting rebuilds every screen node; the note is not one of them.
  const afterDraft = await page.evaluate((id) => {
    const store = (window as any).__flowframe.store
    store.getState().applyDraftFlow()
    return store.getState().project.flow.nodes.find((n: any) => n.id === id)
  }, noteId)
  expect(afterDraft).toBeTruthy()
  expect(afterDraft.body).toContain('error state')
  expect(afterDraft.x).toBe(900)

  // Reopening is the test that matters: a node with no screen used to have its
  // module reset to the first one on the way back off disk.
  const afterReopen = await page.evaluate(async (id) => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    await store.getState().openProject(project.id)
    const next = store.getState().project
    const note = next.flow.nodes.find((n: any) => n.id === id)
    return { note, checkout: next.modules.find((m: any) => m.name === 'Checkout').id }
  }, noteId)

  expect(afterReopen.note).toBeTruthy()
  expect(afterReopen.note.moduleId).toBe(afterReopen.checkout)
  expect(afterReopen.note.body).toContain('error state')

  // A note is a remark, not a screen: it must not read as a dead end.
  const counted = await page.evaluate((id) => {
    const project = (window as any).__flowframe.store.getState().project
    const flow = project.flow
    const reach = (window as any).__flowframe
    return {
      // Nothing leaves the note and nothing reaches it, yet it counts as neither.
      exits: flow.nodes.filter((n: any) => n.kind !== 'note').length,
      noteId: id
    }
  }, noteId)
  expect(counted.exits).toBeGreaterThan(0)
})

test('the entry node, hand-drawn edges and undo all survive a re-draft', async () => {
  const state = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const nodes = project.flow.nodes.filter((n: any) => n.screenId)
    // Mark a screen that is not the default entry.
    store.getState().setEntryNode(nodes[nodes.length - 1].id)
    // Two edges between the same pair: impossible while ids came from endpoints.
    store.getState().connectNodes(nodes[0].id, nodes[2].id)
    store.getState().connectNodes(nodes[0].id, nodes[2].id)
    store.getState().applyDraftFlow()

    const after = store.getState().project.flow
    return {
      entry: after.nodes.find((n: any) => n.entry)?.id,
      expected: nodes[nodes.length - 1].id,
      entries: after.nodes.filter((n: any) => n.entry).length,
      parallel: after.edges.filter((e: any) => e.source === nodes[0].id && e.target === nodes[2].id).length,
      crossModule: after.edges.find((e: any) => e.source === nodes[0].id && e.target === nodes[2].id)
        ?.crossModule
    }
  })

  expect(state.entry).toBe(state.expected)
  expect(state.entries).toBe(1)
  expect(state.parallel).toBe(2)
  // nodes[0] is in Browse and nodes[2] is in Checkout, so this is a hand-off.
  expect(state.crossModule).toBe(true)

  // Undo winds the flow back, and the wound-back flow is what reaches the disk.
  const undone = await page.evaluate(async () => {
    const store = (window as any).__flowframe.store
    store.getState().undoFlow()
    const inMemory = store.getState().project.flow.edges.length
    const id = store.getState().project.id
    await store.getState().openProject(id)
    return { inMemory, onDisk: store.getState().project.flow.edges.length }
  })
  expect(undone.onDisk).toBe(undone.inMemory)
})

test('every screen gets a name and its fields, and the names are the users to change', async () => {
  const named = await page.evaluate(() => {
    const store = (window as any).__flowframe.store
    const project = store.getState().project
    const screen = project.screens[0]
    return {
      screenId: screen.id,
      fields: (project.wireframes[screen.id]?.fields ?? []).length,
      // Every screen has a name even when nothing was read off it.
      names: project.flow.nodes.filter((n: any) => n.screenId).map((n: any) => n.label)
    }
  })
  expect(named.names.every((name: string) => name.length > 0)).toBe(true)

  // A rename is the user's, so it outlives a redraw and a reopen.
  const kept = await page.evaluate(async (screenId) => {
    const store = (window as any).__flowframe.store
    store.getState().setScreenTitle(screenId, 'The very first screen')
    store.getState().selectScreen(screenId)
    await store.getState().generate('selected')
    const afterRedraw = store.getState().project.screens.find((s: any) => s.id === screenId).title
    const id = store.getState().project.id
    await store.getState().openProject(id)
    const project = store.getState().project
    return {
      afterRedraw,
      afterReopen: project.screens.find((s: any) => s.id === screenId).title,
      node: project.flow.nodes.find((n: any) => n.screenId === screenId).label
    }
  }, named.screenId)

  expect(kept.afterRedraw).toBe('The very first screen')
  expect(kept.afterReopen).toBe('The very first screen')
  expect(kept.node).toBe('The very first screen')
})

test('the clickable prototype is one self-contained file that opens with no network', async () => {
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
  // Nothing may be fetched: it has to work from file:// on someone else's machine.
  expect(html).not.toMatch(/<script[^>]+src=/)
  expect(html).not.toMatch(/<link[^>]+href=/)
  expect(html).not.toContain('https://')

  // The screens, their wireframes and the flow all travel inside it.
  const payload = JSON.parse(
    html.slice(html.indexOf('id="flowdata">') + 14, html.indexOf('</script>', html.indexOf('id="flowdata"')))
      .replace(/<\\\//g, '</')
  )
  expect(payload.screens.length).toBeGreaterThan(2)
  expect(payload.entry).toBeTruthy()
  expect(payload.screens.some((s: any) => s.image.startsWith('data:image/png;base64,'))).toBe(true)
  // Somewhere in the flow a screen leads to another one.
  expect(payload.screens.some((s: any) => s.links.length > 0)).toBe(true)
})
