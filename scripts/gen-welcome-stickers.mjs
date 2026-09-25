/**
 * Generate the animated welcome-sticker palette used by the god messenger when
 * a new dialog is created (see app/actions/admin-secret/conversations.ts).
 *
 * Each sticker is a hand-built Lottie animation (simple shape layers with
 * keyframed transforms) gzipped into the Telegram `.tgs` container — i.e. the
 * EXACT format the manager inbox already renders with lottie-web's canvas
 * player (components/manager/inbox/tgs-sticker.tsx). We author them here rather
 * than shipping third-party sticker packs so the asset is self-contained, has a
 * clear licence, and needs no worker/Telegram round-trip to appear.
 *
 * Output: lib/god/welcome-stickers.ts (base64 payloads). Regenerate with:
 *   node scripts/gen-welcome-stickers.mjs
 */
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const W = 512
const H = 512
const CX = 256
const CY = 256
const FR = 60

/* ----------------------------- Lottie helpers ----------------------------- */

/** Static (non-animated) property. */
const val = (k) => ({ a: 0, k })

/**
 * Keyframed property. `frames` is [[t, value], …]; value is a number or an
 * array. Easing is a gentle in/out so loops feel organic.
 */
function anim(frames) {
  const k = frames.map(([t, v], i) => {
    const s = Array.isArray(v) ? v : [v]
    const kf = { t, s }
    if (i < frames.length - 1) {
      const d = s.length
      kf.i = { x: Array(d).fill(0.6), y: Array(d).fill(1) }
      kf.o = { x: Array(d).fill(0.4), y: Array(d).fill(0) }
    }
    return kf
  })
  return { a: 1, k }
}

/** A shape-layer transform. Any field may be a static value or an anim(). */
function tr({ p = [CX, CY], a = [0, 0], s = [100, 100], r = 0, o = 100 } = {}) {
  const asProp = (v, dims) =>
    v && v.a === 1 ? v : val(Array.isArray(v) ? v : Array(dims).fill(v))
  return {
    o: asProp(o, 1),
    r: asProp(r, 1),
    p: asProp(Array.isArray(p) ? [...p, 0] : p, 3),
    a: asProp([a[0], a[1], 0], 3),
    s: asProp(Array.isArray(s) ? [...s, 100] : s, 3),
    sk: val(0),
    sa: val(0),
  }
}

function layer(ind, nm, shapes, transform, op) {
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm,
    sr: 1,
    ks: transform,
    ao: 0,
    shapes,
    ip: 0,
    op,
    st: 0,
    bm: 0,
  }
}

/** Group transform (nested inside a shape group). */
function groupTr({ p = [0, 0], s = [100, 100], r = 0, o = 100 } = {}) {
  const asProp = (v, dims) =>
    v && v.a === 1 ? v : val(Array.isArray(v) ? v : Array(dims).fill(v))
  return {
    ty: 'tr',
    p: asProp(p, 2),
    a: val([0, 0]),
    s: asProp(s, 2),
    r: asProp(r, 1),
    o: asProp(o, 1),
    sk: val(0),
    sa: val(0),
  }
}

const fill = ([r, g, b, a = 1]) => ({
  ty: 'fl',
  c: val([r, g, b, a]),
  o: val(100),
  r: 1,
  nm: 'fill',
})

const stroke = ([r, g, b, a = 1], w) => ({
  ty: 'st',
  c: val([r, g, b, a]),
  o: val(100),
  w: val(w),
  lc: 2,
  lj: 2,
  ml: 4,
  nm: 'stroke',
})

/** Ellipse group. */
function ellipse(w, h, color, pos = [0, 0], transform = groupTr()) {
  return {
    ty: 'gr',
    nm: 'ellipse',
    it: [{ ty: 'el', d: 1, s: val([w, h]), p: val(pos) }, fill(color), transform],
  }
}

/** Polystar (5-point star) group. */
function star(outer, inner, color, transform = groupTr()) {
  return {
    ty: 'gr',
    nm: 'star',
    it: [
      {
        ty: 'sr',
        sy: 1,
        d: 1,
        pt: val(5),
        p: val([0, 0]),
        r: val(0),
        or: val(outer),
        ir: val(inner),
        is: val(0),
        os: val(0),
      },
      fill(color),
      transform,
    ],
  }
}

