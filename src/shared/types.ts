/** Types shared by the main process, the preload bridge and the renderer. */

export type ProviderId = 'ollama' | 'openai' | 'anthropic'

export interface Module {
  id: string
  name: string
  /** Accent used for this module's band in the flow canvas. */
  color: string
  order: number
}

/** The eight accents modules cycle through, in order. */
export const MODULE_COLORS = [
  '#37C2CE',
  '#F2A65A',
  '#8C7BFF',
  '#4FBF6E',
  '#F2545B',
  '#3D9BE9',
  '#D982C6',
  '#C3B04A'
] as const

export interface ScreenAsset {
  id: string
  name: string
  /** The module (workflow) this screen belongs to. */
  moduleId: string
  /** Path relative to the project folder, e.g. `assets/scr_a1b2.png`. */
  file: string
  width: number
  height: number
  addedAt: string
  /** Order in the flow. Lower renders first. */
  order: number

  // The fields below are the user's own edits. Generation never writes them,
  // which is what makes them survive a redraw: `Wireframe` records are replaced
  // wholesale on every run, `ScreenAsset` records are not.

  /** The user's own name for this screen. Beats the title read off the pixels. */
  title?: string
  /** What the user is trying to achieve here. Suggested from the primary action. */
  goal?: string
  /** Renames for fields, keyed by `NamedField.key`. */
  fieldNames?: Record<string, string>
  /** Per-screen override of the header/footer scope. undefined = inherit. */
  include?: { header?: boolean; footer?: boolean }
}

/**
 * A control paired with the label that names it.
 *
 * Derived, so it lives on the wireframe and is recomputed on every run. The
 * user's renames live on `ScreenAsset.fieldNames` and are re-applied after each
 * generation.
 */
export interface NamedField {
  /** Stable within one wireframe: `fld_<key>`, suffixed on collision. */
  id: string
  /** Human-readable, as derived: 'Userid', 'Email address'. */
  name: string
  /**
   * Normalised lookup key for the user's override: 'userid', 'emailaddress'.
   *
   * Keyed by the derived name rather than by region id because region ids are
   * positional counters — `rg_3` means something different the moment
   * segmentation shifts by one region, which would land a rename on the wrong
   * field. Keying by name means a rename orphans harmlessly when the reading
   * changes, instead of attaching itself to the wrong control.
   */
  key: string
  /** Which region kind carries the value. */
  control: 'input' | 'field'
  /** Where the name came from, so a guess can be shown as a guess. */
  from: 'label' | 'placeholder' | 'position'
  /** The box of the control itself, in wireframe coordinates. */
  x: number
  y: number
  w: number
  h: number
}

export interface Region {
  id: string
  x: number
  y: number
  w: number
  h: number
  kind: RegionKind
  /** Name of the region kind, drawn as the tag in the wireframe. */
  label?: string
  /** The words actually read out of this region, when text capture is on. */
  text?: string
}

/** One word read from the screen, in wireframe coordinates. */
export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
  confidence: number
}

/** Something a user can do from a screen, read off its own pixels. */
export interface ScreenAction {
  /** The key or control: 'F3', 'ENTER', or the button's own text. */
  key: string
  /** What it says it does: 'Exit', 'Confirm', 'Continue'. */
  label: string
  /** 0 moves the user forward, 1 is neutral, 2 goes back or cancels. */
  rank?: number
}

export type RegionKind =
  // Shapes found on graphical screens.
  | 'header'
  | 'nav'
  | 'hero'
  | 'card'
  | 'list'
  | 'input'
  | 'button'
  | 'image'
  | 'text'
  | 'footer'
  | 'block'
  // Shapes found on 3270 / 5250 terminal screens.
  | 'title'
  | 'label'
  | 'field'
  | 'table'
  | 'fkeys'
  | 'message'

export interface GenerateSettings {
  /** 0 = loose sketch, 1 = faithful trace. */
  fidelity: number
  /** Edge-detection threshold, 0..255. */
  threshold: number
  /** Draw inferred region boxes on top of the traced edges. */
  showRegions: boolean
  /** Label region boxes with their inferred kind. */
  labelRegions: boolean
  /** Draw the classic crossbox over image placeholders. */
  crossboxes: boolean
  /** Invert to white-on-dark blueprint output. */
  blueprint: boolean
  /** Read the words off each screen and keep them with the wireframe. */
  readText: boolean
  /** Include the header bar in the drawing, the spec and the model context. */
  includeHeader: boolean
  /** Include the footer bar in the same three places. */
  includeFooter: boolean
}

