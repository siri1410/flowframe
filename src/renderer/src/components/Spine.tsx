import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import { useStore } from '../state/store'

interface Props {
  onResize: (percent: number) => void
}

/**
 * The centre spine. It is the divider between source and output, the drag handle
 * that resizes them, and the Generate control — and while a run is going, a plot
 * line travels down it, passing each screen as that screen is drawn.
 */
export default function Spine({ onResize }: Props): JSX.Element {
  const generate = useStore((state) => state.generate)
  const generation = useStore((state) => state.generation)
  const project = useStore((state) => state.project)
  const activeModuleId = useStore((state) => state.activeModuleId)

  const [scope, setScope] = useState<'all' | 'module'>('all')
  const dragging = useRef(false)

  const activeModule = project?.modules.find((module) => module.id === activeModuleId)
  const moduleScreens = project?.screens.filter((screen) => screen.moduleId === activeModuleId) ?? []
  const screens = scope === 'module' ? moduleScreens.length : (project?.screens.length ?? 0)
  const wireframed =
    scope === 'module'
      ? moduleScreens.filter((screen) => Boolean(project?.wireframes[screen.id])).length
      : Object.keys(project?.wireframes ?? {}).length

  const onMove = useCallback(
    (event: MouseEvent) => {
      if (!dragging.current) return
      const percent = (event.clientX / window.innerWidth) * 100
      onResize(Math.min(70, Math.max(24, percent)))
    },
    [onResize]
  )

  useEffect(() => {
    const stop = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
    }
  }, [onMove])

  const busy = generation.active
  const plotHeight = busy ? `${Math.round(generation.progress * 100)}%` : '0%'

  return (
    <div
      className="spine"
      onMouseDown={() => {
        dragging.current = true
        document.body.style.cursor = 'col-resize'
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the split"
    >
      <div className="plot" style={{ height: plotHeight }} aria-hidden />

      <div className="spine-stack" onMouseDown={(event) => event.stopPropagation()}>
        <div className="scope" role="group" aria-label="What to generate">
          <button
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
            title="Generate every module"
          >
            All
          </button>
          <button
            aria-pressed={scope === 'module'}
            onClick={() => setScope('module')}
            title={activeModule ? `Generate only ${activeModule.name}` : 'Generate the selected module'}
            disabled={!activeModule}
          >
            Mod
          </button>
        </div>

        <button
          className={`generate ${busy ? 'busy' : ''}`}
          disabled={busy || screens === 0}
          onClick={() => void generate(scope)}
          title={
            screens === 0
              ? 'Add screenshots first'
              : scope === 'module'
                ? `Wireframe ${activeModule?.name ?? 'this module'}`
                : 'Wireframe every screen (Cmd/Ctrl+Enter)'
          }
        >
          {busy ? <Loader2 size={16} /> : <Zap size={16} />}
          <span className="word">
            {busy ? (generation.stage === 'reading' ? 'Reading' : 'Drawing') : 'Generate'}
          </span>
        </button>
      </div>

      <span className="spine-count">
        {busy ? `${generation.done}/${generation.total}` : `${wireframed}/${screens}`}
      </span>
    </div>
  )
}
