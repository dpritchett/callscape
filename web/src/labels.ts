import * as THREE from 'three'

/**
 * World height a label needs to cover `px` pixels of screen at `distance`.
 * Clamped, so a label seen from across the map shrinks away instead of filling
 * the screen, and one seen from inches away does not swallow it.
 */
export function labelWorldHeight(
  px: number,
  distance: number,
  fovDegrees: number,
  viewportHeight: number,
  min = 0.8,
  max = 14,
): number {
  if (viewportHeight <= 0) return min
  // Height of the view frustum at `distance`, divided by the pixels it maps to.
  const perPixel = (2 * Math.tan((fovDegrees * Math.PI) / 360) * distance) / viewportHeight
  return Math.min(max, Math.max(min, px * perPixel))
}

/**
 * Cosine of the angle from the view axis to the corner of the frustum: the
 * furthest off-axis anything on screen can be. Using the corner rather than the
 * vertical half-FOV keeps the ranking below meaning the same thing on a wide
 * window as on a tall one.
 */
export function frustumEdgeCosine(fovDegrees: number, aspect: number): number {
  const tanV = Math.tan((fovDegrees * Math.PI) / 360)
  return Math.cos(Math.atan(Math.hypot(tanV, tanV * aspect)))
}

/**
 * Ease a label's presence towards `want` — 1 for shown, 0 for gone — at `rate`
 * a second.
 *
 * Which names win is decided in jumps: every couple of degrees of turn, and
 * again every frame when they are packed against each other. Applied straight
 * to visibility that reads as blinking, and half the screen blinks at once
 * while you fly. Crossing it over a fifth of a second reads as a dissolve.
 */
export function fadePresence(current: number, want: number, dt: number, rate = 5): number {
  const step = Math.max(0, rate * dt)
  return want > current ? Math.min(want, current + step) : Math.max(want, current - step)
}

/** Smoothstep: a fade that leaves and arrives gently, rather than a linear ramp. */
export function fadeOpacity(presence: number): number {
  const p = Math.min(1, Math.max(0, presence))
  return p * p * (3 - 2 * p)
}

const axisPoint = new THREE.Vector3()
const axisOffset = new THREE.Vector3()

/**
 * Slide a name from `centre` towards the camera's view axis, by no more than
 * `limit` and no further than it takes to reach the axis.
 *
 * A district wider than the screen has its centre off the edge of the frame
 * while most of its ground is in front of you, so hanging its name on its
 * centre means the biggest thing in view is the one thing not named. `limit` is
 * how far the name may wander and still be over its own ground — the district's
 * radius, less a margin.
 */
export function axisAnchor(
  centre: THREE.Vector3,
  eye: THREE.Vector3,
  dir: THREE.Vector3,
  limit: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const along = axisOffset.copy(centre).sub(eye).dot(dir)
  // Behind the camera there is no axis point worth walking towards.
  if (along <= 0) return out.copy(centre)
  axisPoint.copy(eye).addScaledVector(dir, along)
  axisOffset.copy(axisPoint).sub(centre)
  const len = axisOffset.length()
  if (len < 1e-6) return out.copy(centre)
  return out.copy(centre).addScaledVector(axisOffset, Math.min(limit, len) / len)
}

/**
 * What a name is worth as a label — lower wins, and it reads as a distance.
 *
 * Ranking by plain distance spends every slot on whatever you happen to be
 * flying over, which is the bottom of the screen. What you are reading is the
 * reticle, so a name off the view axis has to be proportionally closer to earn
 * a slot: at the corner of the screen, `1 + weight` times closer.
 *
 * `cos` is the cosine of the angle between the view axis and the label,
 * `cosEdge` the same at the corner of the frustum.
 */
export function labelRank(distance: number, cos: number, cosEdge: number, weight = 2.5): number {
  const span = 1 - cosEdge
  const off = span <= 0 ? 0 : Math.min(1, Math.max(0, (1 - cos) / span))
  return distance * (1 + weight * off)
}

/**
 * Sets a label's scale so that one *line of text* is `height` tall in the
 * world, keeping the texture's aspect.
 *
 * Sizing the whole sprite instead is the obvious mistake and a bad one: a
 * sprite is a padded canvas, so a one-line label spends about half its height
 * on glyphs and a three-line package name spends a fifth of it per line. Asking
 * for 26px of sprite got about 5px of readable text.
 */
export function setLabelHeight(sprite: THREE.Sprite, height: number) {
  const aspect = (sprite.userData.aspect as number) || 1
  const perLine = (sprite.userData.perLine as number) || 1
  sprite.scale.set(height * perLine * aspect, height * perLine, 1)
}

