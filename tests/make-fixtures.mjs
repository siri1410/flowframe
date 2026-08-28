/**
 * Writes synthetic app screenshots used by the end-to-end test. They are plain
 * PNGs built by hand — no browser, no image library — so the test suite has no
 * extra install step on any platform.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fixtures')

const W = 720
const H = 1200

function canvas(background) {
  const pixels = new Uint8Array(W * H * 3)
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = background[0]
    pixels[i + 1] = background[1]
    pixels[i + 2] = background[2]
  }
  return pixels
}

function rect(pixels, x, y, w, h, color) {
  for (let row = Math.max(0, y); row < Math.min(H, y + h); row += 1) {
    for (let col = Math.max(0, x); col < Math.min(W, x + w); col += 1) {
      const offset = (row * W + col) * 3
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc(H * (W * 3 + 1))
  for (let row = 0; row < H; row += 1) {
    raw[row * (W * 3 + 1)] = 0 // no filter
    Buffer.from(pixels.buffer, row * W * 3, W * 3).copy(raw, row * (W * 3 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const WHITE = [250, 250, 250]
const DARK = [32, 34, 40]
const GREY = [176, 180, 188]
const MID = [120, 126, 136]
const BRAND = [42, 118, 220]
const PHOTO = [214, 96, 60]

/** A screen with a header, a hero image, some text and a primary button. */
function landing() {
  const p = canvas(WHITE)
  rect(p, 0, 0, W, 88, DARK) // header
  rect(p, 28, 32, 130, 24, WHITE)
  rect(p, W - 190, 34, 60, 20, GREY)
  rect(p, W - 110, 34, 76, 20, GREY)
  rect(p, 28, 128, W - 56, 320, PHOTO) // hero photo
  for (let i = 0; i < 4; i += 1) rect(p, 28, 490 + i * 34, i === 3 ? 360 : W - 56, 16, GREY)
  rect(p, 28, 650, 220, 56, BRAND) // primary button
  rect(p, 276, 650, 180, 56, MID)
  for (let i = 0; i < 6; i += 1) rect(p, 28, 780 + i * 30, W - 56, 14, GREY)
  rect(p, 0, H - 96, W, 96, DARK) // footer
  return p
}

/** A form screen: labelled inputs and a submit button. */
function form() {
  const p = canvas(WHITE)
  rect(p, 0, 0, W, 88, DARK)
  rect(p, 28, 34, 180, 22, WHITE)
  for (let i = 0; i < 4; i += 1) {
    rect(p, 28, 150 + i * 130, 150, 14, MID) // label
    rect(p, 28, 180 + i * 130, W - 56, 62, GREY) // input
  }
  rect(p, 28, 700, W - 56, 60, BRAND) // submit
  for (let i = 0; i < 3; i += 1) rect(p, 28, 800 + i * 28, W - 120, 13, GREY)
  rect(p, 0, H - 96, W, 96, DARK)
  return p
}

/** A list screen: repeated cards. */
function list() {
  const p = canvas(WHITE)
  rect(p, 0, 0, W, 88, DARK)
  rect(p, 28, 34, 140, 22, WHITE)
  rect(p, 28, 118, W - 56, 52, GREY) // search input
  for (let i = 0; i < 5; i += 1) {
    const y = 200 + i * 150
    rect(p, 28, y, W - 56, 128, [238, 238, 240])
    rect(p, 48, y + 20, 88, 88, PHOTO)
    rect(p, 156, y + 26, 300, 18, MID)
    rect(p, 156, y + 58, 420, 13, GREY)
    rect(p, 156, y + 82, 360, 13, GREY)
  }
  rect(p, 0, H - 96, W, 96, DARK)
  return p
}

/** A confirmation screen. */
function done() {
  const p = canvas(WHITE)
  rect(p, 0, 0, W, 88, DARK)
  rect(p, 28, 34, 160, 22, WHITE)
  rect(p, W / 2 - 90, 240, 180, 180, BRAND) // big tick block
  rect(p, 140, 480, W - 280, 26, MID)
  for (let i = 0; i < 3; i += 1) rect(p, 110, 540 + i * 30, W - 220, 14, GREY)
  rect(p, 180, 680, W - 360, 56, BRAND)
  rect(p, 0, H - 96, W, 96, DARK)
  return p
}

mkdirSync(OUT, { recursive: true })
const screens = [
  ['01-browse-landing.png', landing()],
  ['02-browse-results.png', list()],
  ['03-checkout-details.png', form()],
  ['04-checkout-confirmed.png', done()]
]
for (const [name, pixels] of screens) {
  writeFileSync(join(OUT, name), png(pixels))
  console.log('wrote', name)
}
