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

/** Sets a label's scale from a world height, keeping its texture's aspect. */
export function setLabelHeight(sprite: THREE.Sprite, height: number) {
  const aspect = (sprite.userData.aspect as number) || 1
  sprite.scale.set(height * aspect, height, 1)
}

/** Text sprite drawn on a canvas texture. Cheap enough for a few hundred. */
export function makeLabel(text: string, opts: { size?: number; color?: string; bg?: string } = {}): THREE.Sprite {
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

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  sprite.userData.aspect = w / h
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
