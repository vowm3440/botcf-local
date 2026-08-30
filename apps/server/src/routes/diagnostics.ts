import { FastifyInstance } from 'fastify'
import {
  DIAGNOSTIC_ORIGINS,
  diagnosticsCenter,
  type Diagnostic,
  type DiagnosticOrigin,
  type DiagnosticSummary
} from '../diagnostics/center.js'
import type { DiagnosticSeverity } from '../diagnostics/parse.js'

/** Errors & diagnostics center surface.
 *
 *  Read-only apart from two writes: clearing, and the one report path the browser
 *  needs — a runtime error thrown *inside the live preview page*, which the server
 *  never sees itself. That payload is treated as untrusted text: fixed origin,
 *  bounded message, no path resolution beyond display. */

const SEVERITIES: DiagnosticSeverity[] = ['error', 'warning', 'info']

interface ListPayload {
  success: true
  items: Diagnostic[]
  summary: DiagnosticSummary
  origins: readonly DiagnosticOrigin[]
}

function listPayload(filter: { origin?: DiagnosticOrigin; severity?: DiagnosticSeverity }): ListPayload {
  return {
    success: true,
    items: diagnosticsCenter.list(filter),
    summary: diagnosticsCenter.summary(),
    origins: DIAGNOSTIC_ORIGINS
  }
}

export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { origin?: string; severity?: string } }>('/api/diagnostics', async (req, reply) => {
    const { origin, severity } = req.query
    if (origin !== undefined && !DIAGNOSTIC_ORIGINS.includes(origin as DiagnosticOrigin)) {
      return reply.code(400).send({ success: false, error: `origin 必须是 ${DIAGNOSTIC_ORIGINS.join('/')}` })
    }
    if (severity !== undefined && !SEVERITIES.includes(severity as DiagnosticSeverity)) {
      return reply.code(400).send({ success: false, error: 'severity 必须是 error/warning/info' })
    }
    return listPayload({
      ...(origin ? { origin: origin as DiagnosticOrigin } : {}),
      ...(severity ? { severity: severity as DiagnosticSeverity } : {})
    })
  })

  app.post<{ Body: { origin?: string; groupId?: string } }>('/api/diagnostics/clear', async (req, reply) => {
    const { origin, groupId } = req.body ?? {}
    if (origin !== undefined && !DIAGNOSTIC_ORIGINS.includes(origin as DiagnosticOrigin)) {
      return reply.code(400).send({ success: false, error: `origin 必须是 ${DIAGNOSTIC_ORIGINS.join('/')}` })
    }
    if (groupId !== undefined && typeof groupId !== 'string') {
      return reply.code(400).send({ success: false, error: 'groupId 必须是字符串' })
    }
    const cleared = diagnosticsCenter.clear({
      ...(origin ? { origin: origin as DiagnosticOrigin } : {}),
      ...(groupId ? { groupId } : {})
    })
    return { ...listPayload({}), cleared }
  })

  /** Runtime error relayed from the sandboxed preview page. */
  app.post<{ Body: { message?: string; path?: string; line?: number } }>(
    '/api/diagnostics/runtime',
    async (req, reply) => {
      const { message, path: filePath, line } = req.body ?? {}
      if (typeof message !== 'string' || message.trim() === '') {
        return reply.code(400).send({ success: false, error: '缺少 message' })
      }
      if (filePath !== undefined && typeof filePath !== 'string') {
        return reply.code(400).send({ success: false, error: 'path 必须是字符串' })
      }
      if (line !== undefined && (typeof line !== 'number' || !Number.isFinite(line))) {
        return reply.code(400).send({ success: false, error: 'line 必须是数字' })
      }
      diagnosticsCenter.note({
        origin: 'runtime',
        source: '预览页面',
        tool: 'browser',
        message: message.trim().slice(0, 1_000),
        ...(filePath ? { path: filePath.slice(0, 300) } : {}),
        ...(line !== undefined ? { line: Math.max(1, Math.trunc(line)) } : {})
      })
      return { success: true }
    }
  )

  app.get('/api/diagnostics/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (): void => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'diagnostics', ...listPayload({}) })}\n\n`)
    }
    send()
    // A watch-mode build can report hundreds of findings in a burst; coalesce
    // them into one frame per tick instead of one frame per finding.
    let pending: NodeJS.Timeout | null = null
    const onChanged = (): void => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        send()
      }, 120)
      pending.unref?.()
    }
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    diagnosticsCenter.on('changed', onChanged)
    const cleanup = (): void => {
      if (pending) clearTimeout(pending)
      clearInterval(keepalive)
      diagnosticsCenter.off('changed', onChanged)
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })
}
