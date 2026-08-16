import * as THREE from 'three'

/**
 * A containing sphere of stars, well outside anything the graph occupies.
 *
 * Deliberately dumb: one Points object, one draw call, no interaction with
 * layout, picking or selection. It exists so that "which way am I facing" has
 * an answer when you are between districts and nothing else is on screen.
 *
 * Positions come from a fixed seed rather than Math.random, because a scene
 * that reshuffles its own background on reload cannot be compared with a
 * screenshot of itself.
 */
export function makeStarfield(radius: number, count = 1400): THREE.Points {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const rng = mulberry32(0x5eed)
  const tint = new THREE.Color()

  for (let i = 0; i < count; i++) {
    // Even over the sphere: z uniform, then a ring at that latitude. Sampling
    // two angles uniformly instead would crowd the poles.
    const z = rng() * 2 - 1
    const theta = rng() * Math.PI * 2
    const r = Math.sqrt(1 - z * z)
    positions[i * 3] = radius * r * Math.cos(theta)
    positions[i * 3 + 1] = radius * z
    positions[i * 3 + 2] = radius * r * Math.sin(theta)

    // A few bright ones, mostly dim, slightly blue — enough variety that the
    // sky reads as depth rather than as noise.
    const bright = 0.25 + 0.75 * Math.pow(rng(), 3)
    tint.setHSL(0.55 + rng() * 0.1, 0.35, 0.45 * bright + 0.1)
    colors[i * 3] = tint.r
    colors[i * 3 + 1] = tint.g
    colors[i * 3 + 2] = tint.b
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const stars = new THREE.Points(
    geom,
    new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false, // a star does not get bigger as you approach it
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: false, // the fog is sized to the graph; the sky is far outside it
    }),
  )
  stars.matrixAutoUpdate = false
  stars.frustumCulled = false
  stars.renderOrder = -1
  return stars
}

/** Small deterministic PRNG, so the sky is the same sky every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
