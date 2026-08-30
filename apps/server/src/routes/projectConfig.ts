import { FastifyInstance } from 'fastify'
import { loadProjectConfig, saveProjectConfig } from '../projectConfig/store.js'
import {
  DEFAULT_PROJECT_CONFIG,
  checkProjectConfig,
  checkProjectConfigText,
  TASK_KINDS,
  type ProjectConfig
} from '../projectConfig/schema.js'
import { SHELL_KINDS, defaultShell } from '../terminal/shell.js'
import { workspaceRootInfos } from '../workspace/locate.js'
import { requireWorkspaceRoot } from '../workspace/resolveRoot.js'
import { getWorkspace } from '../workspace/store.js'

/** Project-level configuration surface (`<root>/.botcf/config.json`).
 *
 *  One config per workspace root, so a workspace of several projects keeps their
 *  task lists, preview defaults and terminal shells apart. Saving always writes
 *  the *normalized* config and returns the validation warnings, which is how the
 *  UI tells the user that an entry was rejected rather than silently dropped. */

interface SaveBody {
  root?: string
  /** Structured config from the settings form. */
  config?: unknown
  /** Raw JSON text from the "edit as file" mode; used when `config` is absent. */
  text?: string
}

function payload(root: { id: string; name: string; path: string }) {
  const loaded = loadProjectConfig(root.path)
  return {
    success: true as const,
    root: { id: root.id, name: root.name, path: root.path },
    roots: workspaceRootInfos(getWorkspace()),
    file: loaded.file,
    exists: loaded.exists,
    config: loaded.config,
    warnings: loaded.warnings,
    text: loaded.text,
    mtimeMs: loaded.mtimeMs,
    defaults: DEFAULT_PROJECT_CONFIG,
    /** Choices the UI may offer, straight from the schema. */
    taskKinds: TASK_KINDS,
    shellKinds: SHELL_KINDS,
    platformShell: defaultShell().kind
  }
}

export function registerProjectConfigRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { root?: string } }>('/api/project-config', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.query.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    return payload(resolved.root)
  })

  /** Save the config. Accepts either a structured object or the raw file text;
   *  both go through the same validation, and both answer with the warnings.
   *
   *  Input we cannot understand is a 400 that writes nothing: the read path
   *  degrades a broken file to defaults so the project still opens, and reusing
   *  that on the write path meant saving `{bad json` replaced the user's config
   *  with those defaults under an HTTP 200. */
  app.post<{ Body: SaveBody }>('/api/project-config', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const { config, text } = req.body ?? {}
    if (config === undefined && typeof text !== 'string') {
      return reply.code(400).send({ success: false, error: '缺少 config 或 text' })
    }
    const checked = config !== undefined ? checkProjectConfig(config) : checkProjectConfigText(text as string)
    if (!checked.ok) return reply.code(400).send({ success: false, error: checked.error })
    const saved = saveProjectConfig(resolved.root.path, checked.config)
    if (!saved.ok) return reply.code(500).send({ success: false, error: `配置写入失败: ${saved.error}` })
    return { ...payload(resolved.root), warnings: [...checked.warnings, ...saved.loaded.warnings] }
  })

  /** Create the file with defaults, so the user has something to edit. */
  app.post<{ Body: { root?: string } }>('/api/project-config/init', async (req, reply) => {
    const resolved = requireWorkspaceRoot(req.body?.root)
    if (!resolved.ok) return reply.code(resolved.status).send({ success: false, error: resolved.error })
    const loaded = loadProjectConfig(resolved.root.path)
    if (loaded.exists) return { ...payload(resolved.root), created: false }
    const template: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, tasks: [] }
    const saved = saveProjectConfig(resolved.root.path, template)
    if (!saved.ok) return reply.code(500).send({ success: false, error: `配置写入失败: ${saved.error}` })
    return { ...payload(resolved.root), created: true }
  })
}
