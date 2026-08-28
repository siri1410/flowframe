import type {
  GenerateSettings,
  NamedField,
  OcrWord,
  Region,
  RegionKind,
  ScreenAction
} from '../../../shared/types'

/**
 * The wireframe engine. A screenshot goes in; a traced wireframe, a list of
 * regions, the words on the screen and the actions it offers come out.
 *
 * It handles two families of screen:
 *
 *  - Graphical screens — web and native app screenshots. Layout is found from a
 *    content mask, then classified by shape, position, fill and colour.
 *  - Terminal screens — IBM 3270 and AS/400 5250 green screens. These break every
 *    assumption the graphical path makes (bright text on black, no imagery, a
 *    fixed character grid), so they get their own detection and segmentation.
 *
 * The Sobel trace is carried over from the original Wireframe-Generator project
 * (MIT, Binidu Ranasinghe); everything built on top of it is new.
 */

const MAX_WIDTH = 1280
const PAPER = '#F7F7F5'
const INK = '#12141A'
const BLUEPRINT_BG = '#101A2B'
const BLUEPRINT_INK = '#9FD2FF'

/** Terminals are read at 2x — Tesseract is much more accurate on larger glyphs. */
const OCR_SCALE = 2

export interface WireframeResult {
  dataUrl: string
  width: number
  height: number
  regions: Region[]
  terminal: boolean
  text: string
  title: string
  actions: ScreenAction[]
  fields: NamedField[]
}

// ------------------------------------------------------------------- input

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('That file could not be read as an image.'))
    image.src = src
  })
}

function scaled(image: HTMLImageElement): { width: number; height: number } {
  const ratio = Math.min(1, MAX_WIDTH / image.naturalWidth)
  return {
    width: Math.max(1, Math.round(image.naturalWidth * ratio)),
    height: Math.max(1, Math.round(image.naturalHeight * ratio))
  }
}

// ---------------------------------------------------------------- analysis

interface Analysis {
  width: number
  height: number
  /** 0..255 Sobel magnitude per pixel. */
  edges: Uint8ClampedArray
  /** 0..255 luminance per pixel. */
  gray: Uint8ClampedArray
  /** 0..255 colour spread per pixel, used to tell photos from flat UI. */
  chroma: Uint8ClampedArray
  /**
   * 1 where a pixel is content rather than page background. Layout is found from
   * this, not from the edges: a solid button or a filled header has ink through
   * its whole body, while its Sobel response is only a hairline around the rim.
   */
  mask: Uint8Array
  /** The luminance that dominates the image — the page or screen background. */
  background: number
  /**
   * Share of the bright ink that sits in a single hue. Terminal phosphor — green,
   * amber, or plain white — scores near 1; a colourful UI scores far lower.
   */
  inkHueConcentration: number
  /** The scaled source, kept so text capture can be preprocessed from it. */
  canvas: HTMLCanvasElement
}

function analyse(image: HTMLImageElement): Analysis {
  const { width, height } = scaled(image)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, width, height)

  const { data } = ctx.getImageData(0, 0, width, height)
  const gray = new Uint8ClampedArray(width * height)
  const chroma = new Uint8ClampedArray(width * height)

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    gray[p] = (r * 0.299 + g * 0.587 + b * 0.114) | 0
    chroma[p] = Math.max(r, g, b) - Math.min(r, g, b)
  }

  // Sobel.
  const edges = new Uint8ClampedArray(width * height)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const o = y * width + x
      const tl = gray[o - width - 1]
      const tc = gray[o - width]
      const tr = gray[o - width + 1]
      const ml = gray[o - 1]
      const mr = gray[o + 1]
      const bl = gray[o + width - 1]
      const bc = gray[o + width]
      const br = gray[o + width + 1]
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
      edges[o] = Math.min(255, Math.hypot(gx, gy))
    }
  }

  // The background is whatever luminance dominates the image.
  const histogram = new Uint32Array(256)
  for (const value of gray) histogram[value] += 1
  let background = 0
  for (let value = 1; value < 256; value += 1) {
    if (histogram[value] > histogram[background]) background = value
  }

  const mask = new Uint8Array(width * height)
  for (let p = 0; p < mask.length; p += 1) {
    const differs = Math.abs(gray[p] - background) > 14 || chroma[p] > 26
    mask[p] = differs || edges[p] > 90 ? 1 : 0
  }

  // Which hue the ink is. Only bright pixels are counted: the dim halo around an
  // antialiased glyph has an unstable hue and would drown out the real signal.
  // Twelve hue buckets, plus one for anything too grey to have a hue at all.
  const buckets = new Uint32Array(13)
  let counted = 0
  for (let p = 0, i = 0; p < mask.length; p += 1, i += 4) {
    if (!mask[p]) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const max = Math.max(r, g, b)
    if (max < 90) continue
    const min = Math.min(r, g, b)
    const delta = max - min
    counted += 1
    if (delta < 34) {
      buckets[12] += 1
      continue
    }
    let hue: number
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    const degrees = ((hue * 60) % 360 + 360) % 360
    buckets[Math.min(11, Math.floor(degrees / 30))] += 1
  }
  const dominant = buckets.reduce((max, value) => Math.max(max, value), 0)
  const inkHueConcentration = counted > 0 ? dominant / counted : 0

  return { width, height, edges, gray, chroma, mask, background, inkHueConcentration, canvas }
}

// ------------------------------------------------------------- projections

interface Band {
  start: number
  end: number
}

/**
 * Splits a 1-D ink profile into bands of content separated by runs of whitespace.
 * This is how the engine finds the header / body / footer stack of a screen, and
 * then the columns inside each of those.
 */
function bands(profile: Float32Array, minGap: number, minBand: number): Band[] {
  const peak = profile.reduce((max, value) => Math.max(max, value), 0)
  if (peak === 0) return []
  const cutoff = peak * 0.06

  const found: Band[] = []
  let start = -1
  let gap = 0

  for (let i = 0; i < profile.length; i += 1) {
    const inked = profile[i] > cutoff
    if (inked) {
      if (start === -1) start = i
      gap = 0
    } else if (start !== -1) {
      gap += 1
      if (gap >= minGap) {
        const end = i - gap
        if (end - start >= minBand) found.push({ start, end })
        start = -1
        gap = 0
      }
    }
  }
  if (start !== -1 && profile.length - start >= minBand) {
    found.push({ start, end: profile.length - 1 })
  }
  return found
}

