import type { JSX } from 'react'
import { FolderOpen, Frame, Settings, Share2, Workflow } from 'lucide-react'
import { useStore } from '../state/store'
import Mark from './Mark'

interface Props {
  onOpenSettings: () => void
  onOpenProjects: () => void
}

export default function TitleBar({ onOpenSettings, onOpenProjects }: Props): JSX.Element {
  const project = useStore((state) => state.project)
  const platform = useStore((state) => state.info.platform)
  const view = useStore((state) => state.view)
  const setView = useStore((state) => state.setView)
  const renameProject = useStore((state) => state.renameProject)
  const revealProject = useStore((state) => state.revealProject)

  return (
    <header className={`titlebar ${platform === 'darwin' ? 'mac' : ''}`}>
      <div className="brand">
        <Mark />
        FlowFrame
      </div>

      <input
        className="project-name"
        value={project?.name ?? ''}
        aria-label="Project name"
        onChange={(event) => renameProject(event.target.value)}
      />

      <button className="btn ghost small" onClick={onOpenProjects} title="Switch project">
        <FolderOpen size={14} />
        Projects
      </button>

      <div className="spacer" />

      <div className="viewtabs" role="group" aria-label="View">
        <button aria-pressed={view === 'screens'} onClick={() => setView('screens')}>
          <Frame size={13} />
          Screens
        </button>
        <button aria-pressed={view === 'flow'} onClick={() => setView('flow')}>
          <Workflow size={13} />
          Flow
        </button>
      </div>

      <button className="btn ghost small" onClick={revealProject} title="Show the project folder on disk">
        <Share2 size={14} />
        Show files
      </button>
      <button className="btn ghost small" onClick={onOpenSettings} title="Settings (Cmd/Ctrl+,)">
        <Settings size={14} />
      </button>
    </header>
  )
}
