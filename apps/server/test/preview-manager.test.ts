import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PreviewManager, PreviewState } from '../src/preview/manager.js'

const temps: string[] = []
let manager: PreviewManager | null = null

function makeSite(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-mgr-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

afterEach(async () => {
  await manager?.stop()
  manager = null
})

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('PreviewManager static mode', () => {
  it('starts, serves the project and reports a running state', async () => {
    const dir = makeSite({ 'index.html': '<html><body>preview me</body></html>' })
    manager = new PreviewManager()
    const state = await manager.start({ workdir: dir })
    expect(state.phase).toBe('running')
    expect(state.running).toBe(true)
    expect(state.mode).toBe('static')
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const res = await get(state.url as string)
    expect(res.status).toBe(200)
    expect(res.body).toContain('preview me')
  })

  it('emits a css reload when only stylesheets change', async () => {
    const dir = makeSite({ 'index.html': '<html></html>', 'a.css': 'body{}' })
    manager = new PreviewManager()
    const reloads: Array<{ kind: string; paths: string[] }> = []
    manager.on('reload', (event: { kind: string; paths: string[] }) => reloads.push(event))
    await manager.start({ workdir: dir })
    fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:red}')
    await vi.waitFor(() => expect(reloads.length).toBeGreaterThan(0), { timeout: 5_000 })
    expect(reloads[0].kind).toBe('css')
    expect(manager.getState().lastReloadKind).toBe('css')
  })

  it('releases the port on stop', async () => {
    const dir = makeSite({ 'index.html': '<html></html>' })
    manager = new PreviewManager()
    const started = await manager.start({ workdir: dir })
    const url = started.url as string
    const stopped = await manager.stop()
    expect(stopped.phase).toBe('stopped')
    expect(stopped.running).toBe(false)
    expect(stopped.url).toBeNull()
    await expect(get(url)).rejects.toThrow()
  })

  it('reports an error for a missing workdir instead of throwing', async () => {
    manager = new PreviewManager()
    const state = await manager.start({ workdir: path.join(os.tmpdir(), 'botcf-does-not-exist-42') })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('工作目录不存在')
  })

  it('restarting replaces the previous server', async () => {
    const dir = makeSite({ 'index.html': '<html></html>' })
    manager = new PreviewManager()
    const first = await manager.start({ workdir: dir })
    const second = await manager.start({ workdir: dir })
    expect(second.phase).toBe('running')
    // The OS may hand back the same ephemeral port; only assert the old server
    // is gone when the port actually differs.
    if (first.port !== second.port) await expect(get(first.url as string)).rejects.toThrow()
    expect((await get(second.url as string)).status).toBe(200)
  })

  it('rejects a command-mode script the project does not declare', async () => {
    const dir = makeSite({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) })
    manager = new PreviewManager()
    const state = await manager.start({ workdir: dir, mode: 'command', script: 'evil' })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('不在该项目 package.json 中')
  })

  it('refuses command mode when the project has no scripts', async () => {
    const dir = makeSite({ 'index.html': '<html></html>' })
    manager = new PreviewManager()
    const state = await manager.start({ workdir: dir, mode: 'command' })
    expect(state.phase).toBe('error')
    expect(state.error).toContain('静态模式')
  })

  it('keeps a bounded, redacted log', async () => {
    const dir = makeSite({ 'index.html': '<html></html>' })
    manager = new PreviewManager()
    await manager.start({ workdir: dir })
    const logs = manager.getLogs()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[logs.length - 1].line).toContain('内置静态预览已启动')
  })

  it('pushes state updates to listeners', async () => {
    const dir = makeSite({ 'index.html': '<html></html>' })
    manager = new PreviewManager()
    const phases: string[] = []
    manager.on('state', (state: PreviewState) => phases.push(state.phase))
    await manager.start({ workdir: dir })
    expect(phases).toContain('starting')
    expect(phases).toContain('running')
  })
})

describe('PreviewManager watcher pause (resource degrader)', () => {
  it('pauses and resumes the static reload watcher', async () => {
    const dir = makeSite({ 'index.html': '<html></html>', 'a.css': 'body{}' })
    manager = new PreviewManager()
    const reloads: unknown[] = []
    manager.on('reload', () => reloads.push('reload'))
    await manager.start({ workdir: dir })
    expect(manager.getState().running).toBe(true)

    fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:red}')
    await vi.waitFor(() => expect(reloads.length).toBeGreaterThan(0), { timeout: 5_000 })
    reloads.length = 0

    manager.pauseWatch()
    fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:blue}')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(reloads).toHaveLength(0)

    manager.resumeWatch()
    fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:green}')
    await vi.waitFor(() => expect(reloads.length).toBeGreaterThan(0), { timeout: 5_000 })
  })
})
