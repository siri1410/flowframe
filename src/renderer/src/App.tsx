import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import ChatDock from './components/ChatDock'
import FlowCanvas from './components/FlowCanvas'
import OutputPanel from './components/OutputPanel'
import ProjectsModal from './components/ProjectsModal'
import SettingsModal from './components/SettingsModal'
import SourcePanel from './components/SourcePanel'
import Spine from './components/Spine'
import TitleBar from './components/TitleBar'
import { useStore } from './state/store'

export default function App(): JSX.Element {
  const ready = useStore((state) => state.ready)
  const boot = useStore((state) => state.boot)
  const view = useStore((state) => state.view)
  const toast = useStore((state) => state.toast)
  const dismissToast = useStore((state) => state.dismissToast)
  const generate = useStore((state) => state.generate)

  const [showSettings, setShowSettings] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [split, setSplit] = useState(46)

  useEffect(() => {
    void boot()
  }, [boot])

  // Cmd/Ctrl+Enter generates from anywhere, the way a render shortcut should work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const tag = (event.target as HTMLElement)?.tagName
        if (tag === 'TEXTAREA') return
        event.preventDefault()
        void generate('all')
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [generate])

  if (!ready) {
    return <div className="boot">Opening your drafting table…</div>
  }

  return (
    <div className="app">
      <TitleBar onOpenSettings={() => setShowSettings(true)} onOpenProjects={() => setShowProjects(true)} />

      <div className="stage" style={{ ['--split' as string]: `${split}%` }}>
        <SourcePanel />
        <Spine onResize={setSplit} />
        {view === 'screens' ? <OutputPanel /> : <FlowCanvas />}
      </div>

      <ChatDock onOpenSettings={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showProjects && <ProjectsModal onClose={() => setShowProjects(false)} />}

      {toast && (
        <button className={`toast ${toast.tone}`} onClick={dismissToast}>
          {toast.tone === 'error' ? <AlertTriangle size={14} /> : <Check size={14} />}
          {toast.text}
        </button>
      )}
    </div>
  )
}