function rowProfile(a: Analysis, box: { x: number; y: number; w: number; h: number }): Float32Array {
  const profile = new Float32Array(box.h)
  for (let y = 0; y < box.h; y += 1) {
    let sum = 0
    const base = (box.y + y) * a.width
    for (let x = 0; x < box.w; x += 1) sum += a.mask[base + box.x + x]
    profile[y] = sum
  }
  return profile
}

function columnProfile(
  a: Analysis,
  box: { x: number; y: number; w: number; h: number }
): Float32Array {
  const profile = new Float32Array(box.w)
  for (let x = 0; x < box.w; x += 1) {
    let sum = 0
    for (let y = 0; y < box.h; y += 1) sum += a.mask[(box.y + y) * a.width + box.x + x]
    profile[x] = sum
  }
  return profile
}

/** Shrinks a box until its edges touch actual ink, so boxes hug their content. */
function tighten(a: Analysis, box: Region): Region {
  const rows = rowProfile(a, box)
  const cols = columnProfile(a, box)
  const rowCut = Math.max(1, box.w * 0.01)
  const colCut = Math.max(1, box.h * 0.01)

  let top = 0
  while (top < box.h - 1 && rows[top] < rowCut) top += 1
  let bottom = box.h - 1
  while (bottom > top && rows[bottom] < rowCut) bottom -= 1
  let left = 0
  while (left < box.w - 1 && cols[left] < colCut) left += 1
  let right = box.w - 1
  while (right > left && cols[right] < colCut) right -= 1

  return {
    ...box,
    x: box.x + left,
    y: box.y + top,
    w: Math.max(1, right - left + 1),
    h: Math.max(1, bottom - top + 1)
  }
}

// ------------------------------------------------------- terminal detection

export interface TerminalInfo {
  /** Distance between one text row and the next. */
  rowPitch: number
  /** Width of one character cell. */
  cellWidth: number
  /** 80 or 132 on real hardware. */
  columns: number
}

/**
 * A 3270 or 5250 screen is bright monospaced text on a dark background, laid out
 * on a fixed character grid. All three of those are measurable, and requiring all
 * three keeps dark-themed web apps out of this branch.
 */
function detectTerminal(a: Analysis): TerminalInfo | null {
  if (a.background > 96) return null
  if (a.inkHueConcentration < 0.72) return null

  const page = { x: 0, y: 0, w: a.width, h: a.height }
  const rows = bands(rowProfile(a, page), 2, 2)
  if (rows.length < 6) return null

  const starts = rows.map((row) => row.start)
  const gaps: number[] = []
  for (let i = 1; i < starts.length; i += 1) gaps.push(starts[i] - starts[i - 1])
  if (!gaps.length) return null

  // Blank lines make some gaps a multiple of the pitch, so take the smallest gap
  // as the pitch and check the rest are near-multiples of it.
  const pitch = Math.min(...gaps)
  if (pitch < 6) return null
  const regular = gaps.filter((gap) => {
    const multiple = gap / pitch
    return Math.abs(multiple - Math.round(multiple)) < 0.2 && Math.round(multiple) >= 1
  }).length
  if (regular / gaps.length < 0.7) return null

  // Terminal cells are roughly twice as tall as they are wide. Snap the implied
  // column count to the two geometries that actually exist.
  const impliedColumns = a.width / (pitch * 0.5)
  const columns = Math.abs(impliedColumns - 132) < Math.abs(impliedColumns - 80) ? 132 : 80

  return { rowPitch: pitch, cellWidth: a.width / columns, columns }
}

// ---------------------------------------------------------- text capture

export interface Prepared {
  analysis: Analysis
  terminal: TerminalInfo | null
  /** A PNG ready for text capture, or null when capture is off. */
  ocrInput: string | null
  /**
   * A second, inverted pass — prepared only for a light page that carries dark
   * filled blocks. A solid header bar or a brand-coloured button is light text
   * on a dark ground, which a reader tuned for the page as a whole misses
   * completely. Null when the screen has no such blocks, so the common case
   * still costs one pass.
   */
  ocrInputInverted: string | null
  ocrScale: number
}

/**
 * First half of a generation. Analyses the image and, when text capture is on,
 * prepares the version the reader sees: dark screens are inverted, because
 * recognition is markedly better on dark text over a light ground, and
 * everything is upscaled so small glyphs survive.
 */
export function prepareWireframe(image: HTMLImageElement, settings: GenerateSettings): Prepared {
  const analysis = analyse(image)
  const terminal = detectTerminal(analysis)
  if (!settings.readText) {
    return { analysis, terminal, ocrInput: null, ocrInputInverted: null, ocrScale: 1 }
  }

  const scale = OCR_SCALE
  const upscaled = document.createElement('canvas')
  upscaled.width = analysis.width * scale
  upscaled.height = analysis.height * scale
  const ctx = upscaled.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(analysis.canvas, 0, 0, upscaled.width, upscaled.height)

  const darkPage = analysis.background < 128
  if (darkPage) invert(ctx, upscaled)

  const ocrInput = upscaled.toDataURL('image/png').split(',')[1]

  // A light page with sizeable dark blocks gets a second, inverted pass so the
  // words inside those blocks are read too.
  let ocrInputInverted: string | null = null
  if (!darkPage && darkBlockShare(analysis) > 0.004) {
    invert(ctx, upscaled)
    ocrInputInverted = upscaled.toDataURL('image/png').split(',')[1]
  }

  return { analysis, terminal, ocrInput, ocrInputInverted, ocrScale: scale }
}

function invert(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < frame.data.length; i += 4) {
    frame.data[i] = 255 - frame.data[i]
    frame.data[i + 1] = 255 - frame.data[i + 1]
    frame.data[i + 2] = 255 - frame.data[i + 2]
  }
  ctx.putImageData(frame, 0, 0)
}

/** Share of the screen that is markedly darker than the page — bars and buttons. */
function darkBlockShare(a: Analysis): number {
  let dark = 0
  for (let p = 0; p < a.gray.length; p += 1) {
    if (a.background - a.gray[p] > 70) dark += 1
  }
  return dark / a.gray.length
}

