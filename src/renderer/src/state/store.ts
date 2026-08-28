import { create } from 'zustand'
import type {
  AppSettings,
  ChatMessage,
  GenerateSettings,
  Module,
  OcrWord,
  Project,
  ProjectSummary,
  ProviderId,
  ProviderStatus,
  ScreenAsset
} from '../../../shared/types'
import type { FlowEdge, FlowNode } from '../../../shared/types'
import { DEFAULT_SETTINGS, MODULE_COLORS } from '../../../shared/types'
import {
  draftFlow,
  flowContext,
  screenFields,
  screenName,
  screensInModule,
  sortedModules
} from '../lib/flow'
import { finishWireframe, loadImage, mergeWords, prepareWireframe } from '../lib/wireframe'

const api = window.flowframe

/** One point in the flow canvas's undo history. */
type FlowState = { nodes: FlowNode[]; edges: FlowEdge[] }

/** Deepest the canvas remembers. Far more than anyone winds back by hand. */
const FLOW_HISTORY_LIMIT = 50

interface GenerationState {
  active: boolean
  done: number
  total: number
  currentScreenId: string | null
  /** 0..1, drives the plotter line down the centre spine. */
  progress: number
  /** What the run is doing right now, shown next to the counter. */
  stage: 'drawing' | 'reading'
}

interface Store {
  ready: boolean
  info: { version: string; platform: string; dataDir: string }
  projects: ProjectSummary[]
  project: Project | null
  settings: AppSettings
  providers: ProviderStatus[]

  /** Blob URLs keyed by screen id. Source screenshots and generated wireframes. */
  sourceUrls: Record<string, string>
  wireframeUrls: Record<string, string>

  selectedScreenId: string | null
  /** The module new screenshots land in, and the one the flow view focuses. */
  activeModuleId: string | null
  view: 'screens' | 'flow'
  /** 'all' shows every module in the flow canvas, otherwise just the active one. */
  flowScope: 'all' | 'module'
  generation: GenerationState
  /** Undo stack for the flow canvas only. Snapshots, not commands. */
  flowHistory: { past: FlowState[]; future: FlowState[] }
  chatBusy: boolean
  chatRequestId: string | null
  toast: { text: string; tone: 'info' | 'error' } | null

  boot: () => Promise<void>
  refreshProjects: () => Promise<void>
  openProject: (id: string) => Promise<void>
  createProject: (name: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  renameProject: (name: string) => void
  revealProject: () => void

  addModule: (name: string) => void
  renameModule: (moduleId: string, name: string) => void
  removeModule: (moduleId: string) => Promise<void>
  reorderModule: (moduleId: string, direction: -1 | 1) => void
  setActiveModule: (moduleId: string) => void
  moveScreenToModule: (screenId: string, moduleId: string) => void
  moveScreenTo: (screenId: string, moduleId: string, index: number) => void

  addScreensByDialog: (moduleId?: string) => Promise<void>
  addScreensFromPaths: (paths: string[], moduleId?: string) => Promise<void>
  addScreensFromFiles: (files: File[], moduleId?: string) => Promise<void>
  removeScreen: (screenId: string) => Promise<void>
  reorderScreen: (screenId: string, direction: -1 | 1) => void
  selectScreen: (screenId: string | null) => void

  setGenerateSetting: <K extends keyof GenerateSettings>(key: K, value: GenerateSettings[K]) => void
  generate: (scope: 'all' | 'module' | 'selected') => Promise<void>

  /** The user's own name for a screen. Also renames its flow node. */
  setScreenTitle: (screenId: string, title: string) => void
  setScreenGoal: (screenId: string, goal: string) => void
  setFieldName: (screenId: string, key: string, name: string) => void
  /** undefined puts the screen back on the project default. */
  setScreenInclude: (screenId: string, part: 'header' | 'footer', value: boolean | undefined) => void
  /** Asks the configured model to improve the derived names. Heuristics stand if it fails. */
  improveNames: (scope: 'selected' | 'all') => Promise<void>
  namingBusy: boolean

  setView: (view: 'screens' | 'flow') => void
  setFlowScope: (scope: 'all' | 'module') => void
  applyDraftFlow: () => void
  setNodePosition: (nodeId: string, x: number, y: number) => void
  setNodeLabel: (nodeId: string, label: string) => void
  setNodeBody: (nodeId: string, body: string) => void
  setEntryNode: (nodeId: string) => void
  connectNodes: (source: string, target: string) => void
  reconnectEdge: (edgeId: string, source: string, target: string) => void
  setEdgeTrigger: (edgeId: string, trigger: string) => void
  removeEdge: (edgeId: string) => void
  addFlowNode: (kind: 'note' | 'stub', x: number, y: number) => void
  removeFlowNodes: (nodeIds: string[]) => void
  undoFlow: () => void
  redoFlow: () => void

  refreshProviders: () => Promise<void>
  saveSettings: (next: AppSettings) => Promise<void>
  saveApiKey: (provider: ProviderId, key: string) => Promise<void>
  sendChat: (text: string, attachScreens: boolean) => Promise<void>
  stopChat: () => void
  clearChat: () => void

  notify: (text: string, tone?: 'info' | 'error') => void
  dismissToast: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(get: () => Store): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const project = get().project
    if (project) void api.projects.save(project)
  }, 400)
}

