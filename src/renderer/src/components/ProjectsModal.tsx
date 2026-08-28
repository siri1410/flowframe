import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { FolderOpen, Plus, Trash2, X } from 'lucide-react'
import { useStore } from '../state/store'

interface Props {
  onClose: () => void
}

export default function ProjectsModal({ onClose }: Props): JSX.Element {
  const projects = useStore((state) => state.projects)
  const current = useStore((state) => state.project)
  const openProject = useStore((state) => state.openProject)
  const createProject = useStore((state) => state.createProject)
  const deleteProject = useStore((state) => state.deleteProject)
  const refreshProjects = useStore((state) => state.refreshProjects)

  const [name, setName] = useState('')

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Projects">
        <header>
          <h2>Projects</h2>
          <div className="spacer" />
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <div className="content">
          <div className="row">
            <span className="label">New</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="field"
                value={name}
                placeholder="Checkout redesign"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && name.trim()) {
                    void createProject(name).then(onClose)
                  }
                }}
              />
              <button
                className="btn"
                disabled={!name.trim()}
                onClick={() => void createProject(name).then(onClose)}
              >
                <Plus size={13} />
                Create
              </button>
            </div>
          </div>

          <div className="projectlist">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`projectrow ${project.id === current?.id ? 'current' : ''}`}
              >
                <div className="who">
                  <strong>{project.name}</strong>
                  <span>
                    {project.screenCount} screens · {project.wireframeCount} wireframed ·{' '}
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  className="btn small"
                  onClick={() => void openProject(project.id).then(onClose)}
                  disabled={project.id === current?.id}
                >
                  <FolderOpen size={13} />
                  Open
                </button>
                <button
                  className="btn small danger"
                  onClick={() => void deleteProject(project.id)}
                  title="Delete this project and its files"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <footer>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