/**
 * Merges a second reading pass into the first, keeping whichever reading of the
 * same spot came back more confident.
 */
export function mergeWords(primary: OcrWord[], secondary: OcrWord[]): OcrWord[] {
  const merged = [...primary]

  for (const candidate of secondary) {
    const area = Math.max(1, candidate.w * candidate.h)
    const clashIndex = merged.findIndex((existing) => {
      const overlapW = Math.min(existing.x + existing.w, candidate.x + candidate.w) - Math.max(existing.x, candidate.x)
      const overlapH = Math.min(existing.y + existing.h, candidate.y + candidate.h) - Math.max(existing.y, candidate.y)
      if (overlapW <= 0 || overlapH <= 0) return false
      return (overlapW * overlapH) / area > 0.4
    })

    if (clashIndex === -1) merged.push(candidate)
    else if (candidate.confidence > merged[clashIndex].confidence) merged[clashIndex] = candidate
  }

  return merged
}

/** Words that sit inside a box, read left to right and top to bottom. */
function textIn(words: OcrWord[], box: Region): string {
  const inside = words.filter((word) => {
    const cx = word.x + word.w / 2
    const cy = word.y + word.h / 2
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
  })
  if (!inside.length) return ''

  // Group by vertical centre rather than top edge. Dot leaders, colons and
  // commas sit lower and are shorter than letters, and comparing tops alone
  // splits "Userid . . . . . :" into two lines.
  const centre = (word: OcrWord): number => word.y + word.h / 2
  const tallest = Math.max(...inside.map((word) => word.h))
  inside.sort((a, b) => centre(a) - centre(b) || a.x - b.x)

  const lines: OcrWord[][] = []
  for (const word of inside) {
    const line = lines[lines.length - 1]
    const sameLine = line && Math.abs(centre(word) - centre(line[0])) < Math.max(6, tallest * 0.7)
    if (sameLine) line.push(word)
    else lines.push([word])
  }
  return lines
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((word) => word.text)
        .join(' ')
    )
    .join('\n')
    .trim()
}

// -------------------------------------------------------- graphical screens

interface Stats {
  /** Share of the box that is content rather than background. A solid button is ~1. */
  fill: number
  /** Share of pixels carrying an edge. Outlined controls score high, filled ones low. */
  edge: number
  /** Mean colour spread — high means photo or illustration. */
  chroma: number
  /** How many separate horizontal ink runs the box holds — text stacks score high. */
  lines: number
}

function statsFor(a: Analysis, box: Region, threshold: number): Stats {
  let filled = 0
  let edged = 0
  let chroma = 0
  for (let y = 0; y < box.h; y += 1) {
    const base = (box.y + y) * a.width
    for (let x = 0; x < box.w; x += 1) {
      const o = base + box.x + x
      filled += a.mask[o]
      if (a.edges[o] > threshold) edged += 1
      chroma += a.chroma[o]
    }
  }
  const area = Math.max(1, box.w * box.h)
  const rows = rowProfile(a, box)
  const lineBands = bands(rows, Math.max(2, Math.round(box.h * 0.05)), 2)
  return { fill: filled / area, edge: edged / area, chroma: chroma / area, lines: lineBands.length }
}

function classify(
  box: Region,
  stats: Stats,
  canvasW: number,
  canvasH: number,
  text: string
): RegionKind {
  const widthShare = box.w / canvasW
  const heightShare = box.h / canvasH
  const top = box.y / canvasH
  const bottom = (box.y + box.h) / canvasH
  const aspect = box.w / Math.max(1, box.h)
  const trimmed = text.trim()

  // Position wins first: the bars pinned to the top and bottom of a screen.
  if (top < 0.09 && widthShare > 0.7 && heightShare < 0.18) return 'header'
  if (bottom > 0.91 && widthShare > 0.7 && heightShare < 0.18) return 'footer'

  // What the words say settles cases the pixels alone get wrong. A solid brand
  // button is as colourful as a photograph; only its label tells them apart.
  if (trimmed && heightShare < 0.12) {
    if (isActionWord(trimmed) && aspect < 9) return 'button'
    if (/[:：]$/.test(trimmed) && trimmed.length < 40) return 'label'
  }

  // Then anything colourful enough to be a photo rather than flat UI — but not
  // if it is control-shaped. A brand-coloured button is as saturated as a photo.
  const controlShaped = aspect > 1.2 && aspect < 9 && heightShare < 0.09
  if (stats.chroma > 30 && heightShare > 0.05 && stats.fill > 0.5 && !controlShaped) {
    return top < 0.45 && widthShare > 0.55 && heightShare > 0.18 ? 'hero' : 'image'
  }

  if (widthShare > 0.7 && heightShare < 0.04 && aspect > 12 && stats.lines <= 1 && (top < 0.2 || bottom > 0.82)) {
    return 'nav'
  }
  if (top < 0.45 && widthShare > 0.55 && heightShare > 0.22 && stats.lines <= 2) return 'hero'

  // Short controls: a filled body reads as a button, a hollow one as an input.
  if (heightShare < 0.09 && aspect > 1.2 && aspect < 9) {
    return stats.fill > 0.55 ? 'button' : 'input'
  }
  if (heightShare < 0.09 && widthShare > 0.8 && aspect >= 6) return 'input'
  if (heightShare < 0.09 && aspect >= 9 && stats.fill <= 0.55) return 'input'

  if (stats.lines >= 4 && widthShare > 0.4) return 'list'
  if (stats.lines >= 2) return 'text'
  if (heightShare > 0.08 && widthShare < 0.66) return 'card'
  if (stats.fill > 0.7 && heightShare > 0.06) return 'card'
  return 'block'
}

/** Verbs that start the label of a control rather than a paragraph. */
const ACTION_VERBS =
  /^(ok|go|next|back|save|send|sign|log|logout|submit|continue|confirm|cancel|close|done|apply|search|buy|add|create|checkout|pay|order|start|get|learn|subscribe|register|join|delete|remove|edit|update|retry|reset|download|upload|share|follow|book|reserve|view|show|see|select|choose|open|accept|decline|skip|finish|proceed|resume|try)\b/i