/**
 * Writes a pending edit out now rather than in 400ms.
 *
 * Anything that is about to read the project back off disk has to go through
 * here first, or the last edit before it is lost — the debounce is a courtesy
 * to the disk, not permission to drop work.
 */
async function flushSave(get: () => Store): Promise<void> {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  const project = get().project
  if (project) await api.projects.save(project)
}

/**
 * Remembers the flow as it is right now, so the next edit can be undone.
 *
 * Scoped to `project.flow` on purpose: Cmd+Z on the canvas should bring back the
 * last connection, never wind back a generation run or a file write.
 */
function pushFlowHistory(get: () => Store, set: (partial: Partial<Store>) => void): void {
  const project = get().project
  if (!project) return
  const { past } = get().flowHistory
  const next = [...past, { nodes: project.flow.nodes, edges: project.flow.edges }]
  set({
    flowHistory: { past: next.slice(-FLOW_HISTORY_LIMIT), future: [] }
  })
}

interface NamingAnswer {
  screens: { screenId: string; name?: string; goal?: string }[]
  fields: { screenId: string; key: string; name?: string }[]
}

/**
 * Pulls the JSON out of a model's answer, however it wrapped it.
 *
 * Anything that does not parse means the derived names stand — a naming pass
 * that cannot be trusted is simply not applied.
 */
function parseNaming(text: string): NamingAnswer | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<NamingAnswer>
    return {
      screens: Array.isArray(raw.screens) ? raw.screens.filter((item) => item?.screenId) : [],
      fields: Array.isArray(raw.fields) ? raw.fields.filter((item) => item?.screenId && item?.key) : []
    }
  } catch {
    return null
  }
}

