'use strict'

/** A stand-in for the agent runtime, speaking the real RPC contract.
 *
 *  Three things in this app are written only by a *real agent turn*, and no harness
 *  has ever reached them: the review panel's pending list (`recordAgentTurn`, called
 *  from the OMP branch of routes/chat.ts), the agent-origin half of the diagnostics
 *  centre, and the chat stream itself. `harness/inject.js` fakes the upstream in the
 *  renderer, which is enough to put a diff in front of the editor and no further —
 *  the server never sees a turn, so its stores stay empty.
 *
 *  The alternative was an HTTP route that records a turn, and that is a hole in the
 *  product for the benefit of a test. This is the other answer: a process that speaks
 *  the protocol the app already speaks (rpc.md / apps/server/src/omp/rpc.ts), so the
 *  server runs its real OMP branch against it and every store downstream fills the
 *  way it does in production.
 *
 *  Wire contract, as `OmpRpcClient` implements it:
 *    stdin   {id?, type: "<command>", ...params}, one JSON object per line
 *    stdout  {type:"ready"} once, then {type:"response", id, command, success,
 *            data|error} per command, plus AgentSessionEvent frames in between.
 *
 *  The turn it performs is read from `OMP_STUB_PLAN` — a JSON file holding
 *  `{ files: [{ path, diff, tool }], text }` — so the harness decides what the agent
 *  "did" without this file knowing anything about a fixture.
 *
 *  It answers only what the app asks for. Anything else gets a successful empty
 *  response rather than an error, because an unknown command here means the app grew
 *  a call this stub has not caught up with, and failing the handshake over it would
 *  hide that behind a startup error instead of showing it as a missing behaviour. */

const fs = require('node:fs')
const readline = require('node:readline')

const PLAN_FILE = process.env.OMP_STUB_PLAN
const SESSION_FILE = process.env.OMP_STUB_SESSION ?? ''

function readPlan() {
  if (!PLAN_FILE) return { files: [], text: 'stub' }
  try {
    return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))
  } catch {
    return { files: [], text: 'stub' }
  }
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function respond(id, command, data) {
  // `id` is absent for fire-and-forget frames; the client only correlates when it
  // sent one, so echoing it back unconditionally is correct and harmless.
  send({ type: 'response', id, command, success: true, data })
}

/** What `get_state` reports. `set_model` has to be reflected here or
 *  `applyActiveRouteToOmp` fails its own verification and stops the process — the
 *  app checks that the runtime really took the route, and so it should. */
const state = {
  model: null,
  thinkingLevel: 'medium',
  isStreaming: false,
  sessionFile: SESSION_FILE,
  contextUsage: { tokens: 1_200, contextWindow: 200_000, percent: 0.6 }
}

let turn = 0

/** One turn: a tool call that changed files, then a terminal `agent_end`.
 *
 *  The shape matters more than the content. `normalizeToolEvent` reads the changed
 *  path out of `args` and the unified diff out of `result.details.diff`, and
 *  `isTerminalAgentEnd` only treats `agent_end` as the end of a turn when it is not
 *  explicitly non-terminal — so an intermediate step is emitted first, to keep this
 *  honest about the frame sequence the real runtime produces. */
async function runTurn(message) {
  const plan = readPlan()
  turn++
  state.isStreaming = true
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: plan.text ?? '好的。' } })

  for (const [index, file] of (plan.files ?? []).entries()) {
    const toolCallId = `stub-${turn}-${index}`
    const toolName = file.tool ?? 'edit_file'
    const args = { path: file.path }
    send({ type: 'tool_execution_start', toolCallId, toolName, args, intent: `修改 ${file.path}` })
    send({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      args,
      isError: false,
      result: { content: [{ type: 'text', text: `已修改 ${file.path}` }], details: { diff: file.diff } }
    })
  }

  // A non-terminal step first, then the real end — the client must ignore the former.
  send({ type: 'agent_end', isTerminal: false, messages: [] })
  send({
    type: 'agent_end',
    isTerminal: true,
    stopReason: 'stop',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: plan.text ?? '好的。' }] }]
  })
  state.isStreaming = false
  void message
}

const handlers = {
  get_state: () => ({ ...state }),
  get_available_models: () => ({ models: state.model ? [state.model] : [] }),
  set_model: (params) => {
    state.model = { provider: String(params.provider ?? ''), id: String(params.modelId ?? '') }
    return { ok: true }
  },
  set_thinking_level: (params) => {
    state.thinkingLevel = String(params.level ?? 'medium')
    return { ok: true }
  },
  get_session_stats: () => ({ input: 1_000 * turn, output: 200 * turn }),
  get_messages_page: () => ({ messages: [], nextCursor: undefined }),
  get_last_assistant_text: () => ({ text: readPlan().text ?? '好的。' }),
  new_session: () => ({ ok: true }),
  switch_session: () => ({ ok: true }),
  abort: () => {
    state.isStreaming = false
    return { ok: true }
  }
}

function onLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, type, ...params } = message
  if (type === 'prompt') {
    // Acked immediately; the turn completes through events, exactly as the real
    // runtime does — the app awaits the terminal `agent_end`, not this response.
    respond(id, type, { agentInvoked: true })
    runTurn(params.message).catch((error) => {
      send({ type: 'agent_end', isTerminal: true, stopReason: 'error', errorMessage: String(error), messages: [] })
    })
    return
  }
  const handler = handlers[type]
  respond(id, type, handler ? handler(params) : {})
}

readline.createInterface({ input: process.stdin }).on('line', onLine)
process.stdin.on('end', () => process.exit(0))

send({ type: 'ready', version: 'stub' })