/** Reads like the label on a button: a short verb phrase with no sentence punctuation. */
function isActionWord(text: string): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed.length > 28) return false
  if (trimmed.split(' ').length > 4) return false
  if (/[.:;?]$/.test(trimmed)) return false
  return ACTION_VERBS.test(trimmed)
}

/**
 * Two passes: split the screen into horizontal bands, then split each band into
 * columns. That mirrors how almost every app screen is actually laid out, and it
 * keeps the region list short enough to stay readable as a wireframe.
 */
function graphicalRegions(a: Analysis, threshold: number, words: OcrWord[]): Region[] {
  const page: Region = { id: 'page', x: 0, y: 0, w: a.width, h: a.height, kind: 'block' }
  // Lines of text sit a few pixels apart; real sections sit much further apart.
  // Splitting on the larger gap keeps a paragraph as one region instead of six.
  const rowGap = Math.max(8, Math.round(a.height * 0.022))
  const rowBands = bands(rowProfile(a, page), rowGap, Math.round(a.height * 0.008))

  const regions: Region[] = []
  let index = 0

  for (const band of rowBands) {
    const strip: Region = {
      id: `r${index}`,
      x: 0,
      y: band.start,
      w: a.width,
      h: Math.max(1, band.end - band.start + 1),
      kind: 'block'
    }
    const colGap = Math.max(6, Math.round(a.width * 0.02))
    const colBands = bands(columnProfile(a, strip), colGap, Math.round(a.width * 0.03))
    const pieces = colBands.length > 1 ? colBands : [{ start: 0, end: a.width - 1 }]

    for (const col of pieces) {
      const raw: Region = {
        id: `rg_${index}`,
        x: col.start,
        y: strip.y,
        w: Math.max(1, col.end - col.start + 1),
        h: strip.h,
        kind: 'block'
      }
      const box = tighten(a, raw)
      if (box.w < a.width * 0.02 || box.h < a.height * 0.005) continue
      const stats = statsFor(a, box, threshold)
      box.text = textIn(words, box)
      box.kind = classify(box, stats, a.width, a.height, box.text)
      box.label = KIND_LABEL[box.kind]
      regions.push(box)
      index += 1
    }
  }

  return regions
}

// --------------------------------------------------------- terminal screens

const FKEY_PATTERN = /\b(P?F\d{1,2})\s*[=:]\s*([A-Za-z][A-Za-z0-9 /_-]{0,22})/g
const ENTER_PATTERN = /\bENTER\s*[=:]\s*([A-Za-z][A-Za-z0-9 /_-]{0,22})/gi
const MESSAGE_ID_PATTERN = /^[A-Z]{3,4}\d{3,5}\b/
// A run of underscores is what an entry field looks like, but recognition
// renders the same pixels as dashes, dots or em-dashes depending on the font.
const UNDERSCORE_FIELD = /^[_\-–—.\s]{3,}$/

function classifyTerminal(
  box: Region,
  text: string,
  info: TerminalInfo,
  canvasH: number,
  textHeight: number
): RegionKind {
  const trimmed = text.trim()
  const top = box.y / canvasH

  // Shape decides an entry field before the words do. A run of underscores is a
  // low bar barely a third the height of a line of letters, and what a reader
  // makes of it varies by platform — dashes, dots, or nothing at all. Comparing
  // against the typical glyph height on this screen keeps that judgement
  // independent of the font and of any blank lines in the layout.
  if (box.h < textHeight * 0.5 && box.w > info.cellWidth * 2) return 'field'

  if (trimmed) {
    if (/\bP?F\d{1,2}\s*[=:]/.test(trimmed)) return 'fkeys'
    if (UNDERSCORE_FIELD.test(trimmed)) return 'field'
    if (/^=+>/.test(trimmed)) return 'field'
    if (MESSAGE_ID_PATTERN.test(trimmed) && trimmed.length > 8) return 'message'
    // 3270 labels trail into the field with dot leaders: "Userid . . . . . :"
    if (/[.:]$/.test(trimmed) || /\.\s*\.\s*\.?\s*:?$/.test(trimmed)) return 'label'
    if (top < 0.06) return 'title'
    return 'text'
  }

  // No words at all: position is all that is left.
  if (top < 0.06) return 'title'
  return 'text'
}

/**
 * Terminal screens are a character grid, so they are segmented row by row and
 * then split into runs wherever two or more blank cells appear — which is exactly
 * how 3270 separates one field from the next.
 */
function terminalRegions(a: Analysis, info: TerminalInfo, words: OcrWord[]): Region[] {
  const page = { x: 0, y: 0, w: a.width, h: a.height }
  const rowBands = bands(rowProfile(a, page), Math.max(2, Math.round(info.rowPitch * 0.35)), 2)
  const blankGap = Math.max(6, Math.round(info.cellWidth * 3))
  const minRun = Math.max(2, Math.round(info.cellWidth * 0.6))

  // First pass: cut the screen into rows, then into runs.
  const rows: Region[][] = []
  let index = 0

  for (const band of rowBands) {
    const strip = {
      x: 0,
      y: band.start,
      w: a.width,
      h: Math.max(1, band.end - band.start + 1)
    }

    // Entry fields come out first. A field is a run of underscores, which is ink
    // that touches only the bottom of the row — no ascenders, no x-height body.
    // Finding them this way rather than by splitting on blank cells matters,
    // because a 3270 leaves only two blank cells between a label and its field,
    // and the gap that keeps "Userid . . . . . :" in one piece is wider than
    // that. Whether the two merged used to depend on the font.
    const underscore = underscoreColumns(a, strip)
    const fieldRuns: Region[] = []
    const fieldRunsFound = runsOf(
      underscore,
      Math.max(2, Math.round(info.cellWidth * 1.5)),
      Math.max(2, Math.round(info.cellWidth * 0.4))
    )
    for (const run of fieldRunsFound) {
      fieldRuns.push({
        id: `tf_${index++}`,
        x: run.start,
        y: strip.y,
        w: Math.max(1, run.end - run.start + 1),
        h: strip.h,
        kind: 'field'
      })
    }

    const runs: Region[] = []
    for (const run of bands(columnProfile(a, strip), blankGap, minRun)) {
      const raw: Region = {
        id: `tm_${index}`,
        x: run.start,
        y: strip.y,
        w: Math.max(1, run.end - run.start + 1),
        h: strip.h,
        kind: 'text'
      }
      index += 1

      // Trim any field territory off the run, so a merged label keeps only the
      // label, and drop the run entirely if it was all field.
      const trimmed = subtract(raw, fieldRuns)
      if (trimmed) runs.push(tighten(a, trimmed))
    }

    const all = [...runs, ...fieldRuns.map((field) => tighten(a, field))].sort((l, r) => l.x - r.x)
    if (all.length) rows.push(all)
  }

  // How tall a line of letters is on this screen. Taken as the median so a row
  // of underscores or a stray rule cannot drag it down.
  const heights = rows.flat().map((region) => region.h).sort((a, b) => a - b)
  const textHeight = heights.length ? heights[Math.floor(heights.length / 2)] : info.rowPitch * 0.7

  // Second pass: now that the typical glyph height is known, classify. Runs
  // already identified as fields by their ink keep that verdict.
  for (const row of rows) {
    for (const box of row) {
      box.text = textIn(words, box)
      if (box.kind !== 'field') {
        box.kind = classifyTerminal(box, box.text, info, a.height, textHeight)
      }
      box.label = KIND_LABEL[box.kind]
    }
  }

  return mergeTables(rows, info)
}

