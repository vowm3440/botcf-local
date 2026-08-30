import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_COMMIT_TEMPLATE,
  MAX_TASKS,
  checkProjectConfig,
  checkProjectConfigText,
  normalizeProjectConfig,
  parseProjectConfig,
  renderCommitMessage,
  serializeProjectConfig
} from '../src/projectConfig/schema.js'
import {
  CONFIG_DIR_NAME,
  clearProjectConfigCache,
  loadProjectConfig,
  projectConfigFile,
  saveProjectConfig
} from '../src/projectConfig/store.js'

/** The config file lives inside the project, so it is untrusted input: it may
 *  declare tasks, never widen what the app can do. Every rejection must be
 *  visible as a warning rather than a silent drop. */

const temp: string[] = []

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-config-'))
  temp.push(dir)
  return dir
}

afterEach(() => {
  clearProjectConfigCache()
  while (temp.length > 0) {
    fs.rmSync(temp.pop() as string, { recursive: true, force: true })
  }
})

describe('parseProjectConfig', () => {
  it('returns defaults for missing or unparsable text', () => {
    expect(parseProjectConfig(null).config.discoverScripts).toBe(true)
    expect(parseProjectConfig('   ').warnings).toEqual([])
    const broken = parseProjectConfig('{ not json')
    expect(broken.config.tasks).toEqual([])
    expect(broken.warnings[0]).toContain('JSON')
  })

  it('keeps a valid script task and a valid command task', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({
        tasks: [
          { name: '构建', kind: 'build', script: 'build' },
          { name: '类型检查', kind: 'lint', command: ['npx', 'tsc', '--noEmit'], cwd: 'apps/server' }
        ]
      })
    )
    expect(warnings).toEqual([])
    expect(config.tasks[0]).toMatchObject({ name: '构建', kind: 'build', script: 'build' })
    expect(config.tasks[1]).toMatchObject({ command: ['npx', 'tsc', '--noEmit'], cwd: 'apps/server' })
  })

  it('rejects command tokens with spaces or shell metacharacters', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({ tasks: [{ name: 'bad', command: ['npm', 'run build && rm -rf /'] }] })
    )
    expect(config.tasks).toEqual([])
    expect(warnings.join()).toContain('不允许的字符')
  })

  it('rejects a task without script or command, and an unnamed task', () => {
    const { config, warnings } = parseProjectConfig(JSON.stringify({ tasks: [{ name: 'empty' }, { script: 'build' }] }))
    expect(config.tasks).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('drops a duplicate task name', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({ tasks: [{ name: 'build', script: 'build' }, { name: 'Build', script: 'build:ci' }] })
    )
    expect(config.tasks).toHaveLength(1)
    expect(warnings.join()).toContain('重复')
  })

  it('refuses a cwd that walks out of the root or names a drive', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({ tasks: [{ name: 'a', script: 'build', cwd: '../evil' }, { name: 'b', script: 'build', cwd: 'C:/windows' }] })
    )
    expect(config.tasks[0].cwd).toBeUndefined()
    expect(config.tasks[1].cwd).toBeUndefined()
    expect(warnings.filter((warning) => warning.includes('cwd'))).toHaveLength(2)
  })

  it('validates env keys and values', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({
        tasks: [{ name: 'a', script: 'build', env: { GOOD: '1', '2BAD': 'x', MULTI: 'line\nbreak' } }]
      })
    )
    expect(config.tasks[0].env).toEqual({ GOOD: '1' })
    expect(warnings).toHaveLength(2)
  })

  it('caps the task list', () => {
    const tasks = Array.from({ length: MAX_TASKS + 5 }, (_, index) => ({ name: `t${index}`, script: 'build' }))
    const { config, warnings } = parseProjectConfig(JSON.stringify({ tasks }))
    expect(config.tasks).toHaveLength(MAX_TASKS)
    expect(warnings.join()).toContain(`${MAX_TASKS}`)
  })

  it('only accepts a known shell kind', () => {
    expect(parseProjectConfig(JSON.stringify({ terminal: { shell: 'bash' } })).config.terminal.shell).toBe('bash')
    const rejected = parseProjectConfig(JSON.stringify({ terminal: { shell: '/bin/evil' } }))
    expect(rejected.config.terminal.shell).toBeNull()
    expect(rejected.warnings.join()).toContain('terminal.shell')
  })

  it('validates preview mode and script name', () => {
    const { config, warnings } = parseProjectConfig(JSON.stringify({ preview: { mode: 'weird', script: 'a b' } }))
    expect(config.preview).toEqual({ mode: 'auto', script: null })
    expect(warnings).toHaveLength(2)
  })

  it('keeps review defaults and accepts a template', () => {
    expect(parseProjectConfig('{}').config.review).toEqual({ stageOnAccept: true, commitTemplate: DEFAULT_COMMIT_TEMPLATE })
    const custom = parseProjectConfig(JSON.stringify({ review: { stageOnAccept: false, commitTemplate: 'ai: {count}' } }))
    expect(custom.config.review).toEqual({ stageOnAccept: false, commitTemplate: 'ai: {count}' })
  })

  it('notes an unknown version but still parses', () => {
    const { config, warnings } = parseProjectConfig(JSON.stringify({ version: 99, discoverScripts: false }))
    expect(config.discoverScripts).toBe(false)
    expect(warnings.join()).toContain('版本')
  })

  it('normalizeProjectConfig rejects a non-object root', () => {
    expect(normalizeProjectConfig([1, 2, 3]).warnings.join()).toContain('对象')
  })

  it('round-trips through serialization', () => {
    const { config } = parseProjectConfig(JSON.stringify({ tasks: [{ name: 'a', script: 'build', kind: 'build' }] }))
    expect(parseProjectConfig(serializeProjectConfig(config)).config).toEqual(config)
  })
})