/** Open bezier path (e.g. a smile), stroked. */
function strokePath(v, i, o, color, w, closed = false) {
  return {
    ty: 'gr',
    nm: 'path',
    it: [
      { ty: 'sh', d: 1, ks: val({ c: closed, v, i, o }) },
      stroke(color, w),
      groupTr(),
    ],
  }
}

/** Closed filled path (e.g. a triangle). */
function fillPath(v, color) {
  const zeros = v.map(() => [0, 0])
  return {
    ty: 'gr',
    nm: 'poly',
    it: [
      { ty: 'sh', d: 1, ks: val({ c: true, v, i: zeros, o: zeros }) },
      fill(color),
      groupTr(),
    ],
  }
}

function root(nm, layers, op) {
  return { v: '5.7.4', fr: FR, ip: 0, op, w: W, h: H, nm, ddd: 0, assets: [], layers }
}

/* --------------------------------- Colors -------------------------------- */

const YELLOW = [1, 0.79, 0.16, 1]
const DARK = [0.16, 0.12, 0.09, 1]
const RED = [0.94, 0.27, 0.33, 1]
const GOLD = [1, 0.8, 0.2, 1]
const CONFETTI = [
  [0.94, 0.27, 0.33, 1],
  [0.23, 0.51, 0.96, 1],
  [0.25, 0.77, 0.45, 1],
  [0.61, 0.35, 0.94, 1],
  [0.98, 0.6, 0.18, 1],
  [0.15, 0.73, 0.71, 1],
]

