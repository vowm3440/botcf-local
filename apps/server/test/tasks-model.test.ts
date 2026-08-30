import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../src/projectConfig/schema.js'
import { classifyScript, findTask, groupTasksByKind, resolveTasks } from '../src/tasks/model.js'

/** Task resolution decides what "build / run / test" means for a directory:
 *  explicit config tasks first, then package.json scripts classified by name. */

function config(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { ...DEFAULT_PROJECT_CONFIG, ...overrides }
}

describe('classifyScript', () => {
  it('classifies by name, including suffixed variants', () => {
    expect(classifyScript('build')).toBe('build')
    expect(classifyScript('build:web')).toBe('build')
    expect(classifyScript('test')).toBe('test')
    expect(classifyScript('coverage')).toBe('test')
    expect(classifyScript('lint')).toBe('lint')
    expect(classifyScript('typecheck')).toBe('lint')
    expect(classifyScript('dev')).toBe('run')
    expect(classifyScript('start')).toBe('run')
    expect(classifyScript('release-notes')).toBe('custom')
  })
})

describe('resolveTasks', () => {
  it('derives tasks from package.json scripts with the right package manager', () => {
    const tasks = resolveTasks({ config: config(), scripts: ['dev', 'build', 'test'], packageManager: 'pnpm' })
    expect(tasks.map((task) => [task.name, task.kind, task.commandLine])).toEqual([
      ['dev', 'run', 'pnpm run dev'],
      ['build', 'build', 'pnpm run build'],
      ['test', 'test', 'pnpm run test']
    ])
    expect(tasks.every((task) => task.source === 'script')).toBe(true)
  })

  it('marks dev-shaped scripts as background work', () => {
    const tasks = resolveTasks({ config: config(), scripts: ['dev', 'build'], packageManager: 'npm' })
    expect(tasks[0].background).toBe(true)
    expect(tasks[1].background).toBe(false)
  })

  it('puts config tasks first and does not duplicate a script they already cover', () => {
    const tasks = resolveTasks({
      config: config({ tasks: [{ name: 'build', kind: 'build', script: 'build' }] }),
      scripts: ['build', 'test'],
      packageManager: 'npm'
    })
    expect(tasks.map((task) => [task.name, task.source])).toEqual([
      ['build', 'config'],
      ['test', 'script']
    ])
  })

  it('keeps a config task whose name collides with a script from taking two slots', () => {
    const tasks = resolveTasks({
      config: config({ tasks: [{ name: 'test', kind: 'test', command: ['npx', 'vitest', 'run'] }] }),
      scripts: ['test'],
      packageManager: 'npm'
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ source: 'config', commandLine: 'npx vitest run' })
  })

  it('carries cwd, env and background through from the config', () => {
    const tasks = resolveTasks({
      config: config({
        tasks: [{ name: 'api', kind: 'run', command: ['node', 'server.js'], cwd: 'apps/api', env: { PORT: '3000' }, background: true }]
      }),
      scripts: [],
      packageManager: 'npm'
    })
    expect(tasks[0]).toMatchObject({ cwd: 'apps/api', env: { PORT: '3000' }, background: true, file: 'node', args: ['server.js'] })
  })

  it('honours discoverScripts: false', () => {
    const tasks = resolveTasks({
      config: config({ discoverScripts: false, tasks: [{ name: 'only', kind: 'custom', script: 'build' }] }),
      scripts: ['build', 'test'],
      packageManager: 'npm'
    })
    expect(tasks).toHaveLength(1)
  })

  it('gives every task a stable, distinct id', () => {
    const tasks = resolveTasks({
      config: config({ tasks: [{ name: 'build', kind: 'build', script: 'build' }] }),
      scripts: ['build', 'test'],
      packageManager: 'npm'
    })
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length)
    expect(findTask(tasks, 'config:build')).toMatchObject({ name: 'build' })
    expect(findTask(tasks, 'script:test')).toMatchObject({ name: 'test' })
    expect(findTask(tasks, 'script:nope')).toBeNull()
  })
})

describe('groupTasksByKind', () => {
  it('groups in display order and drops empty groups', () => {
    const tasks = resolveTasks({ config: config(), scripts: ['test', 'build'], packageManager: 'npm' })
    expect(groupTasksByKind(tasks).map((group) => group.kind)).toEqual(['build', 'test'])
  })
})
