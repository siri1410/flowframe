import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  ImagePlus,
  MoveRight,
  Trash2,
  Upload
} from 'lucide-react'
import type { Module } from '../../../shared/types'

/** Marks a drag as "a screen being rearranged" rather than "files from the OS". */
const SCREEN_MIME = 'application/x-flowframe-screen'
import { screensInModule, sortedModules } from '../lib/flow'
import { useStore } from '../state/store'

export default function SourcePanel(): JSX.Element {
  const project = useStore((state) => state.project)
  const addModule = useStore((state) => state.addModule)
  const activeModuleId = useStore((state) => state.activeModuleId)
  const addFromFiles = useStore((state) => state.addScreensFromFiles)
  const notify = useStore((state) => state.notify)

  const [newModule, setNewModule] = useState('')

  const modules = project ? sortedModules(project) : []

  // Cmd/Ctrl+V drops whatever image is on the clipboard into the active module.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      const items = Array.from(event.clipboardData?.items ?? [])
      const files = items
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file))
      if (!files.length) return

      event.preventDefault()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const named = files.map(
        (file, index) =>
          new File([file], file.name || `pasted-${stamp}-${index + 1}.png`, { type: file.type })
      )
      void addFromFiles(named, activeModuleId ?? undefined)
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFromFiles, activeModuleId, notify])

  const create = (): void => {
    addModule(newModule)
    setNewModule('')
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="label">Modules</span>
        <span className="chip">{modules.length}</span>
        <div className="spacer" />
        <input
          className="field module-new"
          value={newModule}
          placeholder="New module, e.g. Checkout"
          onChange={(event) => setNewModule(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create()
          }}
        />
        <button className="btn small" onClick={create} title="Add a module">
          <FolderPlus size={13} />
          Add
        </button>
      </div>

      <div className="panel-body">
        {modules.map((module) => (
          <ModuleSection key={module.id} module={module} />
        ))}
        <p className="paste-hint">
          Paste a screenshot with {navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V'} to drop it
          straight into the module you have selected. Drag a thumbnail to reorder it, or onto another
          module to move it there.
        </p>
      </div>
    </section>
  )
}