/* Reusable smiley face (body + eyes + smile) centered on the layer origin. */
function smileyShapes() {
  const smile = strokePath(
    [
      [-72, 12],
      [0, 66],
      [72, 12],
    ],
    [
      [0, 0],
      [-46, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [46, 0],
      [0, 0],
    ],
    DARK,
    18,
  )
  return [
    ellipse(36, 48, DARK, [-64, -34]),
    ellipse(36, 48, DARK, [64, -34]),
    smile,
    ellipse(300, 300, YELLOW, [0, 0]),
  ]
}

/* Reusable waving hand (palm + four fingers + thumb) centered on the origin,
   built so the layer can pivot around the wrist below it. */
function handShapes() {
  const finger = (x) => ellipse(38, 104, YELLOW, [x, -70])
  return [
    finger(-57),
    finger(-19),
    finger(19),
    finger(57),
    ellipse(50, 92, YELLOW, [-78, 10]), // thumb
    ellipse(168, 156, YELLOW, [0, 28]), // palm
  ]
}

/* -------------------------------- Stickers ------------------------------- */

/** 😊 — squash-and-stretch bounce. */
function makeBounce() {
  const op = 66
  const t = tr({
    p: [CX, CY + 6],
    s: anim([
      [0, [100, 100, 100]],
      [16, [108, 90, 100]],
      [34, [94, 110, 100]],
      [48, [102, 98, 100]],
      [66, [100, 100, 100]],
    ]),
  })
  return root('bounce', [layer(1, 'smiley', smileyShapes(), t, op)], op)
}

/** 👋 — friendly side-to-side wave (rotation around the lower anchor). */
function makeWave() {
  const op = 72
  const t = tr({
    p: [CX, CY + 110],
    a: [0, 110],
    r: anim([
      [0, -16],
      [18, 16],
      [36, -16],
      [54, 16],
      [72, -16],
    ]),
  })
  return root('wave', [layer(1, 'hand', handShapes(), t, op)], op)
}

/** ❤️ — heartbeat pulse (two humps + a triangle base). */
function makeHeart() {
  const op = 78
  const heart = {
    ty: 'gr',
    nm: 'heart',
    it: [
      ellipse(120, 120, RED, [-46, -30]),
      ellipse(120, 120, RED, [46, -30]),
      fillPath(
        [
          [-98, -6],
          [98, -6],
          [0, 116],
        ],
        RED,
      ),
      groupTr(),
    ],
  }
  const t = tr({
    p: [CX, CY - 8],
    s: anim([
      [0, [100, 100, 100]],
      [8, [128, 128, 100]],
      [18, [100, 100, 100]],
      [28, [120, 120, 100]],
      [40, [100, 100, 100]],
      [78, [100, 100, 100]],
    ]),
  })
  return root('heart', [layer(1, 'heart', [heart], t, op)], op)
}

/** ⭐ — a slow spin with a gentle pulse. */
function makeStar() {
  const op = 120
  const t = tr({
    p: [CX, CY],
    r: anim([
      [0, 0],
      [120, 360],
    ]),
    s: anim([
      [0, [100, 100, 100]],
      [60, [116, 116, 100]],
      [120, [100, 100, 100]],
    ]),
  })
  return root('star', [layer(1, 'star', [star(150, 68, GOLD)], t, op)], op)
}

/** 🎉 — confetti: colored dots pop in and drift down on a loop. */
function makeConfetti() {
  const op = 90
  const pieces = [
    [-150, -120],
    [-70, -170],
    [10, -140],
    [90, -175],
    [160, -110],
    [-120, -40],
    [120, -30],
    [0, -60],
    [-40, -190],
    [60, -100],
  ]
  const layers = pieces.map(([x, y], idx) => {
    const color = CONFETTI[idx % CONFETTI.length]
    const delay = (idx % 5) * 6
    const wobble = idx % 2 === 0 ? 26 : -26
    const dot =
      idx % 3 === 0
        ? star(20, 9, color)
        : ellipse(26, 26, color)
    const t = tr({
      p: anim([
        [delay, [CX + x, CY + y, 0]],
        [op, [CX + x + wobble, CY + y + 300, 0]],
      ]),
      o: anim([
        [delay, 0],
        [delay + 8, 100],
        [op - 14, 100],
        [op, 0],
      ]),
      s: anim([
        [delay, [0, 0, 100]],
        [delay + 10, [120, 120, 100]],
        [delay + 18, [100, 100, 100]],
        [op, [90, 90, 100]],
      ]),
      r: anim([
        [delay, 0],
        [op, idx % 2 === 0 ? 220 : -220],
      ]),
    })
    return layer(idx + 1, `confetti-${idx}`, [dot], t, op)
  })
  return root('confetti', layers, op)
}

/* --------------------------------- Emit ---------------------------------- */

const STICKERS = [
  { emoji: '😊', anim: makeBounce() },
  { emoji: '👋', anim: makeWave() },
  { emoji: '❤️', anim: makeHeart() },
  { emoji: '⭐', anim: makeStar() },
  { emoji: '🎉', anim: makeConfetti() },
]

const entries = STICKERS.map((s) => {
  const gz = gzipSync(Buffer.from(JSON.stringify(s.anim)), { level: 9 })
  return { emoji: s.emoji, base64: gz.toString('base64') }
})

const banner =
  '// AUTO-GENERATED by scripts/gen-welcome-stickers.mjs — do not edit by hand.\n' +
  '// Animated welcome stickers (gzipped Lottie / Telegram .tgs) sent when a\n' +
  '// god-messenger dialog is created. Regenerate: node scripts/gen-welcome-stickers.mjs\n\n'

const body =
  banner +
  'export interface WelcomeSticker {\n' +
  '  /** Emoji shown as the loading/fallback glyph and stored as the message body. */\n' +
  '  emoji: string\n' +
  '  /** MIME of the .tgs container (gzipped Lottie), matching real Telegram stickers. */\n' +
  '  mime: string\n' +
  '  /** base64 of the gzipped Lottie bytes. */\n' +
  '  base64: string\n' +
  '}\n\n' +
  "export const WELCOME_STICKER_MIME = 'application/x-tgsticker'\n\n" +
  'export const WELCOME_STICKERS: WelcomeSticker[] = [\n' +
  entries
    .map(
      (e) =>
        `  { emoji: ${JSON.stringify(e.emoji)}, mime: WELCOME_STICKER_MIME, base64: ${JSON.stringify(
          e.base64,
        )} },`,
    )
    .join('\n') +
  '\n]\n'

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  'god',
  'welcome-stickers.ts',
)
writeFileSync(outPath, body)
console.log(
  `Wrote ${entries.length} welcome stickers → ${outPath} ` +
    `(${entries.reduce((n, e) => n + e.base64.length, 0)} base64 chars)`,
)
