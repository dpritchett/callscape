import { describe, expect, test } from 'vitest'
import { lineWindow, normalise, resolveWithinRoot } from './srcpath'

const ROOT = '/home/me/Projects/coder'

describe('resolveWithinRoot', () => {
  test('joins a repo-relative Go file onto the root', () => {
    expect(resolveWithinRoot(ROOT, 'coderd/httpapi/httpapi.go')).toBe(
      `${ROOT}/coderd/httpapi/httpapi.go`,
    )
    expect(resolveWithinRoot(ROOT, './cli/root.go')).toBe(`${ROOT}/cli/root.go`)
  })

  test('refuses to climb out of the root', () => {
    expect(resolveWithinRoot(ROOT, '../../../etc/passwd.go')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'coderd/../../secrets.go')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'a/b/../../../c.go')).toBeNull()
  })

  test('refuses absolute paths and drive letters', () => {
    expect(resolveWithinRoot(ROOT, '/etc/passwd.go')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'C:/windows/system32/x.go')).toBeNull()
  })

  test('serves Go files only', () => {
    expect(resolveWithinRoot(ROOT, '.env')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'go.mod')).toBeNull()
    expect(resolveWithinRoot(ROOT, 'coderd/id_rsa')).toBeNull()
  })

  test('refuses null bytes and empties', () => {
    expect(resolveWithinRoot(ROOT, 'a\0b.go')).toBeNull()
    expect(resolveWithinRoot(ROOT, '')).toBeNull()
    expect(resolveWithinRoot('', 'a.go')).toBeNull()
  })

  test('a sibling directory with the root as a prefix is still outside', () => {
    expect(resolveWithinRoot('/home/me/coder', '../coder-secrets/x.go')).toBeNull()
  })
})

test('normalise collapses . and .. and separators', () => {
  expect(normalise('a//b/./c')).toBe('a/b/c')
  expect(normalise('a/b/../c')).toBe('a/c')
  expect(normalise('a\\b')).toBe('a/b')
})

describe('lineWindow', () => {
  test('starts at the symbol and covers its length', () => {
    expect(lineWindow(100, 12)).toEqual({ from: 100, to: 111 })
  })

  test('caps a very long function rather than shipping the whole file', () => {
    expect(lineWindow(10, 900, 60)).toEqual({ from: 10, to: 69 })
  })

  test('survives a one-line symbol at the top of a file', () => {
    expect(lineWindow(1, 1)).toEqual({ from: 1, to: 1 })
  })
})
