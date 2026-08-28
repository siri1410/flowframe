import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@xyflow/react/dist/style.css'
import './styles/app.css'
import App from './App'
import { toMarkdownSpec } from './lib/flow'
import { toPrototypeHtml } from './lib/prototype'
import { finishWireframe, loadImage, prepareWireframe } from './lib/wireframe'
import { useStore } from './state/store'

// Automation hook. The file picker and the save dialog are native, so end-to-end
// tests inject paths through the store and render the spec directly, then drive
// the rest of the app through its real UI.
;(window as unknown as { __flowframe?: unknown }).__flowframe = {
  store: useStore,
  spec: toMarkdownSpec,
  prototype: toPrototypeHtml,
  engine: { prepareWireframe, finishWireframe, loadImage }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