/**
 * Columns holding an underscore rule rather than a glyph.
 *
 * The test is on how *thick* the column's ink is, not on where it starts. An
 * underscore is one or two pixels of ink sitting on the baseline; a letter fills
 * most of the row. Measuring thickness avoids the threshold that an earlier
 * version used on the ink's top edge, which sat two pixels away from the answer
 * and so gave different results on macOS and on Linux.
 */
function underscoreColumns(
  a: Analysis,
  strip: { x: number; y: number; w: number; h: number }
): boolean[] {
  const flags: boolean[] = new Array(strip.w).fill(false)
  // Antialiasing puts a faint row above and below the rule, so the cap has to be
  // generous. It can afford to be: a letter column spans nearly the whole row.
  const maxThickness = Math.max(4, strip.h * 0.5)
  const baselineZone = strip.y + strip.h * 0.55
  const upperLimit = strip.y + strip.h * 0.35

  for (let x = 0; x < strip.w; x += 1) {
    let top = -1
    let bottom = -1
    for (let y = 0; y < strip.h; y += 1) {
      if (!a.mask[(strip.y + y) * a.width + strip.x + x]) continue
      if (top === -1) top = strip.y + y
      bottom = strip.y + y
    }
    if (top === -1) continue
    const thickness = bottom - top + 1
    flags[x] = thickness <= maxThickness && bottom >= baselineZone && top >= upperLimit
  }
  return flags
}

/**
 * Runs of at least `minWidth`, bridging gaps up to `maxGap`.
 *
 * The bridging is the whole point. Each underscore is drawn per character cell
 * and the cells do not quite touch, so a field of eight underscores is eight
 * runs of about eleven pixels rather than one run of ninety — and every one of
 * them falls under any sensible minimum width.
 */
function runsOf(flags: boolean[], minWidth: number, maxGap: number): Band[] {
  const out: Band[] = []
  let start = -1
  let last = -1

  for (let i = 0; i < flags.length; i += 1) {
    if (!flags[i]) continue
    if (start === -1) start = i
    else if (i - last - 1 > maxGap) {
      if (last - start + 1 >= minWidth) out.push({ start, end: last })
      start = i
    }
    last = i
  }
  if (start !== -1 && last - start + 1 >= minWidth) out.push({ start, end: last })

  return out
}

/** Cuts the horizontal span of `taken` out of `box`, keeping the widest remainder. */
function subtract(box: Region, taken: Region[]): Region | null {
  let left = box.x
  let right = box.x + box.w

  for (const other of taken) {
    const otherRight = other.x + other.w
    if (otherRight <= left || other.x >= right) continue
    // Keep whichever side of the overlap is larger.
    const before = other.x - left
    const after = right - otherRight
    if (before <= 0 && after <= 0) return null
    if (before >= after) right = Math.min(right, other.x)
    else left = Math.max(left, otherRight)
  }

  const width = right - left
  return width > 2 ? { ...box, x: left, w: width } : null
}

/**
 * Consecutive rows whose runs line up in the same columns are a list or a table,
 * not a stack of unrelated fields. Collapsing them keeps a 20-row subfile from
 * becoming sixty separate regions.
 */
function mergeTables(rows: Region[][], info: TerminalInfo): Region[] {
  const out: Region[] = []
  let group: Region[][] = []

  const aligned = (a: Region[], b: Region[]): boolean => {
    if (a.length < 3 || b.length < 3) return false
    const tolerance = info.cellWidth * 1.5
    let matches = 0
    for (const left of a) {
      if (b.some((right) => Math.abs(right.x - left.x) <= tolerance)) matches += 1
    }
    return matches >= Math.min(a.length, b.length) - 1
  }

  const flush = (): void => {
    if (group.length >= 2) {
      const all = group.flat()
      const x = Math.min(...all.map((region) => region.x))
      const y = Math.min(...all.map((region) => region.y))
      const right = Math.max(...all.map((region) => region.x + region.w))
      const bottom = Math.max(...all.map((region) => region.y + region.h))
      out.push({
        id: `tbl_${y}`,
        x,
        y,
        w: right - x,
        h: bottom - y,
        kind: 'table',
        label: KIND_LABEL.table,
        text: group
          .map((row) =>
            row
              .sort((a, b) => a.x - b.x)
              .map((region) => region.text ?? '')
              .join('  ')
          )
          .join('\n')
          .trim()
      })
    } else {
      for (const row of group) out.push(...row)
    }
    group = []
  }

  for (const row of rows) {
    if (!group.length) {
      group = [row]
      continue
    }
    if (aligned(group[group.length - 1], row)) group.push(row)
    else {
      flush()
      group = [row]
    }
  }
  flush()

  return out
}

// ----------------------------------------------------------------- actions

