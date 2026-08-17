import { expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { place } from './placement'
import { parseView } from './view'

// A diagnostic on whatever is loaded, not an assertion about a particular
// graph — and nothing is committed to load, so on a checkout that has not
// dumped anything this has nothing to measure and says so. It must not be the
// one check that fails for somebody who just cloned.
const GRAPH = 'public/graph.json'

test.skipIf(!existsSync(GRAPH))('shell fill', () => {
  const G = JSON.parse(readFileSync(GRAPH, 'utf8'))
  const v = parseView(JSON.parse(readFileSync('public/view.json', 'utf8')))
  const t0 = performance.now()
  const p = place(G, v)
  const ms = performance.now() - t0
  const capArea = p.districts.reduce((s, d) => s + Math.PI * d.radius * d.radius, 0)
  const sphere = 4 * Math.PI * p.shell * p.shell
  // A single district is laid out flat, with no shell to cover a fraction of.
  const cover = sphere > 0 ? `${((100 * capArea) / sphere).toFixed(1)}%` : 'flat, one district'
  console.log(`shell ${p.shell.toFixed(0)}, districts cover ${cover}, place() ${ms.toFixed(0)}ms`)
  let worst = Infinity
  for (const a of p.districts)
    for (const b of p.districts)
      if (a !== b) {
        const d = Math.hypot(
          a.centre.x - b.centre.x,
          a.centre.y - b.centre.y,
          a.centre.z - b.centre.z,
        )
        worst = Math.min(worst, d - a.radius - b.radius)
      }
  console.log(`closest gap ${worst.toFixed(1)}`)
  expect(worst).toBeGreaterThan(0)

  // What the ground being lifted without its buildings used to cost. A building
  // straddles the surface, so a district lifted by L hid L of every building's
  // outward half; anything shorter than 2L vanished into its own floor when
  // seen from outside the shell.
  const liftOf = new Map(p.districts.map((d) => [d.pkg, d.lift]))
  const sunk = p.nodes.filter((n) => n.height <= 2 * (liftOf.get(n.pkg) ?? 0))
  console.log(
    `max lift ${Math.max(...p.districts.map((d) => d.lift)).toFixed(2)}, ` +
      `would have been buried: ${sunk.length}/${p.nodes.length}`,
  )

  // An edge is a straight chord between two points on the shell, so it sinks
  // below the surface it spans — by roughly L squared over 8R for a chord of
  // length L. That is how far a wire has to be lifted to stay above its own
  // district's floor, which is what makes it visible from outside the shell.
  const widest = Math.max(...p.districts.map((d) => d.radius))
  const sag = p.shell > 0 ? (((2 * widest) ** 2) / (8 * p.shell)).toFixed(1) : 'none, flat'
  console.log(`widest district ${widest.toFixed(0)}, worst in-district sag ${sag}`)
})