function ModuleSection({ module }: { module: Module }): JSX.Element {
  const project = useStore((state) => state.project)
  const sourceUrls = useStore((state) => state.sourceUrls)
  const selectedScreenId = useStore((state) => state.selectedScreenId)
  const activeModuleId = useStore((state) => state.activeModuleId)
  const selectScreen = useStore((state) => state.selectScreen)
  const setActiveModule = useStore((state) => state.setActiveModule)
  const renameModule = useStore((state) => state.renameModule)
  const removeModule = useStore((state) => state.removeModule)
  const reorderModule = useStore((state) => state.reorderModule)
  const moveScreenToModule = useStore((state) => state.moveScreenToModule)
  const moveScreenTo = useStore((state) => state.moveScreenTo)
  const addByDialog = useStore((state) => state.addScreensByDialog)
  const addFromPaths = useStore((state) => state.addScreensFromPaths)
  const addFromFiles = useStore((state) => state.addScreensFromFiles)
  const removeScreen = useStore((state) => state.removeScreen)
  const reorderScreen = useStore((state) => state.reorderScreen)
  const generation = useStore((state) => state.generation)

  const [over, setOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragDepth = useRef(0)

  if (!project) return <></>

  const screens = screensInModule(project, module.id)
  const isActive = activeModuleId === module.id
  const otherModules = sortedModules(project).filter((item) => item.id !== module.id)

  const onDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setOver(false)
    setDropIndex(null)

    // A thumbnail dragged from anywhere in the panel lands at the end of this module.
    const draggedScreen = event.dataTransfer.getData(SCREEN_MIME)
    if (draggedScreen) {
      moveScreenTo(draggedScreen, module.id, screens.length)
      return
    }

    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return

    // Prefer the real path when Electron can give us one: no base64 round trip.
    const paths = files.map((file) => window.flowframe.assets.pathForFile(file)).filter(Boolean)
    if (paths.length === files.length) await addFromPaths(paths, module.id)
    else await addFromFiles(files, module.id)
  }

  return (
    <div
      className={`module ${isActive ? 'active' : ''} ${over ? 'over' : ''}`}
      style={{ ['--module-color' as string]: module.color }}
      onClick={() => setActiveModule(module.id)}
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1
        if (dragDepth.current <= 0) setOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="module-head">
        <span className="swatch" aria-hidden />
        <input
          className="module-name"
          value={module.name}
          aria-label="Module name"
          onChange={(event) => renameModule(module.id, event.target.value)}
        />
        <span className="label">{screens.length}</span>
        <button className="btn ghost small" onClick={() => void addByDialog(module.id)} title="Add screenshots to this module">
          <ImagePlus size={13} />
        </button>
        <button className="btn ghost small" onClick={() => reorderModule(module.id, -1)} title="Move module up">
          <ChevronLeft size={13} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button className="btn ghost small" onClick={() => reorderModule(module.id, 1)} title="Move module down">
          <ChevronRight size={13} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button
          className="btn ghost small danger"
          onClick={() => void removeModule(module.id)}
          title="Delete this module and its screens"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {screens.length === 0 ? (
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => void addByDialog(module.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') void addByDialog(module.id)
          }}
        >
          <Upload size={18} />
          <h3>Drop the {module.name} screens here</h3>
          <p>The order you add them becomes the first draft of this workflow.</p>
        </div>
      ) : (
        <div className="thumbs">
          {screens.map((screen, index) => {
            const wireframed = Boolean(project.wireframes[screen.id])
            const plotting = generation.currentScreenId === screen.id
            return (
              <div
                key={screen.id}
                className={`thumb ${plotting ? 'plotting' : ''} ${dropIndex === index ? 'dropbefore' : ''}`}
                aria-selected={selectedScreenId === screen.id}
                role="option"
                tabIndex={0}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(SCREEN_MIME, screen.id)
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(SCREEN_MIME)) return
                  event.preventDefault()
                  event.stopPropagation()
                  const box = event.currentTarget.getBoundingClientRect()
                  setDropIndex(event.clientX < box.left + box.width / 2 ? index : index + 1)
                }}
                onDragLeave={() => setDropIndex(null)}
                onDrop={(event) => {
                  const dragged = event.dataTransfer.getData(SCREEN_MIME)
                  if (!dragged) return
                  event.preventDefault()
                  event.stopPropagation()
                  moveScreenTo(dragged, module.id, dropIndex ?? index)
                  setDropIndex(null)
                }}
                onClick={() => selectScreen(screen.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') selectScreen(screen.id)
                }}
              >
                <img className="shot" src={sourceUrls[screen.id]} alt={screen.name} />
                <div className="tools">
                  <button
                    title="Earlier in this workflow"
                    onClick={(event) => {
                      event.stopPropagation()
                      reorderScreen(screen.id, -1)
                    }}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <button
                    title="Later in this workflow"
                    onClick={(event) => {
                      event.stopPropagation()
                      reorderScreen(screen.id, 1)
                    }}
                  >
                    <ChevronRight size={12} />
                  </button>
                  {otherModules.length > 0 && (
                    <select
                      className="movepicker"
                      title="Move to another module"
                      value=""
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        if (event.target.value) moveScreenToModule(screen.id, event.target.value)
                      }}
                    >
                      <option value="">→</option>
                      {otherModules.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    title="Remove this screen"
                    onClick={(event) => {
                      event.stopPropagation()
                      void removeScreen(screen.id)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="meta">
                  <span className="idx">{String(index + 1).padStart(2, '0')}</span>
                  <span className="name" title={screen.name}>
                    {screen.name}
                  </span>
                  <span
                    className={`state ${wireframed ? 'done' : ''}`}
                    title={wireframed ? 'Wireframed' : 'Not generated yet'}
                  />
                </div>
              </div>
            )
          })}
          <button className="thumb add" onClick={() => void addByDialog(module.id)}>
            <ImagePlus size={16} />
            <span>Add to {module.name}</span>
            <MoveRight size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
