import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EMPTY_WORKSPACE, addRoot, type Workspace } from '../src/workspace/model.js'
import { locateWorkspacePath } from '../src/workspace/locate.js'

/** Filesystem-backed resolution of qualified workspace paths (`<root>/<rel>`).
 *  Containment itself lives in fsContainment.ts and is covered by files.test.ts;
 *  what matters here is that the right root is picked and that no root can be
 *  used as a bridge out of the workspace. */

function workspaceOf(...dirs: string[]): Workspace {
  return dirs.reduce<Workspace>((workspace, dir) => {
    const result = addRoot(workspace, { path: dir })
    if (!result.ok) throw new Error(result.error)
    return result.workspace
  }, EMPTY_WORKSPACE)
}

const alpha = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-ws-alpha-'))
const beta = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-ws-beta-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-ws-outside-'))
const realAlpha = fs.realpathSync.native(alpha)
const realBeta = fs.realpathSync.native(beta)

fs.mkdirSync(path.join(alpha, 'src'))
fs.writeFileSync(path.join(alpha, 'src', 'a.ts'), 'a')
fs.writeFileSync(path.join(beta, 'b.ts'), 'b')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')

/** Nested pair: an inner root inside `alpha`, standing in for a monorepo package
 *  added as its own workspace root. */
const inner = path.join(alpha, 'packages', 'inner')
fs.mkdirSync(inner, { recursive: true })
fs.writeFileSync(path.join(inner, 'index.ts'), 'i')

let escapeLink = false
try {
  fs.symlinkSync(outside, path.join(alpha, 'esc'), 'junction')
  escapeLink = true
} catch {
  // Symlink creation can be unavailable; that escape test is skipped then.
}

afterAll(() => {
  for (const dir of [alpha, beta, outside]) fs.rmSync(dir, { recursive: true, force: true })
})

describe('locateWorkspacePath', () => {
  const workspace = workspaceOf(alpha, beta)
  const [rootAlpha, rootBeta] = workspace.roots

  it('treats the empty path as the workspace itself', () => {
    for (const requested of ['', '.', '/']) {
      expect(locateWorkspacePath(workspace, requested)).toEqual({ status: 'workspace' })
    }
  })

  it('resolves a bare root name to that root directory', () => {
    expect(locateWorkspacePath(workspace, rootAlpha.name)).toEqual({
      status: 'ok',
      root: rootAlpha,
      relative: '',
      target: realAlpha
    })
  })

  it('resolves a qualified path inside the named root', () => {
    expect(locateWorkspacePath(workspace, `${rootAlpha.name}/src/a.ts`)).toEqual({
      status: 'ok',
      root: rootAlpha,
      relative: 'src/a.ts',
      target: path.join(realAlpha, 'src', 'a.ts')
    })
    expect(locateWorkspacePath(workspace, `${rootBeta.name}\\b.ts`)).toEqual({
      status: 'ok',
      root: rootBeta,
      relative: 'b.ts',
      target: path.join(realBeta, 'b.ts')
    })
  })

  it('reports a missing file inside a known root as missing, not out of bounds', () => {
    expect(locateWorkspacePath(workspace, `${rootAlpha.name}/src/gone.ts`)).toMatchObject({ status: 'missing' })
  })

  it('rejects an unknown root name', () => {
    expect(locateWorkspacePath(workspace, 'nope/src/a.ts')).toEqual({ status: 'outside' })
  })

  it('rejects parent escapes through a root', () => {
    expect(locateWorkspacePath(workspace, `${rootAlpha.name}/../../etc/passwd`)).toEqual({ status: 'outside' })
    expect(locateWorkspacePath(workspace, `${rootAlpha.name}/..`)).toEqual({ status: 'outside' })
  })

  it('rejects every path when no root is configured', () => {
    expect(locateWorkspacePath(EMPTY_WORKSPACE, 'app/src/a.ts')).toEqual({ status: 'outside' })
    expect(locateWorkspacePath(EMPTY_WORKSPACE, '')).toEqual({ status: 'workspace' })
  })

  it.skipIf(!escapeLink)('rejects a symlink that leaves the root', () => {
    expect(locateWorkspacePath(workspace, `${rootAlpha.name}/esc/secret.txt`)).toEqual({ status: 'outside' })
  })

  it('accepts an unqualified path in a single-root workspace (legacy form)', () => {
    const single = workspaceOf(alpha)
    expect(locateWorkspacePath(single, 'src/a.ts')).toMatchObject({
      status: 'ok',
      relative: 'src/a.ts',
      target: path.join(realAlpha, 'src', 'a.ts')
    })
  })

  it('refuses an unqualified path once the workspace has several roots', () => {
    expect(locateWorkspacePath(workspace, 'src/a.ts')).toEqual({ status: 'outside' })
  })

  it('accepts an absolute path that lands inside a root (OMP reports resolved paths)', () => {
    expect(locateWorkspacePath(workspace, path.join(realBeta, 'b.ts'))).toEqual({
      status: 'ok',
      root: rootBeta,
      relative: 'b.ts',
      target: path.join(realBeta, 'b.ts')
    })
  })

  it('rejects an absolute path outside every root', () => {
    expect(locateWorkspacePath(workspace, path.join(outside, 'secret.txt'))).toEqual({ status: 'outside' })
  })

  it('attributes an absolute path to the most specific root when roots nest', () => {
    const nested = workspaceOf(alpha, inner)
    const located = locateWorkspacePath(nested, path.join(fs.realpathSync.native(inner), 'index.ts'))
    expect(located).toMatchObject({ status: 'ok', relative: 'index.ts' })
    expect(located.status === 'ok' && located.root.name).toBe('inner')
  })

  it('keeps the nested inner root addressable by its own name', () => {
    const nested = workspaceOf(alpha, inner)
    expect(locateWorkspacePath(nested, 'inner/index.ts')).toMatchObject({ status: 'ok', relative: 'index.ts' })
    // The same file is also reachable through the outer root's own tree.
    expect(locateWorkspacePath(nested, `${nested.roots[0].name}/packages/inner/index.ts`)).toMatchObject({
      status: 'ok',
      relative: 'packages/inner/index.ts'
    })
  })
})
