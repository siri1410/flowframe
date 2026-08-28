import { createWorker, PSM } from 'tesseract.js'
import type { OcrWord } from '../shared/types'

/**
 * Text capture runs here, in a forked Node process, and not in the main process.
 *
 * That is not a style choice. Tesseract's WebAssembly core runs roughly two
 * orders of magnitude slower inside Electron's main process than it does under
 * plain Node — a page that reads in about a second there takes minutes here.
 * Forking with ELECTRON_RUN_AS_NODE gets the fast path back, and keeps the
 * renderer's Content-Security-Policy strict at the same time.
 */

interface Request {
  id: number
  base64?: string
  langPath?: string
  shutdown?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let starting: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getEngine(langPath: string): Promise<any> {
  if (engine) return engine
  if (starting) return starting

  starting = (async () => {
    const created = await createWorker('eng', 1, {
      langPath,
      cachePath: langPath,
      cacheMethod: 'none',
      gzip: false,
      logger: () => {}
    })
    // Page segmentation mode 6: one uniform block of text. Terminal screens and
    // app screenshots are both closer to a block than to a scanned page.
    await created.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
    engine = created
    return created
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

process.on('message', (request: Request) => {
  void (async () => {
    if (request.shutdown) {
      try {
        await engine?.terminate()
      } catch {
        // Already gone.
      }
      engine = null
      process.send?.({ id: request.id, ok: true })
      return
    }

    try {
      const worker = await getEngine(request.langPath!)
      const { data } = await worker.recognize(
        Buffer.from(request.base64!, 'base64'),
        {},
        { text: true, blocks: true }
      )

      const words: OcrWord[] = []
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
          for (const line of paragraph.lines ?? []) {
            for (const word of line.words ?? []) {
              const text = (word.text ?? '').trim()
              if (!text) continue
              words.push({
                text,
                x: word.bbox.x0,
                y: word.bbox.y0,
                w: word.bbox.x1 - word.bbox.x0,
                h: word.bbox.y1 - word.bbox.y0,
                confidence: word.confidence ?? 0
              })
            }
          }
        }
      }

      process.send?.({
        id: request.id,
        ok: true,
        result: { text: data.text ?? '', words, confidence: data.confidence ?? 0 }
      })
    } catch (error) {
      process.send?.({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })()
})
