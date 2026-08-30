import { useCallback, useEffect, useRef, useState } from 'react'
import RootPicker from './RootPicker'
import { BUTTON, EMPTY_HINT, INPUT, MONO, PANEL_BODY, PRIMARY_BUTTON, SCROLL_AREA, SELECT, STATUS_LINE, TOOLBAR } from './ui'
import { notifyProjectConfigSaved } from '../panels/events'
import {
  projectConfigApi,
  type ProjectConfig,
  type ProjectConfigResponse,
  type ProjectTaskConfig
} from '../services/projectConfig'
import type { ShellKind } from '../services/terminal'
import type { TaskKind } from '../services/tasks'
import { onWorkspaceChanged } from '../workspace/events'

/** Project-level configuration (`<root>/.botcf/config.json`).
 *
 *  One config per workspace root: tasks, preview defaults, terminal shell and the
 *  review/commit behaviour. Two editing modes, because both are genuinely useful —
 *  a form for the common fields and the raw JSON for everything else (per-task
 *  environment variables, hand-written command arrays).
 *
 *  The form only *edits* a subset but always saves the whole config it loaded, so
 *  fields it does not render (per-task env) survive untouched. The server answers
 *  with the normalized config plus warnings, which are shown verbatim: an entry it
 *  rejected must never look like it was stored. */

const KIND_OPTIONS: Array<{ value: TaskKind; label: string }> = [
  { value: 'build', label: '构建' },
  { value: 'run', label: '运行' },
  { value: 'test', label: '测试' },
  { value: 'lint', label: '检查' },
  { value: 'custom', label: '其他' }
]

function emptyTask(): ProjectTaskConfig {
  return { name: '', kind: 'custom', command: [] }
}

/** `KEY=value` lines ⇄ record, the form-friendly shape for env maps. */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return env
}

