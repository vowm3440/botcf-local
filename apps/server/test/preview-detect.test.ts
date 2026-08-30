import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SAFE_SCRIPT_NAME,
  detectPackageManager,
  detectProject,
  runnableScripts,
  scriptCommand
} from '../src/preview/projectDetect.js'

const temps: string[] = []

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-detect-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('detectProject', () => {
  it('prefers command mode with the dev script when package.json declares one', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ scripts: { build: 'tsc', dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'index.html': '<html></html>'
    })
    const detected = detectProject(dir)
    expect(detected.mode).toBe('command')
    expect(detected.script).toBe('dev')
    expect(detected.kind).toBe('vite')
    expect(detected.entry).toBe('index.html')
  })

  it('falls back to start/serve when there is no dev script', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ scripts: { serve: 'http-server', start: 'node .' } }) })
    const detected = detectProject(dir)
    expect(detected.script).toBe('start')
    expect(detected.scripts).toEqual(['start', 'serve'])
  })

  it('detects next projects by dependency', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }) })
    expect(detectProject(dir).kind).toBe('next')
  })

  it('detects vite from a config file without the dependency', () => {
    const dir = makeProject({ 'vite.config.ts': 'export default {}', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })
    expect(detectProject(dir).kind).toBe('vite')
  })

  it('chooses static mode for a plain html site', () => {
    const dir = makeProject({ 'index.html': '<html></html>' })
    const detected = detectProject(dir)
    expect(detected.mode).toBe('static')
    expect(detected.kind).toBe('static')
    expect(detected.entry).toBe('index.html')
    expect(detected.script).toBeNull()
  })

  it('finds nested html entries in probe order', () => {
    const dir = makeProject({ 'public/index.html': '<html></html>' })
    expect(detectProject(dir).entry).toBe('public/index.html')
  })

  it('reports an empty project when nothing is runnable', () => {
    const dir = makeProject({ 'notes.txt': 'hello' })
    const detected = detectProject(dir)
    expect(detected.kind).toBe('empty')
    expect(detected.mode).toBe('static')
    expect(detected.entry).toBeNull()
  })

  it('survives a malformed package.json', () => {
    const dir = makeProject({ 'package.json': '{ not json', 'index.html': '<html></html>' })
    const detected = detectProject(dir)
    expect(detected.mode).toBe('static')
    expect(detected.scripts).toEqual([])
  })
})

describe('runnableScripts', () => {
  it('drops empty and unsafely named scripts', () => {
    const scripts = runnableScripts({
      scripts: { dev: 'vite', 'bad name': 'x', empty: '   ', 'rm;rf': 'x', 'build:web': 'tsc' }
    })
    expect(scripts).toEqual(['dev', 'build:web'])
  })

  it('returns nothing without a manifest', () => {
    expect(runnableScripts(null)).toEqual([])
  })
})

describe('detectPackageManager', () => {
  it('reads the lockfile', () => {
    expect(detectPackageManager(makeProject({ 'pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(detectPackageManager(makeProject({ 'yarn.lock': '' }))).toBe('yarn')
    expect(detectPackageManager(makeProject({ 'bun.lockb': '' }))).toBe('bun')
    expect(detectPackageManager(makeProject({}))).toBe('npm')
  })
})

describe('scriptCommand', () => {
  it('builds a package-manager run command', () => {
    expect(scriptCommand('pnpm', 'dev')).toEqual({ file: 'pnpm', args: ['run', 'dev'] })
  })

  it('refuses script names that could break out of the shell command line', () => {
    for (const evil of ['dev && calc', 'dev;rm -rf /', 'dev|cat', '$(id)', '-dev', '']) {
      expect(SAFE_SCRIPT_NAME.test(evil)).toBe(false)
      expect(() => scriptCommand('npm', evil)).toThrow()
    }
  })
})
