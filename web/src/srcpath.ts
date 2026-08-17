/**
 * Path containment for the dev server, on both the read and the write path.
 *
 * The server hands out files from a directory the graph names and writes
 * screenshots under a name the page picks, which means the request decides
 * which file in both directions. That is a directory traversal waiting to
 * happen, so the checks live here as pure functions with tests rather than
 * inline in a request handler where nobody reads them.
 */

/** Normalises a path to forward slashes with `.` and `..` resolved. */
export function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // A `..` with nothing to pop has to survive, or the path silently stops
      // being the path that was asked for: `../../etc/x` would collapse to
      // `etc/x` and land inside the root looking innocent.
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else out.push(part)
  }
  return out.join('/')
}

/**
 * Joins a repo-relative path onto a root, or returns null if the result would
 * escape the root, is absolute, or is not a Go file.
 */
export function resolveWithinRoot(root: string, requested: string): string | null {
  if (!root || !requested) return null
  // An absolute path or a Windows drive letter is never a repo-relative file.
  if (requested.startsWith('/') || /^[a-zA-Z]:/.test(requested)) return null
  if (requested.includes('\0')) return null
  if (!requested.endsWith('.go')) return null

  const rel = normalise(requested)
  if (!rel || rel.startsWith('..')) return null

  const base = normalise(root)
  const full = `${base}/${rel}`
  // Re-normalising must not have climbed out: `a/../../b` collapses to `../b`
  // and would otherwise land outside.
  if (full !== normalise(full) || !full.startsWith(`${base}/`)) return null
  return (root.startsWith('/') ? '/' : '') + full
}

/**
 * The file name to write a posted screenshot under, or null to refuse it.
 *
 * The page names its own capture and the dev server listens on the LAN, so the
 * name is input like any other: `../../../.ssh/authorized_keys.png` would land
 * outside `shots/` if it were joined on as given. Reduce it to a bare name and
 * insist on a PNG — the only thing the shutter ever sends is `latest.png`.
 */
export function shotFileName(name: string): string | null {
  if (!name || name.includes('\0')) return null
  const base = normalise(name).split('/').pop() ?? ''
  // A leading dot would let a capture land on a dotfile in shots/, and the
  // charset leaves nothing for a shell or a path to interpret later.
  if (base.startsWith('.') || !base.endsWith('.png')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null
  return base
}

/** The window of lines to show around a symbol. */
export function lineWindow(line: number, lines: number, budget = 60): { from: number; to: number } {
  const from = Math.max(1, line)
  const to = Math.max(from, from + Math.min(lines, budget) - 1)
  return { from, to }
}
