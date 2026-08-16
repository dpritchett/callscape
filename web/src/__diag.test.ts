import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { place } from './placement'
import { parseView } from './view'

test('shell fill', () => {
  const G = JSON.parse(readFileSync('public/graph.json', 'utf8'))
  const v = parseView(JSON.parse(readFileSync('public/view.json', 'utf8')))
  const t0 = performance.now()
  const p = place(G, v)
  const ms = performance.now() - t0
  const capArea = p.districts.reduce((s, d) => s + Math.PI * d.radius * d.radius, 0)
  const sphere = 4 * Math.PI * p.shell * p.shell
  console.log(
    `shell ${p.shell.toFixed(0)}, districts cover ${((100 * capArea) / sphere).toFixed(1)}%, place() ${ms.toFixed(0)}ms`,
  )
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
})