function blobUrl(base64: string, type = 'image/png'): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type }))
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/png'
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  info: { version: '0.0.0', platform: 'unknown', dataDir: '' },
  projects: [],
  project: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  providers: [],
  sourceUrls: {},
  wireframeUrls: {},
  selectedScreenId: null,
  activeModuleId: null,
  view: 'screens',
  flowScope: 'all',
  generation: {
    active: false,
    done: 0,
    total: 0,
    currentScreenId: null,
    progress: 0,
    stage: 'drawing'
  },
  flowHistory: { past: [], future: [] },
  namingBusy: false,
  chatBusy: false,
  chatRequestId: null,
  toast: null,

  boot: async () => {
    const [info, settings, projects] = await Promise.all([
      api.app.info(),
      api.settings.get(),
      api.projects.list()
    ])
    set({ info, settings, projects, ready: true })

    if (projects.length) {
      await get().openProject(projects[0].id)
    } else {
      await get().createProject('My first flow')
    }
    void get().refreshProviders()
  },

  refreshProjects: async () => set({ projects: await api.projects.list() }),

  openProject: async (id) => {
    await flushSave(get)
    const project = await api.projects.open(id)

    // Release the previous project's blob URLs before swapping them out.
    for (const url of Object.values(get().sourceUrls)) URL.revokeObjectURL(url)
    for (const url of Object.values(get().wireframeUrls)) URL.revokeObjectURL(url)

    const sourceUrls: Record<string, string> = {}
    const wireframeUrls: Record<string, string> = {}

    await Promise.all(
      project.screens.map(async (screen) => {
        try {
          sourceUrls[screen.id] = blobUrl(await api.assets.read(project.id, screen.file), mimeFor(screen.file))
        } catch {
          // Asset went missing on disk. The screen stays listed but renders empty.
        }
      })
    )
    await Promise.all(
      Object.values(project.wireframes).map(async (wireframe) => {
        try {
          wireframeUrls[wireframe.screenId] = blobUrl(await api.assets.read(project.id, wireframe.file))
        } catch {
          /* ignore */
        }
      })
    )

    set({
      project,
      sourceUrls,
      wireframeUrls,
      selectedScreenId: project.screens[0]?.id ?? null,
      activeModuleId: sortedModules(project)[0]?.id ?? null,
      view: 'screens',
      // A different project's history is not this project's history.
      flowHistory: { past: [], future: [] }
    })
  },

  createProject: async (name) => {
    const project = await api.projects.create(name)
    await get().refreshProjects()
    await get().openProject(project.id)
  },

  deleteProject: async (id) => {
    await api.projects.remove(id)
    await get().refreshProjects()
    const remaining = get().projects
    if (get().project?.id === id) {
      if (remaining.length) await get().openProject(remaining[0].id)
      else await get().createProject('My first flow')
    }
  },

  renameProject: (name) => {
    const project = get().project
    if (!project) return
    set({ project: { ...project, name } })
    scheduleSave(get)
  },

  revealProject: () => {
    const project = get().project
    if (project) void api.projects.reveal(project.id)
  },

  // ------------------------------------------------------------- modules
  addModule: (name) => {
    const project = get().project
    if (!project) return
    const module: Module = {
      id: `mod_${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim() || `Module ${project.modules.length + 1}`,
      color: MODULE_COLORS[project.modules.length % MODULE_COLORS.length],
      order: project.modules.length
    }
    const next = { ...project, modules: [...project.modules, module] }
    set({ project: next, activeModuleId: module.id })
    void api.projects.save(next)
  },

  renameModule: (moduleId, name) => {
    const project = get().project
    if (!project) return
    const modules = project.modules.map((module) =>
      module.id === moduleId ? { ...module, name } : module
    )
    set({ project: { ...project, modules } })
    scheduleSave(get)
  },

  removeModule: async (moduleId) => {
    const project = get().project
    if (!project || project.modules.length <= 1) {
      get().notify('A project keeps at least one module.', 'error')
      return
    }
    for (const screen of project.screens.filter((item) => item.moduleId === moduleId)) {
      await get().removeScreen(screen.id)
    }
    const current = get().project
    if (!current) return
    const modules = current.modules
      .filter((module) => module.id !== moduleId)
      .map((module, index) => ({ ...module, order: index }))
    const next = { ...current, modules }
    set({ project: next, activeModuleId: modules[0]?.id ?? null })
    await api.projects.save(next)
  },

  reorderModule: (moduleId, direction) => {
    const project = get().project
    if (!project) return
    const modules = sortedModules(project)
    const index = modules.findIndex((module) => module.id === moduleId)
    const swapWith = index + direction
    if (index === -1 || swapWith < 0 || swapWith >= modules.length) return
    ;[modules[index], modules[swapWith]] = [modules[swapWith], modules[index]]
    const next = {
      ...project,
      modules: modules.map((module, order) => ({ ...module, order }))
    }
    set({ project: next })
    scheduleSave(get)
  },

  setActiveModule: (moduleId) => set({ activeModuleId: moduleId }),

  /** Drops a screen at a given position, in this module or another one. */
  moveScreenTo: (screenId, moduleId, index) => {
    const project = get().project
    if (!project) return
    const moving = project.screens.find((screen) => screen.id === screenId)
    if (!moving) return

    const sameModule = moving.moduleId === moduleId
    const target = screensInModule(project, moduleId).filter((screen) => screen.id !== screenId)
    const at = Math.max(0, Math.min(index, target.length))
    target.splice(at, 0, { ...moving, moduleId })

    const positions = new Map(target.map((screen, order) => [screen.id, order]))
    const screens = project.screens.map((screen) => {
      if (screen.id === screenId) return { ...screen, moduleId, order: positions.get(screen.id)! }
      return positions.has(screen.id) ? { ...screen, order: positions.get(screen.id)! } : screen
    })
    const nodes = project.flow.nodes.map((node) =>
      node.screenId === screenId ? { ...node, moduleId } : node
    )

    set({ project: { ...project, screens, flow: { ...project.flow, nodes } } })
    if (sameModule) {
      scheduleSave(get)
      return
    }
    void relocateFiles(screenId, moduleId, set, get)
  },

  moveScreenToModule: (screenId, moduleId) => {
    const project = get().project
    if (!project) return
    const moving = project.screens.find((screen) => screen.id === screenId)
    if (!moving || moving.moduleId === moduleId) return

    const order = screensInModule(project, moduleId).length
    const screens = project.screens.map((screen) =>
      screen.id === screenId ? { ...screen, moduleId, order } : screen
    )
    const nodes = project.flow.nodes.map((node) =>
      node.screenId === screenId ? { ...node, moduleId } : node
    )
    set({ project: { ...project, screens, flow: { ...project.flow, nodes } } })

    void relocateFiles(screenId, moduleId, set, get)
  },

  // ------------------------------------------------------------- screens
  addScreensByDialog: async (moduleId) => {
    const project = get().project
    if (!project) return
    const imported = await api.assets.pick(project.id, moduleId ?? get().activeModuleId ?? project.modules[0].id)
    await ingest(imported, moduleId ?? get().activeModuleId, set, get)
  },

  addScreensFromPaths: async (paths, moduleId) => {
    const project = get().project
    if (!project || !paths.length) return
    const imported = await api.assets.importPaths(project.id, moduleId ?? get().activeModuleId ?? project.modules[0].id, paths)
    await ingest(imported, moduleId ?? get().activeModuleId, set, get)
  },

  addScreensFromFiles: async (files, moduleId) => {
    const project = get().project
    if (!project || !files.length) return
    const payload = await Promise.all(
      files.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) }))
    )
    const imported = await api.assets.importBuffers(project.id, moduleId ?? get().activeModuleId ?? project.modules[0].id, payload)
    await ingest(imported, moduleId ?? get().activeModuleId, set, get)
  },

  removeScreen: async (screenId) => {
    const project = get().project
    if (!project) return
    const screen = project.screens.find((item) => item.id === screenId)
    if (screen) void api.assets.remove(project.id, screen.file)
    const wireframe = project.wireframes[screenId]
    if (wireframe) void api.assets.remove(project.id, wireframe.file)

    const wireframes = { ...project.wireframes }
    delete wireframes[screenId]
    const screens = project.screens.filter((item) => item.id !== screenId)
    const nodes = project.flow.nodes.filter((node) => node.screenId !== screenId)
    const nodeIds = new Set(nodes.map((node) => node.id))
    const edges = project.flow.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
    )

    const sourceUrls = { ...get().sourceUrls }
    const wireframeUrls = { ...get().wireframeUrls }
    if (sourceUrls[screenId]) URL.revokeObjectURL(sourceUrls[screenId])
    if (wireframeUrls[screenId]) URL.revokeObjectURL(wireframeUrls[screenId])
    delete sourceUrls[screenId]
    delete wireframeUrls[screenId]

    set({
      project: { ...project, screens, wireframes, flow: { nodes, edges } },
      sourceUrls,
      wireframeUrls,
      selectedScreenId: screens[0]?.id ?? null
    })
    scheduleSave(get)
  },

  reorderScreen: (screenId, direction) => {
    const project = get().project
    if (!project) return
    const moving = project.screens.find((screen) => screen.id === screenId)
    if (!moving) return

    // Screens only move within their own module — a module is one workflow.
    const siblings = screensInModule(project, moving.moduleId)
    const index = siblings.findIndex((screen) => screen.id === screenId)
    const swapWith = index + direction
    if (swapWith < 0 || swapWith >= siblings.length) return
    ;[siblings[index], siblings[swapWith]] = [siblings[swapWith], siblings[index]]

    const reordered = new Map(siblings.map((screen, order) => [screen.id, order]))
    const screens = project.screens.map((screen) =>
      reordered.has(screen.id) ? { ...screen, order: reordered.get(screen.id)! } : screen
    )
    set({ project: { ...project, screens } })
    scheduleSave(get)
  },

  selectScreen: (screenId) => set({ selectedScreenId: screenId }),

  // ---------------------------------------------------------- generation
  setGenerateSetting: (key, value) => {
    const project = get().project
    if (!project) return
    set({ project: { ...project, generate: { ...project.generate, [key]: value } } })
    scheduleSave(get)
  },

  generate: async (scope) => {
    const state = get()
    const project = state.project
    if (!project) return

    const ordered = sortedModules(project).flatMap((module) => screensInModule(project, module.id))
    const queue =
      scope === 'selected' && state.selectedScreenId
        ? project.screens.filter((screen) => screen.id === state.selectedScreenId)
        : scope === 'module' && state.activeModuleId
          ? screensInModule(project, state.activeModuleId)
          : ordered

    if (!queue.length) {
      get().notify(
        scope === 'module'
          ? 'This module has no screenshots yet. Drop some into it first.'
          : 'Add a screenshot first — the left panel takes a drop or a click.',
        'error'
      )
      return
    }

    set({
      generation: {
        active: true,
        done: 0,
        total: queue.length,
        currentScreenId: null,
        progress: 0,
        stage: 'drawing'
      }
    })

    const wireframes = { ...project.wireframes }
    const wireframeUrls = { ...get().wireframeUrls }
    let failures = 0

    for (let index = 0; index < queue.length; index += 1) {
      const screen = queue[index]
      const mark = (stage: 'drawing' | 'reading'): void => {
        set({
          generation: {
            active: true,
            done: index,
            total: queue.length,
            currentScreenId: screen.id,
            progress: index / queue.length,
            stage
          }
        })
      }
      mark('drawing')
      // Let the spine repaint between screens so the plot line actually animates.
      await new Promise((resolve) => requestAnimationFrame(resolve))

      try {
        const url = get().sourceUrls[screen.id]
        if (!url) throw new Error('missing source')
        const image = await loadImage(url)

        // The header/footer scope is the one setting that is per screen, so the
        // snapshot kept on the wireframe has to be the resolved one — otherwise
        // it would claim a header was drawn that was not.
        const perScreen: GenerateSettings = {
          ...project.generate,
          includeHeader: screen.include?.header ?? project.generate.includeHeader,
          includeFooter: screen.include?.footer ?? project.generate.includeFooter
        }

        // Phase one: analyse the pixels and, if asked, prepare a readable copy.
        const prepared = prepareWireframe(image, perScreen)

        // Phase two: read the words. This is the slow part, so the spine says so.
        let words: OcrWord[] = []
        if (prepared.ocrInput) {
          mark('reading')
          await new Promise((resolve) => requestAnimationFrame(resolve))
          try {
            const scale = prepared.ocrScale || 1
            const rescale = (list: OcrWord[]): OcrWord[] =>
              list
                .filter((word) => word.confidence >= 40)
                .map((word) => ({
                  ...word,
                  x: word.x / scale,
                  y: word.y / scale,
                  w: word.w / scale,
                  h: word.h / scale
                }))

            const read = await api.ocr.recognize(prepared.ocrInput)
            words = rescale(read.words)

            // A light screen with dark bars or buttons gets a second, inverted
            // pass; the words inside those blocks are invisible to the first.
            if (prepared.ocrInputInverted) {
              const inverted = await api.ocr.recognize(prepared.ocrInputInverted)
              words = mergeWords(words, rescale(inverted.words))
            }
          } catch {
            // Text capture failed; the wireframe is still worth drawing.
            words = []
          }
          mark('drawing')
        }

        const result = finishWireframe(prepared, words, perScreen)
        const base64 = result.dataUrl.split(',')[1]
        const file = await api.wireframes.write(project.id, screen.moduleId, screen.id, base64)

        wireframes[screen.id] = {
          screenId: screen.id,
          file,
          width: result.width,
          height: result.height,
          regions: result.regions,
          generatedAt: new Date().toISOString(),
          settings: { ...perScreen },
          terminal: result.terminal,
          text: result.text,
          title: result.title,
          actions: result.actions,
          fields: result.fields
        }
        if (wireframeUrls[screen.id]) URL.revokeObjectURL(wireframeUrls[screen.id])
        wireframeUrls[screen.id] = blobUrl(base64)
      } catch {
        failures += 1
      }
    }

    // The reader holds a worker thread; let it go once the run is done.
    void api.ocr.shutdown()

    const withWireframes: Project = { ...project, wireframes }
    const flow = draftFlow(withWireframes)
    const next: Project = { ...withWireframes, flow }

    set({
      project: next,
      wireframeUrls,
      generation: {
        active: false,
        done: queue.length,
        total: queue.length,
        currentScreenId: null,
        progress: 1,
        stage: 'drawing'
      }
    })
    await api.projects.save(next)

    get().notify(
      failures
        ? `Wireframed ${queue.length - failures} of ${queue.length} screens. ${failures} could not be read.`
        : `Wireframed ${queue.length} screen${queue.length === 1 ? '' : 's'} and drafted the flow.`,
      failures ? 'error' : 'info'
    )
  },

  // ----------------------------------------------------------- per screen

  setScreenTitle: (screenId, title) => {
    const project = get().project
    if (!project) return
    const trimmed = title.trim()
    const screens = project.screens.map((screen) =>
      screen.id === screenId ? { ...screen, title: trimmed || undefined } : screen
    )
    // The panel and the canvas are two editors of one name; keep them in step.
    const label = trimmed || screenName({ ...project, screens }, screenId)
    const nodes = project.flow.nodes.map((node) =>
      node.screenId === screenId ? { ...node, label } : node
    )
    set({ project: { ...project, screens, flow: { ...project.flow, nodes } } })
    scheduleSave(get)
  },

  setScreenGoal: (screenId, goal) => {
    const project = get().project
    if (!project) return
    const trimmed = goal.trim()
    const screens = project.screens.map((screen) =>
      screen.id === screenId ? { ...screen, goal: trimmed || undefined } : screen
    )
    set({ project: { ...project, screens } })
    scheduleSave(get)
  },

  setFieldName: (screenId, key, name) => {
    const project = get().project
    if (!project) return
    const trimmed = name.trim()
    const screens = project.screens.map((screen) => {
      if (screen.id !== screenId) return screen
      const fieldNames = { ...(screen.fieldNames ?? {}) }
      if (trimmed) fieldNames[key] = trimmed
      else delete fieldNames[key]
      return { ...screen, fieldNames: Object.keys(fieldNames).length ? fieldNames : undefined }
    })
    // `Wireframe.fields` stays exactly as the engine derived it; the rename is
    // applied on the way out by `screenFields`. That is what lets clearing a
    // rename fall back to the derived name without a redraw.
    set({ project: { ...project, screens } })
    scheduleSave(get)
  },

  setScreenInclude: (screenId, part, value) => {
    const project = get().project
    if (!project) return
    const screens = project.screens.map((screen) => {
      if (screen.id !== screenId) return screen
      const include = { ...(screen.include ?? {}) }
      if (value === undefined) delete include[part]
      else include[part] = value
      return { ...screen, include: Object.keys(include).length ? include : undefined }
    })
    set({ project: { ...project, screens } })
    scheduleSave(get)
  },

  improveNames: async (scope) => {
    const state = get()
    const project = state.project
    if (!project || state.namingBusy) return

    const provider = state.settings.activeProvider
    const model = state.settings.providers[provider].model
    if (!model) {
      get().notify('Pick a model in Settings first — naming asks the model you chose.', 'error')
      return
    }

    const screens = (
      scope === 'selected'
        ? project.screens.filter((screen) => screen.id === state.selectedScreenId)
        : project.screens
    ).filter((screen) => project.wireframes[screen.id])
    if (!screens.length) {
      get().notify('Generate a wireframe first — there is nothing to name yet.', 'error')
      return
    }

    // What the heuristics already worked out. The model is being asked to
    // improve on this, not to invent it from nothing.
    const brief = screens.map((screen) => ({
      screenId: screen.id,
      currentName: screenName(project, screen.id),
      fields: screenFields(project, screen.id).map((field) => ({ key: field.key, name: field.name })),
      text: (project.wireframes[screen.id]?.text ?? '').split('\n').slice(0, 30).join(' | ').slice(0, 1200)
    }))

    set({ namingBusy: true })
    try {
      const response = await api.ai.complete({
        requestId: `name_${Math.random().toString(36).slice(2)}`,
        provider,
        model,
        messages: [
          {
            role: 'system',
            content:
              'You name screens and form fields for a wireframing tool. ' +
              'You are given what was read off each screen and the names already derived from it. ' +
              'Reply with JSON only — no prose, no code fence — shaped as ' +
              '{"screens":[{"screenId":"...","name":"...","goal":"..."}],' +
              '"fields":[{"screenId":"...","key":"...","name":"..."}]}. ' +
              'Keep names short and human. Fix words recognition got wrong. ' +
              'Use only the screenIds and field keys given to you. Omit anything you would not change.'
          },
          { role: 'user', content: JSON.stringify(brief) }
        ]
      })

      if (response.error) {
        get().notify(`The model could not be reached: ${response.error}`, 'error')
        return
      }

      const parsed = parseNaming(response.text)
      if (!parsed) {
        get().notify('The model did not answer with usable JSON, so the derived names stand.', 'error')
        return
      }

      // Anything naming a screen or a key that does not exist is dropped in
      // silence; a bad suggestion must never be able to break the project.
      const known = new Set(screens.map((screen) => screen.id))
      let applied = 0
      for (const item of parsed.screens) {
        if (!known.has(item.screenId)) continue
        if (item.name?.trim()) {
          get().setScreenTitle(item.screenId, item.name.trim().slice(0, 60))
          applied += 1
        }
        if (item.goal?.trim()) {
          get().setScreenGoal(item.screenId, item.goal.trim().slice(0, 120))
          applied += 1
        }
      }
      for (const item of parsed.fields) {
        const current = get().project
        if (!current || !known.has(item.screenId) || !item.name?.trim()) continue
        const keys = new Set(screenFields(current, item.screenId).map((field) => field.key))
        if (!keys.has(item.key)) continue
        get().setFieldName(item.screenId, item.key, item.name.trim().slice(0, 60))
        applied += 1
      }

      get().notify(
        applied
          ? `The model improved ${applied} name${applied === 1 ? '' : 's'}. Every one is still editable.`
          : 'The model had nothing to add — the derived names stand.'
      )
    } finally {
      set({ namingBusy: false })
    }
  },

  // ---------------------------------------------------------------- flow
  setView: (view) => set({ view }),

  setFlowScope: (scope) => set({ flowScope: scope }),

  applyDraftFlow: () => {
    const project = get().project
    if (!project) return
    pushFlowHistory(get, set)
    set({ project: { ...project, flow: draftFlow(project) } })
    scheduleSave(get)
  },

  setNodePosition: (nodeId, x, y) => {
    const project = get().project
    if (!project) return
    pushFlowHistory(get, set)
    const nodes = project.flow.nodes.map((node) => (node.id === nodeId ? { ...node, x, y } : node))
    set({ project: { ...project, flow: { ...project.flow, nodes } } })
    scheduleSave(get)
  },

  setNodeLabel: (nodeId, label) => {
    const project = get().project
    if (!project) return
    const node = project.flow.nodes.find((candidate) => candidate.id === nodeId)
    // Renaming a screen node is renaming the screen. The panel edits the same
    // name from the other side, so both write through to `ScreenAsset.title`.
    if (node?.screenId) {
      get().setScreenTitle(node.screenId, label)
      return
    }
    // No history entry: this fires per keystroke, and burying a hand-drawn
    // connection under forty single-character states would make undo useless.
    // Text already has the browser's own undo inside the field.
    const nodes = project.flow.nodes.map((item) => (item.id === nodeId ? { ...item, label } : item))
    set({ project: { ...project, flow: { ...project.flow, nodes } } })
    scheduleSave(get)
  },

  setNodeBody: (nodeId, body) => {
    const project = get().project
    if (!project) return
    const nodes = project.flow.nodes.map((node) => (node.id === nodeId ? { ...node, body } : node))
    set({ project: { ...project, flow: { ...project.flow, nodes } } })
    scheduleSave(get)
  },

  setEntryNode: (nodeId) => {
    const project = get().project
    if (!project) return
    pushFlowHistory(get, set)
    const nodes = project.flow.nodes.map((node) => ({
      ...node,
      entry: node.id === nodeId && node.kind !== 'note'
    }))
    set({ project: { ...project, flow: { ...project.flow, nodes } } })
    scheduleSave(get)
  },

  connectNodes: (source, target) => {
    const project = get().project
    if (!project || source === target) return
    const nodes = project.flow.nodes
    const from = nodes.find((node) => node.id === source)
    const to = nodes.find((node) => node.id === target)
    if (!from || !to) return
    // A random id rather than one derived from the endpoints, so a second,
    // differently-labelled transition between the same two screens is possible.
    const id = `ex_${Math.random().toString(36).slice(2, 10)}`
    pushFlowHistory(get, set)
    const edge: FlowEdge = {
      id,
      source,
      target,
      trigger: 'Continues',
      crossModule: from.moduleId !== to.moduleId,
      manual: true
    }
    set({ project: { ...project, flow: { ...project.flow, edges: [...project.flow.edges, edge] } } })
    scheduleSave(get)
  },

  reconnectEdge: (edgeId, source, target) => {
    const project = get().project
    if (!project || source === target) return
    const nodes = project.flow.nodes
    const from = nodes.find((node) => node.id === source)
    const to = nodes.find((node) => node.id === target)
    if (!from || !to) return
    pushFlowHistory(get, set)
    // The id is kept, so a renamed trigger stays with the transition. Marking it
    // manual is what stops the next draft re-deriving the old endpoints.
    const edges = project.flow.edges.map((edge) =>
      edge.id === edgeId
        ? { ...edge, source, target, crossModule: from.moduleId !== to.moduleId, manual: true }
        : edge
    )
    set({ project: { ...project, flow: { ...project.flow, edges } } })
    scheduleSave(get)
  },

  setEdgeTrigger: (edgeId, trigger) => {
    const project = get().project
    if (!project) return
    pushFlowHistory(get, set)
    const edges = project.flow.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, trigger } : edge
    )
    set({ project: { ...project, flow: { ...project.flow, edges } } })
    scheduleSave(get)
  },

  removeEdge: (edgeId) => {
    const project = get().project
    if (!project) return
    pushFlowHistory(get, set)
    const edges = project.flow.edges.filter((edge) => edge.id !== edgeId)
    set({ project: { ...project, flow: { ...project.flow, edges } } })
    scheduleSave(get)
  },

  addFlowNode: (kind, x, y) => {
    const project = get().project
    if (!project) return
    const moduleId = get().activeModuleId ?? sortedModules(project)[0]?.id
    if (!moduleId) return
    pushFlowHistory(get, set)
    const node: FlowNode = {
      id: `nx_${Math.random().toString(36).slice(2, 10)}`,
      moduleId,
      label: kind === 'note' ? 'Note' : 'New screen',
      x,
      y,
      kind,
      body: kind === 'note' ? '' : undefined
    }
    set({ project: { ...project, flow: { ...project.flow, nodes: [...project.flow.nodes, node] } } })
    scheduleSave(get)
  },

  removeFlowNodes: (nodeIds) => {
    const project = get().project
    if (!project) return
    // A screen-backed node comes straight back on the next draft, so removing it
    // here would be a lie. Screens are deleted in the source panel.
    const doomed = new Set(
      project.flow.nodes.filter((node) => nodeIds.includes(node.id) && !node.screenId).map((n) => n.id)
    )
    if (!doomed.size) return
    pushFlowHistory(get, set)
    const nodes = project.flow.nodes.filter((node) => !doomed.has(node.id))
    const edges = project.flow.edges.filter(
      (edge) => !doomed.has(edge.source) && !doomed.has(edge.target)
    )
    set({ project: { ...project, flow: { nodes, edges } } })
    scheduleSave(get)
  },

  undoFlow: () => {
    const project = get().project
    const { past, future } = get().flowHistory
    if (!project || !past.length) return
    const previous = past[past.length - 1]
    set({
      project: { ...project, flow: previous },
      flowHistory: {
        past: past.slice(0, -1),
        future: [{ nodes: project.flow.nodes, edges: project.flow.edges }, ...future].slice(
          0,
          FLOW_HISTORY_LIMIT
        )
      }
    })
    // An undo that only restored memory would leave the disk holding the edit.
    scheduleSave(get)
  },

  redoFlow: () => {
    const project = get().project
    const { past, future } = get().flowHistory
    if (!project || !future.length) return
    const next = future[0]
    set({
      project: { ...project, flow: next },
      flowHistory: {
        past: [...past, { nodes: project.flow.nodes, edges: project.flow.edges }].slice(
          -FLOW_HISTORY_LIMIT
        ),
        future: future.slice(1)
      }
    })
    scheduleSave(get)
  },

  // ------------------------------------------------------------------ ai
  refreshProviders: async () => {
    const providers = await api.ai.probe()
    set({ providers })

    // Pick a sensible default model the first time a provider is seen.
    const settings = get().settings
    const ollama = providers.find((provider) => provider.id === 'ollama')
    if (ollama?.reachable && !settings.providers.ollama.model && ollama.models.length) {
      const next: AppSettings = {
        ...settings,
        providers: {
          ...settings.providers,
          ollama: {
            ...settings.providers.ollama,
            model: ollama.visionModels[0] ?? ollama.models[0]
          }
        }
      }
      await get().saveSettings(next)
    }
  },

  saveSettings: async (next) => set({ settings: await api.settings.set(next) }),

  saveApiKey: async (provider, key) => {
    try {
      await api.settings.setKey(provider, key)
      set({ settings: await api.settings.get() })
      await get().refreshProviders()
      get().notify(key ? 'Key saved to your keychain.' : 'Key removed.')
    } catch (error) {
      get().notify(error instanceof Error ? error.message : String(error), 'error')
    }
  },

  sendChat: async (text, attachScreens) => {
    const state = get()
    const project = state.project
    if (!project || !text.trim() || state.chatBusy) return

    const provider = state.settings.activeProvider
    const model = state.settings.providers[provider].model
    if (!model) {
      get().notify('Pick a model in Settings before sending.', 'error')
      return
    }

    const now = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: `m_${now}_u`,
      role: 'user',
      content: text.trim(),
      at: now,
      provider,
      model,
      attachments: attachScreens && state.selectedScreenId ? [state.selectedScreenId] : []
    }
    const assistantMessage: ChatMessage = {
      id: `m_${now}_a`,
      role: 'assistant',
      content: '',
      at: now,
      provider,
      model
    }

    const withUser: Project = { ...project, chat: [...project.chat, userMessage, assistantMessage] }
    const requestId = `req_${Math.random().toString(36).slice(2)}`
    set({ project: withUser, chatBusy: true, chatRequestId: requestId })

    const system =
      'You are FlowFrame, a product design assistant working inside a wireframing app. ' +
      'You are given the screens of a product and how a user moves between them. ' +
      'Answer about the flow: gaps, dead ends, missing states, the order of steps, and copy on the screens. ' +
      'Be concrete and short. Refer to screens by the names given below.\n\n' +
      flowContext(project, state.flowScope === 'module' ? (state.activeModuleId ?? undefined) : undefined)

    const history = project.chat
      .filter((message) => message.content && !message.error)
      .slice(-8)
      .map((message) => ({ role: message.role, content: message.content }))

    let images: string[] | undefined
    if (attachScreens && state.selectedScreenId) {
      const status = state.providers.find((candidate) => candidate.id === provider)
      const canSee = status ? status.visionModels.includes(model) : false
      const screen = project.screens.find((item) => item.id === state.selectedScreenId)
      if (screen && canSee) {
        try {
          images = [await api.assets.read(project.id, screen.file)]
        } catch {
          images = undefined
        }
      } else if (screen && !canSee) {
        get().notify(
          `${model} cannot read images, so the screenshot was left off. The question still goes through with the flow description.`
        )
      }
    }

    const unsubscribe = api.ai.onChunk((chunk) => {
      if (chunk.requestId !== requestId) return
      const current = get().project
      if (!current) return

      if (chunk.delta) {
        const chat = current.chat.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: message.content + chunk.delta }
            : message
        )
        set({ project: { ...current, chat } })
      }

      if (chunk.done) {
        const finished = get().project
        if (finished) {
          const chat = finished.chat.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  content: chunk.error ? chunk.error : message.content,
                  error: Boolean(chunk.error)
                }
              : message
          )
          const next = { ...finished, chat }
          set({ project: next, chatBusy: false, chatRequestId: null })
          void api.projects.save(next)
        } else {
          set({ chatBusy: false, chatRequestId: null })
        }
        unsubscribe()
      }
    })

    await api.ai.chat({
      requestId,
      provider,
      model,
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text.trim() }],
      images
    })
  },

  stopChat: () => {
    const requestId = get().chatRequestId
    if (requestId) void api.ai.cancel(requestId)
  },

  clearChat: () => {
    const project = get().project
    if (!project) return
    const next = { ...project, chat: [] }
    set({ project: next })
    void api.projects.save(next)
  },

  notify: (text, tone = 'info') => {
    set({ toast: { text, tone } })
    setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null })
    }, 4200)
  },

  dismissToast: () => set({ toast: null })
}))

/** Moves a screen's files into its new module folder, so disk matches the app. */
async function relocateFiles(
  screenId: string,
  moduleId: string,
  set: (partial: Partial<Store>) => void,
  get: () => Store
): Promise<void> {
  const current = get().project
  const screen = current?.screens.find((item) => item.id === screenId)
  if (!current || !screen) return

  const file = await api.assets.move(current.id, screen.file, moduleId)
  const wireframe = current.wireframes[screenId]
  const wireframeFile = wireframe ? await api.assets.move(current.id, wireframe.file, moduleId) : null

  const latest = get().project
  if (!latest) return
  const next: Project = {
    ...latest,
    screens: latest.screens.map((item) => (item.id === screenId ? { ...item, file } : item)),
    wireframes: wireframeFile
      ? { ...latest.wireframes, [screenId]: { ...latest.wireframes[screenId], file: wireframeFile } }
      : latest.wireframes
  }
  set({ project: next })
  await api.projects.save(next)
}

async function ingest(
  imported: { id: string; file: string; name: string }[],
  moduleId: string | null,
  set: (partial: Partial<Store>) => void,
  get: () => Store
): Promise<void> {
  const project = get().project
  if (!project || !imported.length) return

  const targetModule = project.modules.find((module) => module.id === moduleId) ?? sortedModules(project)[0]
  if (!targetModule) return

  const sourceUrls = { ...get().sourceUrls }
  const screens: ScreenAsset[] = [...project.screens]
  let order = screensInModule(project, targetModule.id).length
  let added = 0

  for (const item of imported) {
    try {
      const base64 = await api.assets.read(project.id, item.file)
      const url = blobUrl(base64, mimeFor(item.file))
      const image = await loadImage(url)
      sourceUrls[item.id] = url
      screens.push({
        id: item.id,
        name: item.name,
        moduleId: targetModule.id,
        file: item.file,
        width: image.naturalWidth,
        height: image.naturalHeight,
        addedAt: new Date().toISOString(),
        order: order++
      })
      added += 1
    } catch {
      // Unreadable file — leave it out rather than adding a broken screen.
    }
  }

  const next: Project = { ...project, screens }
  set({
    project: next,
    sourceUrls,
    activeModuleId: targetModule.id,
    selectedScreenId: get().selectedScreenId ?? screens[0]?.id ?? null
  })
  await api.projects.save(next)
  get().notify(`Added ${added} screen${added === 1 ? '' : 's'} to ${targetModule.name}.`)
}
