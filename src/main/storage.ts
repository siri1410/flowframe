import { app, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, Project, ProjectSummary } from '../shared/types'
import { DEFAULT_GENERATE_SETTINGS, DEFAULT_SETTINGS, MODULE_COLORS } from '../shared/types'

/**
 * Every byte FlowFrame writes lives under one folder on the user's own drive:
 *
 *   <Documents>/FlowFrame/
 *     settings.json
 *     projects/<projectId>/project.json
 *     projects/<projectId>/assets/*        original screenshots, copied in
 *     projects/<projectId>/wireframes/*    generated output
 *
 * `app.getPath('documents')` resolves per platform, so the same code lands in
 * C:\Users\<you>\Documents on Windows and ~/Documents on macOS and Linux.
 */
export function rootDir(): string {
  // Automated runs point this at a throwaway folder so tests never touch real work.
  const override = process.env.FLOWFRAME_DATA_DIR
  if (override) return override
  return path.join(app.getPath('documents'), 'FlowFrame')
}

export function projectsDir(): string {
  return path.join(rootDir(), 'projects')
}

export function projectDir(projectId: string): string {
  return path.join(projectsDir(), projectId)
}

function settingsFile(): string {
  return path.join(rootDir(), 'settings.json')
}

/** Rejects any path that tries to escape the project folder. */
function safeJoin(base: string, relative: string): string {
  const resolved = path.resolve(base, relative)
  const normalisedBase = path.resolve(base) + path.sep
  if (!resolved.startsWith(normalisedBase)) {
    throw new Error(`Refusing to touch a path outside the project folder: ${relative}`)
  }
  return resolved
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** Write to a sibling temp file then rename, so a crash mid-save cannot shred a project. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

export async function initStorage(): Promise<void> {
  await ensureDir(projectsDir())
}

// ---------------------------------------------------------------- settings

export async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      providers: { ...DEFAULT_SETTINGS.providers, ...(parsed.providers ?? {}) }
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  await writeAtomic(settingsFile(), JSON.stringify(settings, null, 2))
  return settings
}

// ---------------------------------------------------------------- projects