/** Reads the ways off a screen: PF keys on a terminal, buttons on a GUI. */
function extractActions(regions: Region[], terminal: boolean): ScreenAction[] {
  const actions: ScreenAction[] = []
  const seen = new Set<string>()

  const add = (key: string, label: string): void => {
    const id = key.toUpperCase()
    if (seen.has(id)) return
    seen.add(id)
    const trimmed = label.trim()
    actions.push({ key: id, label: trimmed, rank: rankOf(trimmed) })
  }

  if (terminal) {
    for (const region of regions) {
      if (!region.text) continue
      for (const match of region.text.matchAll(FKEY_PATTERN)) {
        add(match[1], match[2].replace(/\s{2,}.*$/, ''))
      }
      // "ENTER=Continue" sits on the same line as the PF keys on many screens.
      for (const match of region.text.matchAll(ENTER_PATTERN)) {
        add('ENTER', match[1].replace(/\s{2,}.*$/, ''))
      }
      if (/press\s+ENTER/i.test(region.text)) add('ENTER', 'Confirm')
    }
    return actions
  }

  for (const region of regions) {
    if (!region.text) continue
    // A link styled as plain text moves the user just as a button does; the
    // classifier only calls it a button when it is also control-shaped.
    const isControl = region.kind === 'button' || (region.kind === 'text' && isActionWord(region.text))
    if (!isControl) continue
    const label = region.text.replace(/\s+/g, ' ').trim()
    if (label) add(label, label)
  }
  return actions
}

/** Which way an action moves the user: 0 forward, 1 sideways, 2 back. */
const FORWARD_ACTION =
  /^(ok|go|next|save|send|sign|submit|continue|confirm|done|apply|search|buy|add|create|checkout|pay|order|start|subscribe|register|join|update|proceed|finish|accept|select|choose|book|reserve|enter)\b/i
const BACKWARD_ACTION = /^(exit|cancel|quit|back|close|help|refresh|reset|skip|decline|logout|log out)\b/i

function rankOf(label: string): number {
  if (BACKWARD_ACTION.test(label)) return 2
  if (FORWARD_ACTION.test(label)) return 0
  return 1
}

// ------------------------------------------------------------------ fields

/**
 * Pairs each entry control with the label that names it.
 *
 * Runs after classification because it needs the kinds, and after text capture
 * because it needs the words — but it degrades rather than fails without them.
 * A control with no label anywhere near it is numbered by its position, so a
 * screen read with the words turned off still produces a field list.
 */
function pairFields(
  regions: Region[],
  terminal: boolean,
  cellWidth: number,
  rowPitch: number
): NamedField[] {
  const controlKind: RegionKind = terminal ? 'field' : 'input'
  const controls = regions
    .filter((region) => region.kind === controlKind)
    // A run of dots is a leader trailing a label, never an entry rule — an
    // entry rule reads as underscores, as dashes, or as nothing at all. The
    // thickness test cannot tell them apart, because a dot sits on the baseline
    // and is just as thin, so a dot-leader row sometimes arrives here as a
    // field. Dropping it here keeps the field list honest without touching the
    // detection itself, which is tuned within two pixels of the answer.
    .filter((region) => !DOT_LEADER.test(region.text ?? ''))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  if (!controls.length) return []

  // A terminal entry field is a rule four pixels tall, so its own height is
  // useless as a yardstick for "the same row" — the label beside it is three
  // times taller. The row pitch is the honest measure there.
  const rowBudget = terminal ? rowPitch * 0.6 : 0

  // Recognition does not always leave a colon or a dot leader behind, so a
  // terminal label is as likely to have been classified as plain text.
  const LABEL_KINDS: RegionKind[] = terminal
    ? ['label', 'text']
    : ['label', 'text', 'block', 'card']
  const labels = regions.filter(
    (region) => LABEL_KINDS.includes(region.kind) && Boolean(region.text?.trim())
  )

  const taken = new Set<string>()
  const fields: NamedField[] = []
  const usedKeys = new Map<string, number>()
  let unnamed = 0

  for (const control of controls) {
    let name = ''
    let from: NamedField['from'] = 'position'

    // A 3270 command line names itself.
    if (terminal && /=>/.test(control.text ?? '')) {
      name = 'Command'
      from = 'label'
    }

    if (!name) {
      // Left first — the terminal layout and half of every web form. Then above,
      // which is what most modern forms do.
      const beside = terminal
        ? labelToTheLeft(control, labels, taken, cellWidth * 12, cellWidth, rowBudget)
        : labelToTheLeft(control, labels, taken, control.h * 1.5, 0, control.h * 0.6)
      const found = beside ?? labelAbove(control, labels, taken)
      if (found) {
        const cleaned = cleanLabel(found.text ?? '')
        if (cleaned) {
          name = cleaned
          from = 'label'
          taken.add(found.id)
        }
      }
    }

    // Segmentation often keeps a label and its box in one region, because the
    // gap between them is smaller than the gap that separates sections. When it
    // does, the control's own words are the label.
    if (!name) {
      const own = cleanLabel(control.text ?? '')
      if (own && own.length <= 40) {
        name = own
        from = 'placeholder'
      }
    }

    if (!name) {
      unnamed += 1
      name = `Field ${unnamed}`
      from = 'position'
    }

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '') || `pos${fields.length + 1}`
    const seen = (usedKeys.get(key) ?? 0) + 1
    usedKeys.set(key, seen)
    const unique = seen === 1 ? key : `${key}${seen}`

    fields.push({
      id: `fld_${unique}`,
      name,
      key: unique,
      control: terminal ? 'field' : 'input',
      from,
      x: control.x,
      y: control.y,
      w: control.w,
      h: control.h
    })
  }

  return fields
}

/** The nearest unclaimed label sharing the control's row, to its left. */
function labelToTheLeft(
  control: Region,
  labels: Region[],
  taken: Set<string>,
  budget: number,
  slack: number,
  rowBudget: number
): Region | null {
  let best: Region | null = null
  let bestGap = Infinity
  for (const label of labels) {
    if (taken.has(label.id) || label.id === control.id) continue
    // Vertical centres, not top edges: a colon or a dot leader sits lower than
    // the letters around it.
    const dy = Math.abs(label.y + label.h / 2 - (control.y + control.h / 2))
    if (dy > rowBudget) continue
    const gap = control.x - (label.x + label.w)
    if (gap < -slack || gap > budget) continue
    if (gap < bestGap) {
      bestGap = gap
      best = label
    }
  }
  return best
}