/**
 * The same image with the corners cut off, as a round medallion.
 *
 * An avatar is a square with an opaque background, which is invisible against
 * space and an obvious sticker against anything else. On the face of a disc it
 * has to be a disc.
 */
export function roundTexture(image: HTMLImageElement): THREE.CanvasTexture {
  // Never below 256. An avatar arrives at whatever size it was saved at, and an
  // SVG reports the width attribute in its own markup — 32, in the case of the
  // mark this falls back to — which then gets stretched across a 400-unit disc
  // and looks exactly as bad as that sounds. Rasterising an SVG larger costs
  // nothing and is sharp; stretching a small raster is the only lossy path.
  const size = Math.max(256, image.naturalWidth, image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(image, 0, 0, size, size)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  return tex
}

/**
 * The repo's name under its mark, in neon.
 *
 * A flat panel rather than a sprite, because it hangs on the sky next to the
 * badge and has to be stuck to that sphere the same way — a sprite would turn
 * to face you and slide off the thing it belongs to.
 *
 * The look is chromatic split: the same text laid down three times, cyan
 * nudged one way, magenta the other, the readable copy on top in a pink-to-cyan
 * gradient with a pink glow behind it. That is where the fringing on old video
 * came from, and it costs two extra fillText calls on a canvas drawn once.
 * Letter-spaced, because tracking is most of the aesthetic.
 *
 * `height` is the height of the text itself in world units, not of the padded
 * canvas — the padding here is generous enough to hold the glow, and sizing the
 * quad instead is the mistake `setLabelHeight` exists to avoid.
 */
export function makeNeonPanel(text: string, height: number): THREE.Mesh {
  const px = 96
  const font = `700 ${px}px ui-monospace, Menlo, monospace`
  const track = px * 0.18 // extra space per character
  const pad = px * 0.9 // room for the glow and the split, both of which spill

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const textWidth = measure.measureText(text).width + track * (text.length - 1)

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(textWidth + pad * 2)
  canvas.height = Math.ceil(px + pad * 2)
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // One pass per colour, each character placed by hand because canvas has no
  // letter-spacing that every browser here agrees on.
  const draw = (dx: number, dy: number, style: string | CanvasGradient) => {
    ctx.fillStyle = style
    let x = pad
    for (const ch of text) {
      ctx.fillText(ch, x + dx, canvas.height / 2 + dy)
      x += ctx.measureText(ch).width + track
    }
  }

  const split = px * 0.055
  draw(-split, 0, '#01cdfe') // cyan, lagging
  draw(split, 0, '#ff2fd0') // magenta, leading

  const gradient = ctx.createLinearGradient(0, pad, 0, canvas.height - pad)
  gradient.addColorStop(0, '#fff6fb')
  gradient.addColorStop(0.45, '#ff71ce')
  gradient.addColorStop(1, '#01cdfe')
  ctx.shadowColor = '#ff71ce'
  ctx.shadowBlur = px * 0.5
  draw(0, 0, gradient)
  ctx.shadowBlur = 0

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false

  // The quad is the whole canvas; `height` is the text inside it, so the
  // padding scales with the type rather than squashing it.
  const worldHeight = height * (canvas.height / px)
  return new THREE.Mesh(
    new THREE.PlaneGeometry(worldHeight * (canvas.width / canvas.height), worldHeight),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  )
}

/** Text sprite drawn on a canvas texture. Cheap enough for a few hundred. */
export function makeLabel(
  text: string,
  opts: { size?: number; color?: string; bg?: string; onTop?: boolean } = {},
): THREE.Sprite {
  const px = 64
  const color = opts.color ?? '#e6edf7'
  const font = `600 ${px}px ui-monospace, Menlo, monospace`
  const lines = text.split('\n')
  const lineHeight = px * 1.15

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const w = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))) + 24
  const h = Math.ceil(lines.length * lineHeight) + 24

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  if (opts.bg) {
    ctx.fillStyle = opts.bg
    roundRect(ctx, 0, 0, w, h, 12)
    ctx.fill()
  }
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, 12 + lineHeight * (i + 0.5))
  })

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      depthWrite: false,
      transparent: true,
      // Fog applies to sprites, which quietly dissolved every label past the
      // fog's near plane — the reason distant names were unreadable was that
      // they were being blended into the background, not that they were small.
      fog: false,
      // Names you navigate by should not be hidden behind the geometry they
      // are naming.
      depthTest: !opts.onTop,
    }),
  )
  if (opts.onTop) sprite.renderOrder = 10
  sprite.userData.aspect = w / h
  sprite.userData.perLine = h / lineHeight // sprite heights per line of text
  setLabelHeight(sprite, opts.size ?? 6)
  return sprite
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function disposeSprite(s: THREE.Sprite) {
  const m = s.material as THREE.SpriteMaterial
  m.map?.dispose()
  m.dispose()
}