export function emptyProject(name: string): Project {
  const now = new Date().toISOString()
  return {
    id: newId('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    // Every project opens with one module so there is always somewhere to drop a screen.
    modules: [{ id: newId('mod'), name: 'Main flow', color: MODULE_COLORS[0], order: 0 }],
    screens: [],
    wireframes: {},
    flow: { nodes: [], edges: [] },
    chat: [],
    generate: { ...DEFAULT_GENERATE_SETTINGS }
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureDir(projectsDir())
  const entries = await fs.readdir(projectsDir(), { withFileTypes: true })
  const summaries: ProjectSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const project = await readProject(entry.name)
      summaries.push({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        screenCount: project.screens.length,
        wireframeCount: Object.keys(project.wireframes).length,
        moduleCount: project.modules.length,
        path: projectDir(entry.name)
      })
    } catch {
      // A folder without a readable project.json is not a project. Skip it.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readProject(projectId: string): Promise<Project> {
  const raw = await fs.readFile(path.join(projectDir(projectId), 'project.json'), 'utf8')
  const project = JSON.parse(raw) as Project
  project.generate = { ...DEFAULT_GENERATE_SETTINGS, ...(project.generate ?? {}) }

  // Projects written before modules existed get one, and every loose screen joins it.
  if (!project.modules?.length) {
    project.modules = [{ id: newId('mod'), name: 'Main flow', color: MODULE_COLORS[0], order: 0 }]
  }
  const fallback = project.modules[0].id
  const known = new Set(project.modules.map((module) => module.id))
  project.screens = (project.screens ?? []).map((screen) => ({
    ...screen,
    moduleId: known.has(screen.moduleId) ? screen.moduleId : fallback
  }))
  // A screen-backed node follows its screen's module. A note or a stub has no
  // screen, so it keeps the lane the user put it in — reading its moduleId off a
  // missing screen would quietly move every note to the first module on reopen.
  const screenModule = new Map(project.screens.map((screen) => [screen.id, screen.moduleId]))
  project.flow.nodes = (project.flow?.nodes ?? [])
    .filter((node) => !node.screenId || screenModule.has(node.screenId))
    .map((node) =>
      node.screenId
        ? { ...node, moduleId: screenModule.get(node.screenId) ?? fallback }
        : { ...node, moduleId: known.has(node.moduleId) ? node.moduleId : fallback }
    )
  const liveNodes = new Set(project.flow.nodes.map((node) => node.id))
  project.flow.edges = (project.flow?.edges ?? []).filter(
    (edge) => liveNodes.has(edge.source) && liveNodes.has(edge.target)
  )

  return project
}

export async function saveProject(project: Project): Promise<Project> {
  const next: Project = { ...project, updatedAt: new Date().toISOString() }
  const dir = projectDir(next.id)
  await ensureDir(path.join(dir, 'assets'))
  await ensureDir(path.join(dir, 'wireframes'))
  await writeAtomic(path.join(dir, 'project.json'), JSON.stringify(next, null, 2))
  return next
}

export async function createProject(name: string): Promise<Project> {
  return saveProject(emptyProject(name.trim() || 'Untitled flow'))
}

export async function deleteProject(projectId: string): Promise<void> {
  await fs.rm(projectDir(projectId), { recursive: true, force: true })
}

export async function revealProject(projectId: string): Promise<void> {
  await shell.openPath(projectDir(projectId))
}

// ------------------------------------------------------------------ assets

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Screens live under their module's own folder, so the folder tree on disk maps
 * one-to-one onto the modules in the app:
 *
 *   assets/<moduleId>/<screenId>.png
 *   wireframes/<moduleId>/<screenId>.png
 */
export async function importAsset(
  projectId: string,
  moduleId: string,
  sourcePath: string
): Promise<{ id: string; file: string; name: string }> {
  const id = newId('scr')
  const ext = path.extname(sourcePath).toLowerCase() || '.png'
  const file = path.posix.join('assets', moduleId, `${id}${ext}`)
  const target = safeJoin(projectDir(projectId), file)
  await ensureDir(path.dirname(target))
  await fs.copyFile(sourcePath, target)
  return { id, file, name: path.basename(sourcePath) }
}

/** Same as importAsset, but for bytes dropped onto the window rather than a picked path. */
export async function importAssetBuffer(
  projectId: string,
  moduleId: string,
  name: string,
  base64: string
): Promise<{ id: string; file: string; name: string }> {
  const id = newId('scr')
  const ext = path.extname(name).toLowerCase() || '.png'
  const file = path.posix.join('assets', moduleId, `${id}${ext}`)
  const target = safeJoin(projectDir(projectId), file)
  await ensureDir(path.dirname(target))
  await writeAtomic(target, Buffer.from(base64, 'base64'))
  return { id, file, name }
}

export async function writeWireframe(
  projectId: string,
  moduleId: string,
  screenId: string,
  base64: string
): Promise<string> {
  const file = path.posix.join('wireframes', moduleId, `${screenId}.png`)
  const target = safeJoin(projectDir(projectId), file)
  await ensureDir(path.dirname(target))
  await writeAtomic(target, Buffer.from(base64, 'base64'))
  return file
}

/** Follows a screen when it is moved into another module, so disk matches the app. */
export async function moveAsset(
  projectId: string,
  relative: string,
  moduleId: string
): Promise<string> {
  const parts = relative.split('/')
  const bucket = parts[0]
  const filename = parts[parts.length - 1]
  const next = path.posix.join(bucket, moduleId, filename)
  if (next === relative) return relative

  const from = safeJoin(projectDir(projectId), relative)
  const to = safeJoin(projectDir(projectId), next)
  await ensureDir(path.dirname(to))
  try {
    await fs.rename(from, to)
  } catch {
    return relative
  }
  return next
}

export async function readAssetBase64(projectId: string, relative: string): Promise<string> {
  const target = safeJoin(projectDir(projectId), relative)
  const buffer = await fs.readFile(target)
  return buffer.toString('base64')
}

export async function removeAsset(projectId: string, relative: string): Promise<void> {
  try {
    await fs.rm(safeJoin(projectDir(projectId), relative), { force: true })
  } catch {
    // Already gone. Nothing to do.
  }
}

/** Copies every generated wireframe into a folder the user picks. */
export async function exportWireframes(
  projectId: string,
  targetDir: string,
  files: { file: string; name: string; module: string }[]
): Promise<number> {
  await ensureDir(targetDir)
  let written = 0
  for (const item of files) {
    const source = safeJoin(projectDir(projectId), item.file)
    // One folder per module, so the export reads like the flow it came from.
    const folder = path.join(targetDir, item.module.replace(/[^\w.-]+/g, '_') || 'module')
    await ensureDir(folder)
    const safeName = item.name.replace(/[^\w.-]+/g, '_')
    await fs.copyFile(source, path.join(folder, safeName))
    written += 1
  }
  return written
}

export async function writeTextFile(targetPath: string, contents: string): Promise<void> {
  await writeAtomic(targetPath, contents)
}