/** The nearest unclaimed label sitting directly over the control. */
function labelAbove(control: Region, labels: Region[], taken: Set<string>): Region | null {
  let best: Region | null = null
  let bestGap = Infinity
  for (const label of labels) {
    if (taken.has(label.id) || label.id === control.id) continue
    const text = label.text?.trim() ?? ''
    if (!text || text.length > 60) continue
    const overlap =
      Math.min(control.x + control.w, label.x + label.w) - Math.max(control.x, label.x)
    if (overlap < control.w * 0.4) continue
    const gap = control.y - (label.y + label.h)
    if (gap < 0 || gap > control.h * 1.2) continue
    if (gap < bestGap) {
      bestGap = gap
      best = label
    }
  }
  return best
}

/** Nothing but dots and spaces: the tail of a label, not a place to type. */
const DOT_LEADER = /^[.\u00b7\s]+$/

/** "Userid . . . . . :" is a label for a field called Userid. */
function cleanLabel(text: string): string {
  return text
    .split('\n')[0]
    .replace(/[\s.\u00b7:_*]+$/, '')
    .replace(/(\s[.\u00b7]){2,}.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function findTitle(regions: Region[], terminal: boolean, canvasH: number): string {
  // A 3270 top row carries the transaction id, the screen name and the date side
  // by side. The longest run of words is the name; the others are chrome.
  const pick = (candidates: Region[]): string =>
    candidates
      .map((region) => region.text?.split('\n')[0]?.trim() ?? '')
      .filter((text) => text.length > 0)
      .sort((a, b) => wordiness(b) - wordiness(a))[0] ?? ''

  const banner = pick(regions.filter((region) => region.kind === (terminal ? 'title' : 'header')))
  if (banner) return trimTitle(banner)

  // Plenty of screens put their heading in plain text rather than in a bar, and
  // then the header rule finds nothing at all. Fall back to the wordiest line
  // near the top that does not read like a control.
  const near = regions.filter(
    (region) =>
      region.y < canvasH * 0.3 &&
      ['text', 'label', 'card', 'block'].includes(region.kind) &&
      isHeading(region.text)
  )
  const heading = pick(near)
  if (heading) return trimTitle(heading)

  // Last resort: the wordiest heading-shaped line anywhere on the screen.
  return trimTitle(pick(regions.filter((region) => isHeading(region.text))))
}

/** Reads like a screen heading rather than a button or a paragraph. */
function isHeading(text: string | undefined): boolean {
  const first = text?.split('\n')[0]?.trim() ?? ''
  if (first.length < 3 || first.length > 60) return false
  if (isActionWord(first)) return false
  return /[A-Za-z]{2,}/.test(first)
}

function trimTitle(text: string): string {
  return text.replace(/\s{2,}/g, '  ').slice(0, 90)
}

/** Prefers real words over an identifier or a date. */
function wordiness(text: string): number {
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word))
  return words.length * 10 + text.length
}

// ----------------------------------------------------------------- drawing

