import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, ChatRequest, Project, ProviderId } from '../shared/types'
import * as ai from './ai'
import * as ocr from './ocr'
import * as storage from './storage'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

/**
 * The window icon, for Windows and Linux while the app is unpackaged — dev,
 * preview and the end-to-end suite. Packaged builds get theirs from
 * electron-builder, and macOS always takes its icon from the bundle. Resolved
 * from `__dirname`, because `app.getAppPath()` is `out/main` when the bundle is
 * launched directly, and returned only if it is really there.
 */
function windowIcon(): string | undefined {
  if (app.isPackaged || process.platform === 'darwin') return undefined
  const icon = path.join(__dirname, '..', '..', 'resources', 'icon.png')
  return existsSync(icon) ? icon : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: windowIcon(),
    backgroundColor: '#14161B',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: storage.rootDir()
  }))

  ipcMain.handle('app:openDataDir', () => shell.openPath(storage.rootDir()))

  // -------------------------------------------------------------- settings
  ipcMain.handle('settings:get', async () => {
    const settings = await storage.readSettings()
    for (const id of ['openai', 'anthropic'] as ProviderId[]) {
      settings.providers[id].hasKey = await ai.hasApiKey(id)
    }
    return settings
  })

  ipcMain.handle('settings:set', async (_event, settings: AppSettings) => {
    const stripped: AppSettings = structuredClone(settings)
    for (const provider of Object.values(stripped.providers)) provider.hasKey = false
    await storage.writeSettings(stripped)
    for (const id of ['openai', 'anthropic'] as ProviderId[]) {
      stripped.providers[id].hasKey = await ai.hasApiKey(id)
    }
    return stripped
  })

  ipcMain.handle('settings:setKey', async (_event, provider: ProviderId, key: string) => {
    await ai.setApiKey(provider, key)
    return ai.hasApiKey(provider)
  })

  // -------------------------------------------------------------- projects
  ipcMain.handle('project:list', () => storage.listProjects())
  ipcMain.handle('project:create', (_event, name: string) => storage.createProject(name))
  ipcMain.handle('project:open', (_event, id: string) => storage.readProject(id))
  ipcMain.handle('project:save', (_event, project: Project) => storage.saveProject(project))
  ipcMain.handle('project:delete', (_event, id: string) => storage.deleteProject(id))
  ipcMain.handle('project:reveal', (_event, id: string) => storage.revealProject(id))

  // ---------------------------------------------------------------- assets
  ipcMain.handle('asset:pick', async (_event, projectId: string, moduleId: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add screenshots',
      buttonLabel: 'Add to flow',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled) return []
    return Promise.all(
      result.filePaths
        .filter(storage.isImagePath)
        .map((file) => storage.importAsset(projectId, moduleId, file))
    )
  })

  ipcMain.handle(
    'asset:importPaths',
    async (_event, projectId: string, moduleId: string, paths: string[]) =>
      Promise.all(
        paths.filter(storage.isImagePath).map((file) => storage.importAsset(projectId, moduleId, file))
      )
  )

  ipcMain.handle(
    'asset:importBuffers',
    async (_event, projectId: string, moduleId: string, files: { name: string; base64: string }[]) =>
      Promise.all(
        files.map((file) => storage.importAssetBuffer(projectId, moduleId, file.name, file.base64))
      )
  )

  ipcMain.handle('asset:move', (_event, projectId: string, file: string, moduleId: string) =>
    storage.moveAsset(projectId, file, moduleId)
  )

  ipcMain.handle('asset:read', (_event, projectId: string, file: string) =>
    storage.readAssetBase64(projectId, file)
  )

  ipcMain.handle('asset:remove', (_event, projectId: string, file: string) =>
    storage.removeAsset(projectId, file)
  )

  ipcMain.handle(
    'wireframe:write',
    (_event, projectId: string, moduleId: string, screenId: string, base64: string) =>
      storage.writeWireframe(projectId, moduleId, screenId, base64)
  )

  // ---------------------------------------------------------------- export
  ipcMain.handle(
    'export:wireframes',
    async (_event, projectId: string, files: { file: string; name: string; module: string }[]) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose a folder for the wireframes',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return { written: 0, dir: '' }
      const written = await storage.exportWireframes(projectId, result.filePaths[0], files)
      return { written, dir: result.filePaths[0] }
    }
  )

  ipcMain.handle(
    'export:text',
    async (_event, suggestedName: string, contents: string) => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save flow spec',
        defaultPath: path.join(app.getPath('documents'), suggestedName)
      })
      if (result.canceled || !result.filePath) return ''
      await storage.writeTextFile(result.filePath, contents)
      return result.filePath
    }
  )

  // ------------------------------------------------------------------- ocr
  ipcMain.handle('ocr:recognize', (_event, base64: string) => ocr.recognize(base64))
  ipcMain.handle('ocr:shutdown', () => ocr.shutdown())

  // -------------------------------------------------------------------- ai
  ipcMain.handle('ai:probe', async () => ai.probeAll(await storage.readSettings()))

  ipcMain.handle('ai:chat', async (event, request: ChatRequest) => {
    const settings = await storage.readSettings()
    await ai.streamChat(request, settings, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', chunk)
    })
    return true
  })

  ipcMain.handle('ai:complete', async (_event, request: ChatRequest) =>
    ai.completeChat(request, await storage.readSettings())
  )

  ipcMain.handle('ai:cancel', (_event, requestId: string) => ai.cancelChat(requestId))
}

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.siri1410.flowframe')
  await storage.initStorage()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
