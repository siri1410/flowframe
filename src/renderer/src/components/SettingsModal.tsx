import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import type { ProviderId } from '../../../shared/types'
import { useStore } from '../state/store'

const TITLES: Record<ProviderId, string> = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic Claude'
}

const BLURBS: Record<ProviderId, string> = {
  ollama: 'Runs entirely on this machine. Nothing leaves your drive.',
  openai: 'Any OpenAI-shaped endpoint: OpenAI, Groq, OpenRouter, vLLM, LM Studio.',
  anthropic: 'Claude models over the Anthropic API. Best at reading screenshots.'
}

interface Props {
  onClose: () => void
}

export default function SettingsModal({ onClose }: Props): JSX.Element {
  const settings = useStore((state) => state.settings)
  const providers = useStore((state) => state.providers)
  const saveSettings = useStore((state) => state.saveSettings)
  const saveApiKey = useStore((state) => state.saveApiKey)
  const refreshProviders = useStore((state) => state.refreshProviders)
  const info = useStore((state) => state.info)

  const [keys, setKeys] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    await refreshProviders()
    setChecking(false)
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <div className="spacer" />
          <button className="btn ghost small" onClick={() => void recheck()} disabled={checking}>
            <RefreshCw size={13} />
            {checking ? 'Checking…' : 'Re-check providers'}
          </button>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <div className="content">
          {(['ollama', 'openai', 'anthropic'] as ProviderId[]).map((id) => {
            const status = providers.find((provider) => provider.id === id)
            const config = settings.providers[id]
            const isActive = settings.activeProvider === id

            return (
              <div key={id} className={`provider ${isActive ? 'active' : ''}`}>
                <div className="top">
                  <input
                    type="radio"
                    name="provider"
                    checked={isActive}
                    onChange={() => void saveSettings({ ...settings, activeProvider: id })}
                    aria-label={`Use ${TITLES[id]}`}
                  />
                  <h3>{TITLES[id]}</h3>
                  <span className={`chip ${status?.reachable ? 'live' : 'down'}`}>
                    <span className="dot" />
                    {status?.reachable ? 'ready' : 'not ready'}
                  </span>
                </div>

                <p className="detail">{status?.detail ?? BLURBS[id]}</p>

                {id !== 'anthropic' && (
                  <div className="row">
                    <span className="label">Base URL</span>
                    <input
                      className="field"
                      value={config.baseUrl}
                      onChange={(event) =>
                        void saveSettings({
                          ...settings,
                          providers: {
                            ...settings.providers,
                            [id]: { ...config, baseUrl: event.target.value }
                          }
                        })
                      }
                    />
                  </div>
                )}

                <div className="row">
                  <span className="label">Model</span>
                  {status?.models.length ? (
                    <select
                      className="field"
                      value={config.model}
                      onChange={(event) =>
                        void saveSettings({
                          ...settings,
                          providers: {
                            ...settings.providers,
                            [id]: { ...config, model: event.target.value }
                          }
                        })
                      }
                    >
                      <option value="">Pick a model…</option>
                      {status.models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="field"
                      value={config.model}
                      placeholder={id === 'ollama' ? 'llama3.1:8b' : 'model id'}
                      onChange={(event) =>
                        void saveSettings({
                          ...settings,
                          providers: {
                            ...settings.providers,
                            [id]: { ...config, model: event.target.value }
                          }
                        })
                      }
                    />
                  )}
                </div>

                {id !== 'ollama' && (
                  <div className="row">
                    <span className="label">API key</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="field"
                        type="password"
                        value={keys[id] ?? ''}
                        placeholder={config.hasKey ? 'Stored in your OS keychain' : 'Paste a key'}
                        onChange={(event) => setKeys((prev) => ({ ...prev, [id]: event.target.value }))}
                      />
                      <button
                        className="btn small"
                        onClick={() => {
                          void saveApiKey(id, keys[id] ?? '')
                          setKeys((prev) => ({ ...prev, [id]: '' }))
                        }}
                      >
                        Save
                      </button>
                      {config.hasKey && (
                        <button className="btn small danger" onClick={() => void saveApiKey(id, '')}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          <div className="provider">
            <div className="top">
              <h3>Where your work lives</h3>
            </div>
            <p className="detail">
              Every project, screenshot and wireframe is a plain file in this folder. Back it up, sync
              it, or open it in any other tool.
            </p>
            <div className="row">
              <span className="label">Folder</span>
              <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
                <input className="field" readOnly value={info.dataDir} />
                <button className="btn small" onClick={() => void window.flowframe.app.openDataDir()}>
                  <FolderOpen size={13} />
                  Open
                </button>
              </div>
            </div>
            <p className="detail">
              FlowFrame {info.version} on {info.platform}
            </p>
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
