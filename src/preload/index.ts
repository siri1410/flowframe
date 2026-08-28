import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  ChatChunk,
  ChatRequest,
  OcrWord,
  Project,
  ProjectSummary,
  ProviderId,
  ProviderStatus
} from '../shared/types'

/**
 * The only surface the renderer gets. No fs, no net, no ipcRenderer — every call
 * below is an explicit, typed door into the main process.
 */
const api = {
  app: {
    info: (): Promise<{ version: string; platform: string; dataDir: string }> =>
      ipcRenderer.invoke('app:info'),
    openDataDir: (): Promise<string> => ipcRenderer.invoke('app:openDataDir')
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke('settings:set', settings),
    setKey: (provider: ProviderId, key: string): Promise<boolean> =>
      ipcRenderer.invoke('settings:setKey', provider, key)
  },

  projects: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:list'),
    create: (name: string): Promise<Project> => ipcRenderer.invoke('project:create', name),
    open: (id: string): Promise<Project> => ipcRenderer.invoke('project:open', id),
    save: (project: Project): Promise<Project> => ipcRenderer.invoke('project:save', project),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('project:delete', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('project:reveal', id)
  },

  assets: {
    pick: (projectId: string, moduleId: string): Promise<{ id: string; file: string; name: string }[]> =>
      ipcRenderer.invoke('asset:pick', projectId, moduleId),
    importPaths: (
      projectId: string,
      moduleId: string,
      paths: string[]
    ): Promise<{ id: string; file: string; name: string }[]> =>
      ipcRenderer.invoke('asset:importPaths', projectId, moduleId, paths),
    importBuffers: (
      projectId: string,
      moduleId: string,
      files: { name: string; base64: string }[]
    ): Promise<{ id: string; file: string; name: string }[]> =>
      ipcRenderer.invoke('asset:importBuffers', projectId, moduleId, files),
    move: (projectId: string, file: string, moduleId: string): Promise<string> =>
      ipcRenderer.invoke('asset:move', projectId, file, moduleId),
    read: (projectId: string, file: string): Promise<string> =>
      ipcRenderer.invoke('asset:read', projectId, file),
    remove: (projectId: string, file: string): Promise<void> =>
      ipcRenderer.invoke('asset:remove', projectId, file),
    /** Resolves the on-disk path of a dropped File, so big images skip the base64 round trip. */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },

  wireframes: {
    write: (projectId: string, moduleId: string, screenId: string, base64: string): Promise<string> =>
      ipcRenderer.invoke('wireframe:write', projectId, moduleId, screenId, base64),
    export: (
      projectId: string,
      files: { file: string; name: string; module: string }[]
    ): Promise<{ written: number; dir: string }> =>
      ipcRenderer.invoke('export:wireframes', projectId, files)
  },

  ocr: {
    recognize: (
      base64: string
    ): Promise<{ text: string; words: OcrWord[]; confidence: number }> =>
      ipcRenderer.invoke('ocr:recognize', base64),
    shutdown: (): Promise<void> => ipcRenderer.invoke('ocr:shutdown')
  },

  exportText: (suggestedName: string, contents: string): Promise<string> =>
    ipcRenderer.invoke('export:text', suggestedName, contents),

  ai: {
    probe: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('ai:probe'),
    chat: (request: ChatRequest): Promise<boolean> => ipcRenderer.invoke('ai:chat', request),
    /** One answer, whole, without it joining the chat transcript. */
    complete: (request: ChatRequest): Promise<{ text: string; error?: string }> =>
      ipcRenderer.invoke('ai:complete', request),
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('ai:cancel', requestId),
    onChunk: (handler: (chunk: ChatChunk) => void): (() => void) => {
      const listener = (_event: unknown, chunk: ChatChunk): void => handler(chunk)
      ipcRenderer.on('ai:chunk', listener)
      return () => ipcRenderer.removeListener('ai:chunk', listener)
    }
  }
}

contextBridge.exposeInMainWorld('flowframe', api)

export type FlowFrameApi = typeof api