export const DEFAULT_GENERATE_SETTINGS: GenerateSettings = {
  fidelity: 0.55,
  threshold: 42,
  showRegions: true,
  labelRegions: true,
  crossboxes: true,
  blueprint: false,
  readText: true,
  includeHeader: true,
  includeFooter: true
}

export interface Wireframe {
  screenId: string
  /** Path relative to the project folder, e.g. `wireframes/<module>/scr_a1b2.png`. */
  file: string
  width: number
  height: number
  regions: Region[]
  generatedAt: string
  settings: GenerateSettings
  /** True when the source was recognised as a 3270 / 5250 terminal screen. */
  terminal?: boolean
  /** Everything read off the screen, line by line, when text capture is on. */
  text?: string
  /** The screen's own title line, when one was found. */
  title?: string
  /** Keys and buttons that move the user somewhere else. */
  actions?: ScreenAction[]
  /** Entry controls paired with the labels that name them. */
  fields?: NamedField[]
}

export interface FlowNode {
  id: string
  /** Absent on a note, or on a screen that does not exist yet. */
  screenId?: string
  moduleId: string
  label: string
  x: number
  y: number
  /** Marks the screen a user lands on first. */
  entry?: boolean
  /** Absent means 'screen', so projects written before notes existed load unchanged. */
  kind?: FlowNodeKind
  /** The body of a note node. */
  body?: string
}

/**
 * `screen` is backed by a screenshot and is re-derived on every draft. `note`
 * and `stub` are drawn by hand: a note is a remark on the canvas, a stub is a
 * screen the product needs but nobody has designed yet.
 */
export type FlowNodeKind = 'screen' | 'note' | 'stub'

export interface FlowEdge {
  id: string
  source: string
  target: string
  /** What the user does to move between the two screens. */
  trigger: string
  /** True when the transition hands the user from one module to another. */
  crossModule?: boolean
  /** Drawn or reconnected by hand. Drafting must never re-derive over it. */
  manual?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  at: string
  provider?: ProviderId
  model?: string
  /** Screen ids the message was sent with. */
  attachments?: string[]
  error?: boolean
}

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  modules: Module[]
  screens: ScreenAsset[]
  wireframes: Record<string, Wireframe>
  flow: { nodes: FlowNode[]; edges: FlowEdge[] }
  chat: ChatMessage[]
  generate: GenerateSettings
}

export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  screenCount: number
  wireframeCount: number
  moduleCount: number
  /** Absolute path of the project folder on this machine. */
  path: string
}

export interface ProviderConfig {
  id: ProviderId
  /** Base URL. Only meaningful for ollama and openai-compatible endpoints. */
  baseUrl: string
  model: string
  /** True when a key is stored on disk. The key itself never reaches the renderer. */
  hasKey: boolean
}

export interface AppSettings {
  activeProvider: ProviderId
  providers: Record<ProviderId, ProviderConfig>
  theme: 'dark' | 'light'
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProvider: 'ollama',
  theme: 'dark',
  providers: {
    ollama: { id: 'ollama', baseUrl: 'http://localhost:11434', model: '', hasKey: false },
    openai: { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasKey: false },
    anthropic: { id: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', hasKey: false }
  }
}

export interface ProviderStatus {
  id: ProviderId
  reachable: boolean
  models: string[]
  /** Subset of `models` that can read an image. Only these can be sent a screenshot. */
  visionModels: string[]
  detail: string
}

/** Cloud model ids that read images. Used when the endpoint will not tell us. */
export const VISION_MODEL_PATTERN =
  /gpt-4o|gpt-4\.1|gpt-5|o[34]|claude-(?:3|4|5|opus|sonnet|haiku)|gemini|llava|bakllava|moondream|gemma3|gemma4|vision|-vl|minicpm|pixtral|internvl/i

export interface ChatRequest {
  requestId: string
  provider: ProviderId
  model: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  /** Bare base64 PNG payloads (no data: prefix) sent alongside the last user message. */
  images?: string[]
}

export interface ChatChunk {
  requestId: string
  delta?: string
  done?: boolean
  error?: string
}
