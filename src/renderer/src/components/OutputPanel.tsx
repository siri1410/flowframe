import type { JSX } from 'react'
import { useState } from 'react'
import {
  Columns2,
  Download,
  FileText,
  Image as ImageIcon,
  MousePointerClick,
  PenLine,
  Sparkles,
  Terminal
} from 'lucide-react'
import { useStore } from '../state/store'
import { regionSummary } from '../lib/wireframe'
import { screenFields, screenGoal, toMarkdownSpec, visibleRegions } from '../lib/flow'
import { toPrototypeHtml } from '../lib/prototype'

type PreviewMode = 'wireframe' | 'source' | 'split'

export default function OutputPanel(): JSX.Element {
  const project = useStore((state) => state.project)
  const selectedScreenId = useStore((state) => state.selectedScreenId)
  const sourceUrls = useStore((state) => state.sourceUrls)
  const wireframeUrls = useStore((state) => state.wireframeUrls)
  const generate = useStore((state) => state.generate)
  const setGenerateSetting = useStore((state) => state.setGenerateSetting)
  const setScreenTitle = useStore((state) => state.setScreenTitle)
  const setScreenGoal = useStore((state) => state.setScreenGoal)
  const setFieldName = useStore((state) => state.setFieldName)
  const setScreenInclude = useStore((state) => state.setScreenInclude)
  const improveNames = useStore((state) => state.improveNames)
  const namingBusy = useStore((state) => state.namingBusy)
  const providers = useStore((state) => state.providers)
  const activeProvider = useStore((state) => state.settings.activeProvider)
  const notify = useStore((state) => state.notify)
  const generation = useStore((state) => state.generation)

  const [mode, setMode] = useState<PreviewMode>('wireframe')

  const screen = project?.screens.find((item) => item.id === selectedScreenId) ?? null
  const wireframe = screen ? project?.wireframes[screen.id] : undefined
  const settings = project?.generate
  const moduleName = project?.modules.find((module) => module.id === screen?.moduleId)?.name
  const fields = project && screen ? screenFields(project, screen.id) : []
  const goal = project && screen ? screenGoal(project, screen.id) : ''
  const shown = project && wireframe ? visibleRegions(project, screen?.id, wireframe.regions) : []
  // Naming is heuristics first; the model is an optional second opinion, so the
  // button only exists when there is a model to ask.
  const modelReachable = providers.some(
    (candidate) => candidate.id === activeProvider && candidate.reachable
  )

  const exportImages = async (): Promise<void> => {
    if (!project) return
    const files = Object.values(project.wireframes).map((item) => {
      const source = project.screens.find((candidate) => candidate.id === item.screenId)
      const module = project.modules.find((candidate) => candidate.id === source?.moduleId)
      const base = (source?.name ?? item.screenId).replace(/\.[a-z0-9]+$/i, '')
      const step = source ? String(source.order + 1).padStart(2, '0') : '00'
      return {
        file: item.file,
        name: `${step}-${base}.wireframe.png`,
        module: module?.name ?? 'module'
      }
    })
    if (!files.length) {
      notify('Generate a wireframe first, then it can be exported.', 'error')
      return
    }
    const result = await window.flowframe.wireframes.export(project.id, files)
    if (result.written) notify(`Exported ${result.written} wireframes into ${result.dir}, one folder per module.`)
  }

  const exportPrototype = async (): Promise<void> => {
    if (!project) return
    if (!Object.keys(project.wireframes).length) {
      notify('Generate the wireframes first — the prototype is built from them.', 'error')
      return
    }
    // Read the PNGs back off disk rather than out of the blob URLs: after a
    // reopen the blobs are the only copy in memory, and the file is the truth.
    const images: Record<string, string> = {}
    for (const wire of Object.values(project.wireframes)) {
      try {
        images[wire.screenId] = `data:image/png;base64,${await window.flowframe.assets.read(project.id, wire.file)}`
      } catch {
        // A missing PNG just means that screen shows a placeholder.
      }
    }
    const path = await window.flowframe.exportText(
      `${project.name.replace(/[^\w.-]+/g, '-')}-prototype.html`,
      toPrototypeHtml(project, images)
    )
    if (path) notify(`Clickable prototype saved to ${path}. Open it in any browser.`)
  }

  const exportSpec = async (): Promise<void> => {
    if (!project) return
    const path = await window.flowframe.exportText(
      `${project.name.replace(/[^\w.-]+/g, '-')}-flow.md`,
      toMarkdownSpec(project)
    )
    if (path) notify(`Flow spec saved to ${path}`)
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="label">{moduleName ?? 'Wireframe'}</span>
        {wireframe?.terminal && (
          <span className="chip terminal" title="Recognised as a 3270 / 5250 terminal screen">
            <Terminal size={11} />
            terminal
          </span>
        )}
        <div className="viewtabs" role="group" aria-label="Preview mode">
          <button aria-pressed={mode === 'wireframe'} onClick={() => setMode('wireframe')}>
            <PenLine size={12} />
            Wireframe
          </button>
          <button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
            <ImageIcon size={12} />
            Original
          </button>
          <button aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
            <Columns2 size={12} />
            Side by side
          </button>
        </div>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => void exportImages()}>
          <Download size={13} />
          Export PNGs
        </button>
        <button className="btn ghost small" onClick={() => void exportSpec()}>
          <FileText size={13} />
          Export spec
        </button>
        <button
          className="btn ghost small"
          onClick={() => void exportPrototype()}
          title="One self-contained HTML file: every screen, clickable"
        >
          <MousePointerClick size={13} />
          Prototype
        </button>
      </div>

      <div className="panel-body">
        {!screen ? (
          <div className="empty">
            <h3>Nothing selected yet</h3>
            <p>
              Add screenshots on the left, then hit Generate on the spine. The wireframe for whichever
              screen you pick shows up here.
            </p>
          </div>
        ) : !wireframe && mode === 'wireframe' ? (
          <div className="empty">
            <h3>{screen.name} is not wireframed yet</h3>
            <p>Press Generate on the centre spine, or Cmd/Ctrl+Enter, to draw every screen in the set.</p>
            <button className="btn" onClick={() => void generate('selected')} disabled={generation.active}>
              Draw just this screen
            </button>
          </div>
        ) : (
          <div className="artboard">
            {mode === 'split' ? (
              <div className="compare">
                <figure>
                  <img src={sourceUrls[screen.id]} alt={`${screen.name} original`} />
                  <figcaption>Original</figcaption>
                </figure>
                <figure>
                  {wireframe ? (
                    <img src={wireframeUrls[screen.id]} alt={`${screen.name} wireframe`} />
                  ) : (
                    <div className="empty">
                      <p>Not generated yet.</p>
                    </div>
                  )}
                  <figcaption>Wireframe</figcaption>
                </figure>
              </div>
            ) : mode === 'source' ? (
              <img src={sourceUrls[screen.id]} alt={screen.name} />
            ) : (
              <img src={wireframeUrls[screen.id]} alt={`${screen.name} wireframe`} />
            )}
          </div>
        )}
      </div>

      {screen && (
        <div className="screenmeta">
          <div className="row">
            <label className="named">
              <span className="label">Screen name</span>
              <input
                className="field"
                value={screen.title ?? wireframe?.title ?? ''}
                placeholder={wireframe?.title || screen.name}
                aria-label="Screen name"
                onChange={(event) => setScreenTitle(screen.id, event.target.value)}
              />
            </label>
            <label className="named grow">
              <span className="label">Goal</span>
              <input
                className="field"
                value={screen.goal ?? ''}
                placeholder={goal || 'What is the user trying to do here?'}
                aria-label="Screen goal"
                onChange={(event) => setScreenGoal(screen.id, event.target.value)}
              />
            </label>
            {modelReachable && wireframe && (
            <button
              className="btn ghost small"
              onClick={() => void improveNames('all')}
              disabled={namingBusy}
              title="Ask the configured model to tidy up the names it can improve"
            >
              <Sparkles size={12} />
              {namingBusy ? 'Naming…' : 'Improve names'}
            </button>
            )}
          </div>

          {fields.length > 0 && (
            <div className="fields">
              <span className="label">
                {fields.length} field{fields.length === 1 ? '' : 's'}
              </span>
              <ul>
                {fields.map((field) => (
                  <li key={field.key}>
                    <input
                      className="field"
                      value={screen.fieldNames?.[field.key] ?? field.name}
                      aria-label={`Name of field ${field.key}`}
                      onChange={(event) => setFieldName(screen.id, field.key, event.target.value)}
                    />
                    {/* A guess should look like a guess. */}
                    {field.from !== 'label' && (
                      <span className="hint">
                        {field.from === 'position' ? 'unnamed' : 'from the control'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {settings && (
        <div className="tuner">
          <div className="group">
            <span className="label">Fidelity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.fidelity}
              aria-label="Fidelity"
              onChange={(event) => setGenerateSetting('fidelity', Number(event.target.value))}
            />
          </div>
          <div className="group">
            <span className="label">Detail</span>
            <input
              type="range"
              min={8}
              max={120}
              step={2}
              value={settings.threshold}
              aria-label="Edge threshold"
              onChange={(event) => setGenerateSetting('threshold', Number(event.target.value))}
            />
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.showRegions}
              onChange={(event) => setGenerateSetting('showRegions', event.target.checked)}
            />
            Regions
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.labelRegions}
              onChange={(event) => setGenerateSetting('labelRegions', event.target.checked)}
            />
            Labels
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.crossboxes}
              onChange={(event) => setGenerateSetting('crossboxes', event.target.checked)}
            />
            Crossboxes
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.blueprint}
              onChange={(event) => setGenerateSetting('blueprint', event.target.checked)}
            />
            Blueprint
          </label>
          <label className="toggle" title="Read the words off each screen and keep them with the wireframe">
            <input
              type="checkbox"
              checked={settings.readText}
              onChange={(event) => setGenerateSetting('readText', event.target.checked)}
            />
            Read text
          </label>

          {/* The project default. A screen can opt out of it below. */}
          <label className="toggle" title="Include the header bar in the wireframe, the spec and the prototype">
            <input
              type="checkbox"
              checked={settings.includeHeader}
              onChange={(event) => setGenerateSetting('includeHeader', event.target.checked)}
            />
            Header
          </label>
          <label className="toggle" title="Include the footer bar in the wireframe, the spec and the prototype">
            <input
              type="checkbox"
              checked={settings.includeFooter}
              onChange={(event) => setGenerateSetting('includeFooter', event.target.checked)}
            />
            Footer
          </label>

          {screen && (
            <div className="group perscreen" title="Override the project default for this screen alone">
              <span className="label">This screen</span>
              <select
                className="field"
                aria-label="Header on this screen"
                value={String(screen.include?.header ?? 'inherit')}
                onChange={(event) =>
                  setScreenInclude(
                    screen.id,
                    'header',
                    event.target.value === 'inherit' ? undefined : event.target.value === 'true'
                  )
                }
              >
                <option value="inherit">Header: default</option>
                <option value="true">Header: include</option>
                <option value="false">Header: exclude</option>
              </select>
              <select
                className="field"
                aria-label="Footer on this screen"
                value={String(screen.include?.footer ?? 'inherit')}
                onChange={(event) =>
                  setScreenInclude(
                    screen.id,
                    'footer',
                    event.target.value === 'inherit' ? undefined : event.target.value === 'true'
                  )
                }
              >
                <option value="inherit">Footer: default</option>
                <option value="true">Footer: include</option>
                <option value="false">Footer: exclude</option>
              </select>
            </div>
          )}

          <div className="spacer" />
          {wireframe && <span className="label">{regionSummary(shown)}</span>}
          {wireframe?.actions?.length ? (
            <span className="label" title="What a user can do from this screen">
              · {wireframe.actions.map((action) => action.key).join(' ')}
            </span>
          ) : null}
          <button
            className="btn small"
            onClick={() => void generate('selected')}
            disabled={generation.active || !screen}
          >
            Redraw this screen
          </button>
        </div>
      )}
    </section>
  )
}
