/** Renderer-side harness support: deliver a session diff through the real chat stream.
 *
 *  Injected into the page before a driver runs, and it defines exactly one thing:
 *  `window.__HARNESS__.deliverSessionDiff(files)`.
 *
 *  The app learns what the assistant changed on one path — `streamChat` POSTs
 *  `/api/chat/stream` and reads SSE frames, `useChatSession` folds `files_changed`
 *  into its `changedFiles` map, `Workbench` hands each path's diff to `EditorTabs`,
 *  and `FileViewer` turns that into the 内联 and 差异 views, the gutter bars and the
 *  change bands. No OMP process, no diff, and no coverage for any of it.
 *
 *  So the *upstream* is stubbed and nothing else. `fetch` is replaced for the chat
 *  stream URL alone, for the duration of one send, and restored afterwards — every
 *  other request in the page, including the file reads a tab switch is timed on, goes
 *  to the real server through the real `fetch`. The message is typed into the real
 *  composer and sent with a real Enter, so the turn runs the same code a user's turn
 *  runs. This is the same kind of fake the harness already applies to the model
 *  endpoint and the update server: something that is not there, answered where it
 *  would have answered.
 *
 *  What it is not is a hook in the application. Nothing in apps/web knows this file
 *  exists, and a refactor that changed how diffs reach the editor would break this
 *  loudly rather than keep passing against a seam built for the test. */

;(() => {
  const TAB_STRIP = '[role="tablist"][aria-label="打开的文件"]'
  const COMPOSER = 'textarea[aria-label="消息输入框"]'
  /** The rail button that brings the assistant back if the dock has it closed. */
  const CHAT_RAIL = '[aria-label="活动栏"] button[title^="AI 对话"]'

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function waitFor(label, predicate, timeoutMs) {
    const until = performance.now() + timeoutMs
    for (;;) {
      const value = predicate()
      if (value) return value
      if (performance.now() > until) throw new Error(`等待 ${label} 超时 (${Math.round(timeoutMs / 1000)}s)`)
      await sleep(16)
    }
  }

  function openTabs() {
    return [...document.querySelectorAll(`${TAB_STRIP} [role="tab"]`)]
  }

  function hasTab(path) {
    return openTabs().some((tab) => tab.title.startsWith(path))
  }

  /** One `Response` carrying the frames a finished turn would have streamed.
   *
   *  Built as a real `ReadableStream` rather than a string body because that is what
   *  `streamChat` consumes — it reads `res.body.getReader()` and splits on the blank
   *  line between SSE events, and a harness that handed it something simpler would be
   *  testing a different parser than the one that ships. */
  function sseResponse(frames) {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  function urlOf(input) {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (input && typeof input.url === 'string') return input.url
    return String(input)
  }

  /** Type into the composer and send, so the turn starts the way a user's does.
   *
   *  `execCommand('insertText')` fires the same `input` event a keystroke does, which
   *  is what React's `onChange` is listening for; assigning `.value` would not. The
   *  wait between typing and Enter is not superstition — `send` closes over the input
   *  state, so the Enter has to land on a render that has already seen the text. */
  async function submit(composer, text) {
    composer.focus()
    if (!document.execCommand('insertText', false, text)) throw new Error('对话输入框拒绝了输入')
    await sleep(0)
    await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    if (composer.value.trim() === '') throw new Error('对话输入框没有收到文本')
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  window.__HARNESS__ = {
    /** Send a message for real: no stub, no interception.
     *
     *  For the checks that need the *server* to run a turn — the review panel and the
     *  agent half of the diagnostics centre are written by `recordAgentTurn` and
     *  `diagnosticsCenter` on the OMP branch of routes/chat.ts, which a renderer-side
     *  fake can never reach. With a stub runtime behind the server (harness/ompStub.cjs)
     *  this is an end-to-end turn through every real layer. */
    async sendMessage(text, options = {}) {
      const timeoutMs = options.timeoutMs ?? 60_000
      const composer = await waitFor(
        '对话输入框',
        () => {
          const found = document.querySelector(COMPOSER)
          if (found && !found.disabled) return found
          document.querySelector(CHAT_RAIL)?.click()
          return null
        },
        timeoutMs
      )
      await submit(composer, text)
      return true
    },

    /** Deliver `files` (ChangedFileInfo[]) as one finished turn. Resolves once every
     *  path has a tab, which is the app's own signal that it accepted them: a turn's
     *  changed files each open a tab. Rejects, never hangs. */
    async deliverSessionDiff(files, options = {}) {
      const timeoutMs = options.timeoutMs ?? 60_000
      const composer = await waitFor(
        '对话输入框',
        () => {
          const found = document.querySelector(COMPOSER)
          if (found && !found.disabled) return found
          // The assistant pane can be closed or stacked behind another tab; the rail
          // button is how a user would bring it back, so it is how this does too.
          document.querySelector(CHAT_RAIL)?.click()
          return null
        },
        timeoutMs
      )

      const original = window.fetch
      // Bound once: the app calls `fetch(...)` unqualified, so a stored reference
      // would reach the native function with no receiver. Restoring puts the
      // *unbound* original back, so the page keeps the function it started with.
      const passthrough = original.bind(window)
      let served = 0
      window.fetch = function harnessFetch(input, init) {
        if (!urlOf(input).includes('/api/chat/stream')) return passthrough(input, init)
        served++
        return Promise.resolve(sseResponse([{ type: 'files_changed', files }, { type: 'done' }]))
      }

      try {
        await submit(composer, '(harness) 交付本轮变更')
        await waitFor('本轮变更被送出', () => served > 0, timeoutMs)
        await waitFor('变更文件的标签', () => files.every((file) => hasTab(file.path)), timeoutMs)
      } finally {
        // Only ours is removed: a later replacement by something else is not this
        // function's to undo.
        if (window.fetch.name === 'harnessFetch') window.fetch = original
      }
      return { served, tabs: openTabs().length }
    }
  }
})()