const KIND_LABEL: Record<RegionKind, string> = {
  header: 'Header',
  nav: 'Nav',
  hero: 'Hero',
  card: 'Card',
  list: 'List',
  input: 'Input',
  button: 'Button',
  image: 'Image',
  text: 'Text',
  footer: 'Footer',
  block: 'Block',
  title: 'Title',
  label: 'Label',
  field: 'Field',
  table: 'Table',
  fkeys: 'F-keys',
  message: 'Message'
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** Draws the words that were read, clipped to their own region. */
function drawText(
  ctx: CanvasRenderingContext2D,
  region: Region,
  ink: string,
  mono: boolean,
  align: CanvasTextAlign = 'left'
): void {
  const lines = (region.text ?? '').split('\n').filter(Boolean)
  if (!lines.length) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(region.x, region.y, region.w, region.h)
  ctx.clip()

  const lineHeight = region.h / lines.length
  const size = Math.max(7, Math.min(15, lineHeight * 0.74))
  ctx.font = `${mono ? '' : '500 '}${size}px ${mono ? '"IBM Plex Mono", ui-monospace, monospace' : '"IBM Plex Sans", ui-sans-serif, sans-serif'}`
  ctx.fillStyle = ink
  ctx.textAlign = align
  ctx.textBaseline = 'middle'

  const x = align === 'center' ? region.x + region.w / 2 : region.x + 2
  lines.forEach((line, index) => {
    ctx.fillText(line, x, region.y + lineHeight * (index + 0.5), region.w - 4)
  })
  ctx.restore()
}

function drawRuledLines(ctx: CanvasRenderingContext2D, region: Region): void {
  ctx.save()
  ctx.globalAlpha = 0.5
  const lineHeight = Math.max(6, Math.min(14, region.h / 6))
  const gap = lineHeight * 1.9
  let lineY = region.y + lineHeight
  let n = 0
  while (lineY < region.y + region.h - 2 && n < 24) {
    const lineWidth = n % 3 === 2 ? region.w * 0.62 : region.w * 0.94
    ctx.fillRect(region.x, lineY - lineHeight * 0.6, lineWidth, Math.max(2, lineHeight * 0.42))
    lineY += gap
    n += 1
  }
  ctx.restore()
}

function drawRegion(
  ctx: CanvasRenderingContext2D,
  region: Region,
  settings: GenerateSettings,
  ink: string,
  terminal: boolean
): void {
  const { x, y, w, h } = region
  const hasText = Boolean(region.text)
  ctx.save()
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  ctx.lineWidth = region.kind === 'header' || region.kind === 'footer' ? 2 : 1.5

  switch (region.kind) {
    case 'button':
      roundRect(ctx, x, y, w, h, Math.min(h / 2, 10))
      ctx.stroke()
      if (hasText) drawText(ctx, region, ink, false, 'center')
      break

    case 'input':
      roundRect(ctx, x, y, w, h, 6)
      ctx.stroke()
      if (hasText) drawText(ctx, region, ink, false)
      else {
        ctx.globalAlpha = 0.35
        ctx.fillRect(x + 10, y + h / 2 - 1, Math.min(w * 0.4, 160), 2)
        ctx.globalAlpha = 1
      }
      break

    case 'field':
      // A terminal entry field: the underline it actually appears as.
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(x, y + h - 1)
      ctx.lineTo(x + w, y + h - 1)
      ctx.stroke()
      ctx.globalAlpha = 0.12
      ctx.fillRect(x, y, w, h)
      ctx.globalAlpha = 1
      break

    case 'image':
    case 'hero':
      roundRect(ctx, x, y, w, h, 4)
      ctx.stroke()
      if (settings.crossboxes) {
        ctx.globalAlpha = 0.55
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + w, y + h)
        ctx.moveTo(x + w, y)
        ctx.lineTo(x, y + h)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      break

    case 'title':
      if (hasText) drawText(ctx, region, ink, true)
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(x, y + h + 2)
      ctx.lineTo(x + w, y + h + 2)
      ctx.stroke()
      ctx.globalAlpha = 1
      break

    case 'label':
    case 'message':
    case 'fkeys':
      if (hasText) drawText(ctx, region, ink, terminal)
      else drawRuledLines(ctx, region)
      break

    case 'table':
      roundRect(ctx, x, y, w, h, 3)
      ctx.stroke()
      if (hasText) drawText(ctx, region, ink, true)
      else drawRuledLines(ctx, region)
      break

    case 'text':
    case 'list':
      if (hasText) drawText(ctx, region, ink, terminal)
      else drawRuledLines(ctx, region)
      break

    default:
      roundRect(ctx, x, y, w, h, 4)
      ctx.stroke()
      if (hasText) drawText(ctx, region, ink, terminal)
  }

  if (settings.labelRegions && w > 56 && h > 20) {
    ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace'
    const text = (region.label ?? '').toUpperCase()
    const textWidth = ctx.measureText(text).width
    ctx.globalAlpha = 0.9
    ctx.fillStyle = ink
    ctx.fillRect(x, y, textWidth + 12, 15)
    ctx.fillStyle = settings.blueprint ? BLUEPRINT_BG : PAPER
    ctx.fillText(text, x + 6, y + 11)
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ------------------------------------------------------------------ render

/**
 * Second half of a generation. Takes the prepared analysis plus whatever words
 * were read and produces the finished wireframe.
 */
export function finishWireframe(
  prepared: Prepared,
  words: OcrWord[],
  settings: GenerateSettings
): WireframeResult {
  const { analysis, terminal } = prepared
  const { width, height } = analysis
  const isTerminal = Boolean(terminal)
  const ink = settings.blueprint ? BLUEPRINT_INK : INK

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = settings.blueprint ? BLUEPRINT_BG : PAPER
  ctx.fillRect(0, 0, width, height)

  // Lay the traced edges down first, faint, as the "pencil" under the wireframe.
  // Terminal screens are all glyph edges, so the trace is dropped there — it
  // would just smear the text the regions are about to draw properly.
  if (!isTerminal) {
    const trace = ctx.createImageData(width, height)
    const inkRgb = settings.blueprint ? [159, 210, 255] : [18, 20, 26]
    const strength = 0.25 + settings.fidelity * 0.75
    for (let p = 0, i = 0; p < analysis.edges.length; p += 1, i += 4) {
      const magnitude = analysis.edges[p]
      const alpha = magnitude > settings.threshold ? Math.min(255, magnitude * strength) : 0
      trace.data[i] = inkRgb[0]
      trace.data[i + 1] = inkRgb[1]
      trace.data[i + 2] = inkRgb[2]
      trace.data[i + 3] = alpha * (0.35 + settings.fidelity * 0.5)
    }
    const traceCanvas = document.createElement('canvas')
    traceCanvas.width = width
    traceCanvas.height = height
    traceCanvas.getContext('2d')!.putImageData(trace, 0, 0)
    ctx.drawImage(traceCanvas, 0, 0)
  }

  const regions = terminal
    ? terminalRegions(analysis, terminal, words)
    : graphicalRegions(analysis, settings.threshold, words)

  if (settings.showRegions) {
    for (const region of regions) {
      if (!inScope(region, settings)) continue
      drawRegion(ctx, region, settings, ink, isTerminal)
    }
  }

  // Screen border, so a wireframe reads as a screen even when cropped tight.
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.strokeRect(1.5, 1.5, width - 3, height - 3)

  const text = regions
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((region) => region.text ?? '')
    .filter(Boolean)
    .join('\n')

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width,
    height,
    regions,
    terminal: isTerminal,
    text,
    // The title, the actions and the fields are read from every region, whether
    // or not the header and footer are in scope. Excluding the header is a
    // choice about what is *shown*, not a pretence that the pixels are absent —
    // otherwise hiding a header would erase the screen's own name.
    title: findTitle(regions, isTerminal, height),
    actions: extractActions(regions, isTerminal),
    fields: pairFields(regions, isTerminal, terminal?.cellWidth ?? 8, terminal?.rowPitch ?? 0)
  }
}

/**
 * Whether a region is in scope for drawing, the spec and the model context.
 *
 * The region itself is always kept on the wireframe, so flipping the toggle
 * costs nothing anywhere except the drawn PNG, which is baked at generation
 * time and catches up on the next redraw.
 */
export function inScope(region: Region, settings: GenerateSettings): boolean {
  if (region.kind === 'header') return settings.includeHeader
  if (region.kind === 'footer') return settings.includeFooter
  return true
}

/** Convenience for callers that do not capture text. */
export function generateWireframe(
  image: HTMLImageElement,
  settings: GenerateSettings
): WireframeResult {
  return finishWireframe(prepareWireframe(image, { ...settings, readText: false }), [], settings)
}

export function regionSummary(regions: Region[]): string {
  const counts = new Map<RegionKind, number>()
  for (const region of regions) counts.set(region.kind, (counts.get(region.kind) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => {
      const name = KIND_LABEL[kind].toLowerCase()
      // "F-keys" is already plural; do not make it "f-keyss".
      const plural = count === 1 || name.endsWith('s') ? name : `${name}s`
      return `${count} ${plural}`
    })
    .join(', ')
}

export { KIND_LABEL }
