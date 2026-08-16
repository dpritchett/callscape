export interface Cue {
  seq: number
  focus?: string | null
  select?: string[]
  reveal?: boolean
  distance?: number
  /** Where to stand, in degrees around the focus. Lets a rotation-dependent
   * bug be reproduced from a terminal instead of described. */
  yaw?: number
  pitch?: number
  /**
   * Pull the trigger: run what a click runs, on whatever the reticle is on
   * after the rest of this cue has been applied. `select` says what is
   * selected; this exercises the picking that decides it, which is otherwise
   * the one path nobody without a mouse can reach.
   */
  pick?: boolean
}

/**
 * Client half of the remote control: polls for a requested state and hands it
 * over. Dev only.
 *
 * The first response is swallowed, so a cue issued before this page loaded does
 * not fire on arrival — otherwise every reload replays whatever was last asked
 * for, which is confusing when someone is flying by hand.
 */
export function watchCues(onCue: (cue: Cue) => void, pollMs = 400) {
  if (!import.meta.env.DEV) return
  let seen = -1
  const tick = async () => {
    try {
      const res = await fetch('/__cue', { cache: 'no-store' })
      const cue = (await res.json()) as Cue
      if (seen === -1) seen = cue.seq
      else if (cue.seq !== seen) {
        seen = cue.seq
        onCue(cue)
      }
    } catch {
      /* the remote must never break the app */
    } finally {
      setTimeout(tick, pollMs)
    }
  }
  void tick()
}
