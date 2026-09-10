import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DevCommandRunner, sniffDevServerUrl, stripAnsi } from '../src/preview/commandRunner.js'

class FakeDevServer extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  exitCode: number | null = null
  pid = 4242
  kill = vi.fn(() => true)
}

const ESC = String.fromCharCode(27)

describe('stripAnsi', () => {
  it('removes colour sequences and keeps the text', () => {
    expect(stripAnsi(`${ESC}[32m  ➜  Local:${ESC}[39m ${ESC}[36mhttp://localhost:5173/${ESC}[39m`)).toBe(
      '  ➜  Local: http://localhost:5173/'
    )
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('ready in 231 ms')).toBe('ready in 231 ms')
  })
})

describe('sniffDevServerUrl', () => {
  it('finds vite style output', () => {
    expect(sniffDevServerUrl(`  ${ESC}[32m➜${ESC}[39m  Local:   http://localhost:5173/`)).toBe('http://localhost:5173/')
  })

  it('normalizes wildcard and ipv6 hosts to loopback', () => {
    expect(sniffDevServerUrl('listening on http://0.0.0.0:3000')).toBe('http://127.0.0.1:3000/')
    expect(sniffDevServerUrl('serving http://[::1]:8080/app')).toBe('http://127.0.0.1:8080/app')
  })

  it('keeps the path when one is printed', () => {
    expect(sniffDevServerUrl('open http://127.0.0.1:4321/docs/intro')).toBe('http://127.0.0.1:4321/docs/intro')
  })

  it('ignores lines without a loopback url', () => {
    expect(sniffDevServerUrl('compiled successfully')).toBeNull()
    expect(sniffDevServerUrl('see https://vitejs.dev/guide/')).toBeNull()
    expect(sniffDevServerUrl('network http://192.168.1.20:5173/')).toBeNull()
  })
})

describe('DevCommandRunner', () => {
  it('reports log lines and the first detected url', async () => {
    const child = new FakeDevServer()
    const spawnProcess = vi.fn((..._args: unknown[]) => child)
    const runner = new DevCommandRunner({
      cwd: '/tmp/project',
      packageManager: 'npm',
      script: 'dev',
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn
    })
    const logs: string[] = []
    const urls: string[] = []
    runner.on('log', (line: string) => logs.push(line))
    runner.on('url', (url: string) => urls.push(url))

    runner.start()
    child.stdout.write('VITE v5.4.0 ready in 210 ms\n')
    child.stdout.write(`  ${ESC}[32m➜${ESC}[39m  Local: http://localhost:5173/\n`)
    child.stdout.write('  ➜  Local: http://localhost:9999/\n')

    await vi.waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toBe('http://localhost:5173/')
    expect(runner.url).toBe('http://localhost:5173/')
    expect(logs).toContain('VITE v5.4.0 ready in 210 ms')
    expect(logs.some((line) => line.includes('http://localhost:5173/'))).toBe(true)
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(spawnProcess.mock.calls[0][0]).toBe('npm')
    expect(spawnProcess.mock.calls[0][1]).toEqual(['run', 'dev'])
  })

  it('surfaces a spawn failure as a log line plus exit', async () => {
    const runner = new DevCommandRunner({
      cwd: '/tmp/project',
      packageManager: 'npm',
      script: 'dev',
      spawnProcess: (() => {
        throw new Error('ENOENT npm')
      }) as unknown as typeof import('node:child_process').spawn
    })
    const logs: string[] = []
    let exited = false
    runner.on('log', (line: string) => logs.push(line))
    runner.on('exit', () => {
      exited = true
    })
    runner.start()
    expect(exited).toBe(true)
    expect(logs[0]).toContain('ENOENT npm')
    expect(runner.running).toBe(false)
  })

  it('notifies the preview manager when an asynchronous spawn fails without exit', () => {
    const child = new FakeDevServer()
    const runner = new DevCommandRunner({
      cwd: '/tmp/project',
      packageManager: 'npm',
      script: 'dev',
      spawnProcess: (() => child) as unknown as typeof spawn
    })
    const exited = vi.fn()
    runner.on('exit', exited)
    runner.start()
    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', -2, null)
    expect(runner.running).toBe(false)
    expect(exited).toHaveBeenCalledExactlyOnceWith(-2)
  })

  it('exposes the command line it will run', () => {
    const runner = new DevCommandRunner({ cwd: '/tmp', packageManager: 'pnpm', script: 'dev:web' })
    expect(runner.commandLine).toBe('pnpm run dev:web')
  })
})
