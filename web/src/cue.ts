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
  /**
   * Press the clear key, including its undo — a second one puts back what the
   * first dropped. Same reason as `pick`: `select` names ids outright and skips
   * the code that decides them.
   */
  clear?: boolean
  /**
   * Take the wheel for a long lease, or give it back this instant.
   *
   * Mostly you do not need it: a cue that changes anything takes the wheel by
   * itself, for a few seconds, extended by the next one — see `movesTheView`.
   * `true` is for holding it across a longer stretch of thinking; `false` hands
   * it straight back rather than making anyone wait out the timer, and is worth
   * sending the moment you are done.
   *
   * While it is held, every local input is ignored and the page says so across
   * the top — a page that quietly stops answering the keyboard is
   * indistinguishable from a broken one. It expires on its own, and Escape
   * always takes it back, so an agent that dies mid-experiment cannot leave the
   * controls locked.
   */
  hold?: boolean
  /** Look the other way. Arrives at once, since a cue may be driving a tab
   * that has no animation loop to turn the camera with. */
  flip?: boolean
  /** Put the panel in a mode, since Tab is a key and a cue has no fingers. */
  panel?: string
  /**
   * Set the label ribbon. Same reason as `panel`: the ribbon is a d-pad, a key
   * and a click, and a cue has none of those. It is also the only way to see
   * what a mode does from a terminal, since the ribbon itself is DOM and no
   * screenshot has ever contained it.
   */
  labels?: string
  /**
   * Open the symbol search on this query; the empty string closes it. The hits
   * land in the log, so what ranking actually returns on a real graph is
   * readable from a terminal rather than only from the panel.
   */
  search?: string
}

/**
 * Does this cue change what is on screen or where the camera is?
 *
 * Anything that does should take the wheel on its own. Two people steering is
 * the failure mode the hold exists to prevent, and asking whoever is driving
 * remotely to remember to declare it first means it gets forgotten exactly when
 * it matters — mid-sequence, halfway through lining something up.
 *
 * `seq` is bookkeeping and `hold` is the thing itself, so a cue carrying only
 * those is not a change. That leaves the rule as "any field with something in
 * it", which is one line and stays right when a field is added.
 */
export function movesTheView(cue: Cue): boolean {
  return Object.entries(cue).some(
    ([key, value]) => key !== 'seq' && key !== 'hold' && value !== undefined,
  )
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