export default function ProjectConfigPanel() {
  const [data, setData] = useState<ProjectConfigResponse | null>(null)
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [terminalEnvText, setTerminalEnvText] = useState('')
  const [rootId, setRootId] = useState('')
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const rootRef = useRef('')

  const adopt = useCallback((response: ProjectConfigResponse) => {
    setData(response)
    setConfig(response.config)
    setTerminalEnvText(envToText(response.config.terminal.env))
    setText(response.text ?? `${JSON.stringify(response.config, null, 2)}\n`)
    setWarnings(response.warnings)
    rootRef.current = response.root.id
    setRootId(response.root.id)
  }, [])

  const load = useCallback(async (root?: string) => {
    try {
      adopt(await projectConfigApi.load(root ?? rootRef.current))
      setNotice(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '项目配置读取失败')
    }
  }, [adopt])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  useEffect(() => onWorkspaceChanged(() => { load().catch(() => undefined) }), [load])

  const save = async (): Promise<void> => {
    if (!config) return
    setBusy(true)
    try {
      const response =
        mode === 'json'
          ? await projectConfigApi.save({ root: rootId, text })
          : await projectConfigApi.save({
              root: rootId,
              config: { ...config, terminal: { ...config.terminal, env: textToEnv(terminalEnvText) } }
            })
      adopt(response)
      notifyProjectConfigSaved(response.root.id)
      setNotice(response.warnings.length > 0 ? `已保存,但有 ${response.warnings.length} 条提示` : '已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const patch = (change: Partial<ProjectConfig>): void => {
    setConfig((prev) => (prev ? { ...prev, ...change } : prev))
  }

  const patchTask = (index: number, change: Partial<ProjectTaskConfig>): void => {
    setConfig((prev) => {
      if (!prev) return prev
      const tasks = prev.tasks.map((task, position) => (position === index ? { ...task, ...change } : task))
      return { ...prev, tasks }
    })
  }

  const label = { fontSize: 12, color: '#57606a', display: 'block', marginBottom: 2 } as const
  const field = { marginBottom: 10 } as const

  return (
    <div style={PANEL_BODY}>
      <div style={TOOLBAR}>
        <RootPicker
          roots={data?.roots ?? []}
          value={rootId}
          disabled={busy}
          label="配置目录"
          onChange={(id) => { load(id).catch(() => undefined) }}
        />
        <button style={{ ...BUTTON, background: mode === 'form' ? '#eaf3ff' : '#fff' }} onClick={() => setMode('form')}>
          表单
        </button>
        <button style={{ ...BUTTON, background: mode === 'json' ? '#eaf3ff' : '#fff' }} onClick={() => setMode('json')}>
          JSON
        </button>
        <span style={{ flex: 1 }} />
        {data && !data.exists && (
          <button
            style={BUTTON}
            disabled={busy}
            title="在这个目录创建 .botcf/config.json"
            onClick={() => {
              setBusy(true)
              projectConfigApi
                .init(rootId)
                .then((response) => {
                  adopt(response)
                  notifyProjectConfigSaved(response.root.id)
                  setNotice('已创建配置文件')
                })
                .catch((error: unknown) => setNotice(error instanceof Error ? error.message : '创建失败'))
                .finally(() => setBusy(false))
            }}
          >
            创建配置文件
          </button>
        )}
        <button style={PRIMARY_BUTTON} disabled={busy || !config} onClick={() => { save().catch(() => undefined) }}>
          保存
        </button>
      </div>

      <div style={{ ...STATUS_LINE, color: notice?.includes('失败') ? '#c00' : '#666' }} title={data?.file ?? ''}>
        {notice ?? (data ? `${data.file}${data.exists ? '' : ' (尚未创建,使用默认配置)'}` : '读取配置…')}
      </div>

      {warnings.length > 0 && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: '#9a6700', background: '#fffbe6', borderBottom: '1px solid #ffe58f', maxHeight: 90, overflow: 'auto' }}>
          {warnings.map((warning, index) => (
            <div key={index}>{warning}</div>
          ))}
        </div>
      )}

      {!config ? (
        <div style={EMPTY_HINT}>加载中…</div>
      ) : mode === 'json' ? (
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          wrap="off"
          aria-label="项目配置 JSON"
          style={{ flex: 1, minHeight: 0, margin: 8, padding: 8, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, border: '1px solid #eee', borderRadius: 6, resize: 'none', outline: 'none', whiteSpace: 'pre' }}
        />
      ) : (
        <div style={{ ...SCROLL_AREA, padding: 10 }}>
          <div style={field}>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={config.discoverScripts}
                onChange={(event) => patch({ discoverScripts: event.target.checked })}
              />
              自动把 package.json 脚本识别为任务(按名字归类到构建/运行/测试/检查)
            </label>
          </div>

          <div style={field}>
            <span style={label}>实时预览</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                aria-label="预览模式"
                value={config.preview.mode}
                onChange={(event) => patch({ preview: { ...config.preview, mode: event.target.value as ProjectConfig['preview']['mode'] } })}
                style={SELECT}
              >
                <option value="auto">自动</option>
                <option value="static">静态</option>
                <option value="command">命令</option>
              </select>
              <input
                value={config.preview.script ?? ''}
                onChange={(event) => patch({ preview: { ...config.preview, script: event.target.value || null } })}
                placeholder="dev 脚本名(命令模式)"
                aria-label="预览脚本"
                style={{ ...INPUT, flex: 1 }}
              />
            </div>
          </div>

          <div style={field}>
            <span style={label}>内置终端</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <select
                aria-label="终端 shell"
                value={config.terminal.shell ?? ''}
                onChange={(event) => patch({ terminal: { ...config.terminal, shell: (event.target.value || null) as ShellKind | null } })}
                style={SELECT}
              >
                <option value="">跟随平台默认{data ? ` (${data.platformShell})` : ''}</option>
                {(data?.shellKinds ?? []).map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={terminalEnvText}
              onChange={(event) => setTerminalEnvText(event.target.value)}
              placeholder={'终端环境变量,每行 KEY=value'}
              aria-label="终端环境变量"
              spellCheck={false}
              style={{ width: '100%', boxSizing: 'border-box', minHeight: 52, padding: 6, fontFamily: MONO, fontSize: 12, border: '1px solid #eee', borderRadius: 6, resize: 'vertical' }}
            />
          </div>

          <div style={field}>
            <span style={label}>AI 修改审查</span>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={config.review.stageOnAccept}
                onChange={(event) => patch({ review: { ...config.review, stageOnAccept: event.target.checked } })}
              />
              接受修改时自动 git add(提交时就只包含审查过的内容)
            </label>
            <input
              value={config.review.commitTemplate}
              onChange={(event) => patch({ review: { ...config.review, commitTemplate: event.target.value } })}
              placeholder="提交信息模板,可用 {count} 与 {files}"
              aria-label="提交信息模板"
              style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          <div style={field}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ ...label, marginBottom: 0, flex: 1 }}>任务 ({config.tasks.length})</span>
              <button style={BUTTON} onClick={() => patch({ tasks: [...config.tasks, emptyTask()] })}>
                添加任务
              </button>
            </div>
            {config.tasks.length === 0 && (
              <div style={{ fontSize: 11, color: '#8c959f', marginBottom: 6 }}>
                没有显式任务。package.json 脚本已经会被自动识别;需要自定义命令、子目录或环境变量时在这里添加。
              </div>
            )}
            {config.tasks.map((task, index) => (
              <div key={index} style={{ border: '1px solid #eee', borderRadius: 6, padding: 8, marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <input
                    value={task.name}
                    onChange={(event) => patchTask(index, { name: event.target.value })}
                    placeholder="任务名"
                    aria-label={`任务 ${index + 1} 名称`}
                    style={{ ...INPUT, flex: 1 }}
                  />
                  <select
                    aria-label={`任务 ${index + 1} 类型`}
                    value={task.kind}
                    onChange={(event) => patchTask(index, { kind: event.target.value as TaskKind })}
                    style={{ ...SELECT, maxWidth: 100 }}
                  >
                    {KIND_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    style={BUTTON}
                    aria-label={`删除任务 ${index + 1}`}
                    onClick={() => patch({ tasks: config.tasks.filter((_, position) => position !== index) })}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <input
                    value={task.script ?? ''}
                    onChange={(event) => patchTask(index, { script: event.target.value || undefined })}
                    placeholder="package.json 脚本名"
                    aria-label={`任务 ${index + 1} 脚本`}
                    style={{ ...INPUT, flex: 1 }}
                  />
                  <input
                    value={(task.command ?? []).join(' ')}
                    onChange={(event) =>
                      patchTask(index, { command: event.target.value.split(/\s+/).filter(Boolean) })
                    }
                    placeholder="或命令行,如 npx tsc --noEmit(空格分隔,不支持空格参数)"
                    aria-label={`任务 ${index + 1} 命令`}
                    style={{ ...INPUT, flex: 2, fontFamily: MONO }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={task.cwd ?? ''}
                    onChange={(event) => patchTask(index, { cwd: event.target.value || undefined })}
                    placeholder="子目录(相对本目录)"
                    aria-label={`任务 ${index + 1} 子目录`}
                    style={{ ...INPUT, flex: 1, fontFamily: MONO }}
                  />
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={task.background === true}
                      onChange={(event) => patchTask(index, { background: event.target.checked || undefined })}
                    />
                    常驻(dev server)
                  </label>
                  {task.env && Object.keys(task.env).length > 0 && (
                    <span style={{ fontSize: 11, color: '#8c959f' }}>env {Object.keys(task.env).length} 项(JSON 模式编辑)</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, color: '#8c959f', lineHeight: 1.7 }}>
            命令参数只允许字母、数字与 <span style={{ fontFamily: MONO }}>_ @ : . , = + ~ / \ -</span>,
            不允许空格与 shell 元字符;任务只在你点击「运行」时才会执行。
          </div>
        </div>
      )}
    </div>
  )
}