describe('renderCommitMessage', () => {
  it('substitutes count and file names', () => {
    expect(renderCommitMessage('ai: {count} 个文件 — {files}', ['src/a.ts', 'src/b.ts'])).toBe('ai: 2 个文件 — a.ts, b.ts')
  })

  it('summarizes a long file list', () => {
    const files = Array.from({ length: 7 }, (_, index) => `src/f${index}.ts`)
    expect(renderCommitMessage('{files}', files)).toContain('等 7 个')
  })
})

describe('project config store', () => {
  it('reports a missing file as defaults', () => {
    const root = tempRoot()
    const loaded = loadProjectConfig(root)
    expect(loaded.exists).toBe(false)
    expect(loaded.config.discoverScripts).toBe(true)
    expect(loaded.file).toBe(projectConfigFile(root))
  })

  it('writes into .botcf/, then reads it back normalized', () => {
    const root = tempRoot()
    const saved = saveProjectConfig(root, {
      ...parseProjectConfig('{}').config,
      tasks: [{ name: '构建', kind: 'build', script: 'build' }]
    })
    expect(saved.ok).toBe(true)
    expect(fs.existsSync(path.join(root, CONFIG_DIR_NAME, 'config.json'))).toBe(true)
    const loaded = loadProjectConfig(root)
    expect(loaded.exists).toBe(true)
    expect(loaded.config.tasks[0].name).toBe('构建')
    expect(loaded.text).toContain('"tasks"')
  })

  it('surfaces warnings for a hand-edited file', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, CONFIG_DIR_NAME), { recursive: true })
    fs.writeFileSync(projectConfigFile(root), JSON.stringify({ tasks: [{ name: 'x' }] }), 'utf8')
    expect(loadProjectConfig(root).warnings.join()).toContain('script 或 command')
  })

  it('re-reads after the file changes on disk', () => {
    const root = tempRoot()
    saveProjectConfig(root, { ...parseProjectConfig('{}').config, discoverScripts: true })
    expect(loadProjectConfig(root).config.discoverScripts).toBe(true)
    fs.writeFileSync(projectConfigFile(root), JSON.stringify({ discoverScripts: false }), 'utf8')
    clearProjectConfigCache()
    expect(loadProjectConfig(root).config.discoverScripts).toBe(false)
  })
})

/** Reading a broken config degrades to defaults so the project still opens.
 *  Saving one must not: the last valid config on disk is data the user cannot get
 *  back, and `{bad json` used to replace it with the defaults under an HTTP 200. */
describe('checkProjectConfigText / checkProjectConfig (write path)', () => {
  it('rejects a syntax error instead of falling back to defaults', () => {
    const rejected = checkProjectConfigText('{bad json')
    expect(rejected.ok).toBe(false)
    expect(rejected.ok === false && rejected.error).toContain('合法 JSON')
  })

  it('rejects empty text and a non-object root', () => {
    expect(checkProjectConfigText('   ').ok).toBe(false)
    expect(checkProjectConfigText('[1,2,3]').ok).toBe(false)
    expect(checkProjectConfigText('"nope"').ok).toBe(false)
    expect(checkProjectConfig(null).ok).toBe(false)
    expect(checkProjectConfig([1, 2, 3]).ok).toBe(false)
  })

  it('accepts valid JSON and still reports field-level rejections as warnings', () => {
    const accepted = checkProjectConfigText(JSON.stringify({ tasks: [{ name: 'x' }], discoverScripts: false }))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.config.discoverScripts).toBe(false)
    expect(accepted.warnings.join()).toContain('script 或 command')
  })

  it('leaves the file on disk byte-identical when the input is rejected', () => {
    const root = tempRoot()
    const valid = checkProjectConfigText(
      JSON.stringify({ terminal: { shell: 'bash', env: { CUSTOM_KEEP_ME: 'sentinel' } } })
    )
    expect(valid.ok).toBe(true)
    if (!valid.ok) return
    expect(saveProjectConfig(root, valid.config).ok).toBe(true)

    const file = projectConfigFile(root)
    const before = fs.readFileSync(file)
    const stat = fs.statSync(file)

    // What the route does with a rejection: nothing at all.
    const rejected = checkProjectConfigText('{bad json')
    expect(rejected.ok).toBe(false)

    expect(fs.readFileSync(file).equals(before)).toBe(true)
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs)
    clearProjectConfigCache()
    expect(loadProjectConfig(root).config.terminal.env).toEqual({ CUSTOM_KEEP_ME: 'sentinel' })
  })
})
