/** Renderer-side half of the editor load measurement (perf/editor-load.cjs).
 *
 *  Runs inside the real page, against the real components: it opens the fixture files
 *  as tabs through the same window event the git, review and diagnostics panels use,
 *  types into the front one, switches between them and closes them all — then reports
 *  what each of those cost. Nothing here knows about thresholds; it measures, the main
 *  process judges.
 *
 *  Every wait in here is bounded, and that is a fix, not a style choice. The first
 *  version waited on `requestAnimationFrame` with no timeout, so on a desktop session
 *  that stopped delivering frame callbacks the whole gate sat at "driving the editor…"
 *  forever — twice, with no result file and nothing to diagnose. A measurement harness
 *  that can hang cannot prove anything about performance, so: the frame wait has its
 *  own ceiling, the run has a total ceiling, and a failure returns the stage it died
 *  in plus everything already measured rather than throwing the run away.
 *
 *  Reads `window.__PERF__` = { paths, changedFiles, inputSamples, switchRounds,
 *  timeoutMs, frameTimeoutMs, totalMs, burstSize, burstRounds, inlineScrollSteps }.
 *  Resolves to { ok: true, report } or { ok: false, stage, message, diagnostics,
 *  partial } — never rejects, never hangs. */

(async () => {
  const options = window.__PERF__
  const paths = options.paths
  const timeoutMs = options.timeoutMs ?? 60_000
  const frameTimeoutMs = options.frameTimeoutMs ?? 5_000
  const redispatchMs = options.redispatchMs ?? 1_500
  const totalMs = options.totalMs ?? 300_000
  /** Read here rather than at the loop, because `partial()` reports the burst size
   *  and has to be able to do so from a failure path that never reached the loop. */
  const burstSize = options.burstSize ?? 6
  const burstRounds = options.burstRounds ?? 6
  const inlineScrollSteps = options.inlineScrollSteps ?? 12
  /** Force a collection at every stage boundary — a diagnostic mode, see `heapMark`. */
  const gcMarks = options.gcMarks === true
  const deadline = performance.now() + totalMs

  /** Distinguishes "the app is slow" from "the app stopped answering", which the
   *  main process reports differently. */
  class PerfTimeout extends Error {}

  const progress = { stage: 'start', frames: 0, tabs: 0, layoutSink: 0 }
  window.__PERF_PROGRESS__ = progress

  /** Pushed to the main process over the console channel, so a run that dies has
   *  a location even when the renderer never returns anything. */
  function setStage(stage) {
    progress.stage = stage
    console.log(`[perf-stage] ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now()), frames: progress.frames })}`)
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function remaining() {
    return deadline - performance.now()
  }

  /** What to say about a stalled page. `visibility` is the field that matters:
   *  a hidden or occluded window is the reason frame callbacks stop arriving. */
  function diagnostics() {
    return {
      stage: progress.stage,
      framesDelivered: progress.frames,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      openTabs: editorTabs().length,
      allRoleTabs: document.querySelectorAll('[role="tab"]').length,
      mountedViewers: mountedViewers(),
      remainingMs: Math.round(remaining())
    }
  }

  /** Resolves just before the browser paints the frame our change is in — the
   *  closest thing to "the keystroke is on screen" without a compositor hook.
   *
   *  Bounded: Chromium stops delivering frame callbacks to a page it considers
   *  hidden, and an unbounded wait on one is not a measurement, it is a hang. */
  function nextFrame(label) {
    const budget = Math.min(frameTimeoutMs, Math.max(1, remaining()))
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new PerfTimeout(`frame callback 未在 ${Math.round(budget)} ms 内投递 (${label})`))
      }, budget)
      requestAnimationFrame(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        progress.frames++
        resolve()
      })
    })
  }

  /** Resolves once the frame our change is in has actually been painted.
   *
   *  `nextFrame` is not that moment, and the difference is the whole reason this
   *  exists. A rAF callback runs *before* style, layout and paint for its frame, so
   *  anything the editor still owes — laying out 12k lines, painting them — is not
   *  in the number when the callback fires. An optimisation that only moves work
   *  from the input handler to after the callback would show up as a large win at
   *  `nextFrame` and as nothing at all on screen.
   *
   *  A task queued from inside the rAF callback runs after that frame is committed,
   *  so this is the first point the character is genuinely visible. Both are
   *  reported; this is the one the gate judges. */
  function afterPaint(label) {
    return nextFrame(label).then(
      () =>
        new Promise((resolve, reject) => {
          const budget = Math.min(frameTimeoutMs, Math.max(1, remaining()))
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            reject(new PerfTimeout(`帧提交后的任务未在 ${Math.round(budget)} ms 内运行 (${label})`))
          }, budget)
          setTimeout(() => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          }, 0)
        })
    )
  }

  async function waitFor(label, predicate) {
    const until = performance.now() + Math.min(timeoutMs, Math.max(1, remaining()))
    for (;;) {
      const value = predicate()
      if (value) return value
      if (performance.now() > until) throw new PerfTimeout(`等待 ${label} 超时`)
      if (remaining() <= 0) throw new PerfTimeout(`总时限用尽于等待 ${label}`)
      await sleep(16)
    }
  }

  /** The editable surface of the front tab, once its content has actually landed.
   *
   *  Matched by `aria-label` rather than by tag: the surface is CodeMirror's
   *  contenteditable, not a `<textarea>`, and it renders only the viewport — so
   *  `textContent` is the visible lines, never the buffer. Anything in this file that
   *  wanted the whole document had to stop wanting it. */
  function surfaceFor(path) {
    const surface = document.querySelector(`[aria-label="编辑 ${path}"]`)
    return surface && surface.textContent.length > 0 ? surface : null
  }

  /** `role="tab"` is not unique to the editor: the dock panel strip
   *  (aria-label="面板标签") and the viewer header (aria-label="文件视图") use it
   *  too, so an unscoped count sees ~16 elements with 8 files open and no
   *  assertion on it can ever hold. Scope every editor-tab query to the strip
   *  that owns the open files. */
  const TAB_STRIP = '[role="tablist"][aria-label="打开的文件"]'

  function editorTabs() {
    return document.querySelectorAll(`${TAB_STRIP} [role="tab"]`)
  }

  function mountedViewers() {
    // A viewer is a textarea when the file is editable and a <pre> when it is not,
    // so count by the label both carry rather than by the tag.
    return document.querySelectorAll('[aria-label^="编辑 "], [aria-label^="查看 "]').length
  }

  function tabElement(path) {
    return [...editorTabs()].find((tab) => tab.title.startsWith(path)) ?? null
  }

  /** The 内联 view's row container, or null while it is not on screen.
   *
   *  Found through `data-line`, which the inline rows carry for their own reasons and
   *  nothing else in the page uses. Structural rather than by a test id on purpose:
   *  the harness must not be given a handle the application would otherwise not have,
   *  or a refactor that stopped rendering rows could keep this passing.
   *
   *  The container is the absolutely-positioned spacer that owns the whole scroll
   *  height whether or not its rows are in the DOM — which is exactly the pair of
   *  numbers this phase is here to compare. */
  function inlineRowHost() {
    const row = document.querySelector('[data-line]')
    const host = row ? row.parentElement : null
    return host && host.children.length > 0 ? host : null
  }

  /** One row per CODE_LINE_HEIGHT (editor/diffPalette.ts): the view's scroll height is
   *  arithmetic, which is what lets it window by index without measuring anything. */
  const INLINE_ROW_HEIGHT = 18

  function inlineRowCounts(host) {
    return {
      mounted: host.children.length,
      total: Math.round(host.getBoundingClientRect().height / INLINE_ROW_HEIGHT)
    }
  }

  /** One of the 内容 / 内联 / 差异 buttons above the open file. */
  function viewModeButton(label) {
    return (
      [...document.querySelectorAll('[role="tablist"][aria-label="文件视图"] [role="tab"]')].find(
        (button) => button.textContent.trim().startsWith(label)
      ) ?? null
    )
  }

  /** The 「显示全文」 toggle, matched on the title it carries only when the file is
   *  actually expandable — over FULL_VIEW_LIMIT the button is disabled and says so
   *  instead, so finding this one is itself the assertion that the branch is reachable. */
  function expandButton() {
    return document.querySelector('button[title^="在整份文件与仅改动附近之间切换"]')
  }

  async function closeAllTabs() {
    const strip = document.querySelector(TAB_STRIP)
    const closeAll = strip
      ? [...strip.querySelectorAll('button')].find((button) => button.title === '关闭全部标签页')
      : null
    if (!closeAll) throw new Error('找不到「全部关闭」按钮')
    closeAll.click()
    await waitFor('空编辑器', () => (editorTabs().length === 0 ? true : null))
  }

  /** Opens one file and waits for its editable surface, re-announcing while it
   *  waits.
   *
   *  `botcf:open-file` is a fire-and-forget window event with no buffering, so a
   *  dispatch that lands before the workbench has registered its listener is not
   *  queued — it is gone. The old code dispatched exactly once and then polled
   *  for sixty seconds for a request nobody ever heard, which is precisely how
   *  one run of this gate was spent entirely on a file that never opened. The
   *  workbench wait below makes that rare; re-announcing makes it impossible.
   *
   *  Re-announcing is safe: `useOpenTabs.open` is a pure state transition that
   *  activates an already-open path rather than duplicating it. */
  async function openTab(path) {
    const started = performance.now()
    let announced = -Infinity
    const area = await waitFor(`标签 ${path}`, () => {
      const now = performance.now()
      if (now - announced >= redispatchMs) {
        announced = now
        window.dispatchEvent(new CustomEvent('botcf:open-file', { detail: { path, activate: true } }))
      }
      return surfaceFor(path)
    })
    return { area, ms: performance.now() - started }
  }

  /** One keystroke, split into the browser's part and the application's.
   *
   *  `inputBlock` alone said 143 ms and two plausible fixes to the app moved it by
   *  nothing, because the number bundles work the *harness* does with work the *app*
   *  does. So the parts are told apart before any of them is called the bottleneck:
   *
   *    browserEdit — up to the moment dispatch begins: the editor's own edit
   *    react       — dispatch → onChange → re-render → the app's state write
   *
   *  `execCommand('insertText')` runs the same editing command the browser runs for a
   *  typed character: it edits at the caret and fires a real `input` event. An earlier
   *  version of this driver instead wrote the whole 948 KB buffer back through
   *  `HTMLTextAreaElement.prototype.value` and called that a keystroke. It was not one
   *  — a whole-value replacement made Blink rebuild the inner editor and lay out all
   *  12,001 lines, charging the editor for work no keystroke performs, and inventing a
   *  `write value` cost (11.7 ms p50) that does not exist when a person types. That
   *  alone was ~90% of the latency this gate used to report. The mode is gone rather
   *  than kept behind a flag: the surface is no longer a textarea, so it cannot be
   *  reproduced, and the numbers it produced are recorded in
   *  docs/perf-gate-2026-08-28.md instead.
   *
   *  The split point is a capture-phase listener on `window`: React attaches its own
   *  to the root container, so ours runs first and timestamps the boundary between the
   *  browser's work and the application's. */
  let dispatchAt = 0
  window.addEventListener('input', () => { dispatchAt = performance.now() }, true)

  function type(surface, text) {
    surface.focus()
    if (!document.execCommand('insertText', false, text)) throw new Error('insertText 被拒绝,无法置脏标签')
  }

  /** Focus is all the caret needs: a freshly mounted editor puts it at the start of
   *  the document, which is inside the rendered viewport. Typing there rather than at
   *  the end is if anything the more representative case, and it avoids scrolling a
   *  12k-line document to reach a caret position. */
  function placeCaret(surface) {
    surface.focus()
  }

  function typeMeasured() {
    dispatchAt = 0
    const t0 = performance.now()
    const inserted = document.execCommand('insertText', false, 'x')
    const t1 = performance.now()
    if (!inserted) throw new Error('insertText 被拒绝——编辑面没有焦点,量不到按键')
    // No `input` event means nothing was edited; timing that would be timing nothing.
    if (!dispatchAt) throw new Error('insertText 没有触发 input 事件')
    return { browserEdit: dispatchAt - t0, react: t1 - dispatchAt, total: t1 - t0 }
  }

  /** JS heap at a stage boundary.
   *
   *  The main process samples the heap twice — empty workbench, and after everything
   *  is closed — which is what a retention check needs. It leaves the *peak*
   *  unexplained, and the first clean run made that gap matter: the renderer's
   *  working set ended 397 MiB over an empty workbench while the JS heap ended only
   *  2.7 MiB up. Those two facts together do not say whether the peak was JS garbage
   *  the collector had not reached yet, or Blink structures for ~24k laid-out lines —
   *  and the answer decides whether the fix is allocation discipline or virtualising
   *  the text surface.
   *
   *  `performance.memory` is a property read, so taking it at each boundary costs
   *  nothing and perturbs nothing. `total` is the committed heap, which is the half
   *  that shows up in the working set.
   *
   *  `gcMarks` makes it collect first, and that is opt-in for a reason. Committed heap
   *  is what V8 happened to have asked the OS for, which moves by tens of megabytes
   *  between identical runs — five runs put the same phase at 59.7 and 101.8 MiB. A
   *  forced collection here turns these into live-data figures instead, which is the
   *  number you want when attributing allocation to a phase. It is off by default
   *  because a major GC costs tens of milliseconds and these boundaries sit between
   *  measured phases: with it on, the memory figures are not comparable to a default
   *  run, and that is exactly why the two are separate runs rather than one. */
  function heapMark() {
    const memory = performance.memory
    if (!memory) return null
    // Before the read, never inside a measured window: every call site here is a
    // phase boundary, and the loops that time keystrokes and scrolling are not.
    const collected = gcMarks && typeof window.gc === 'function'
    if (collected) { window.gc(); window.gc() }
    const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10
    return {
      usedMiB: mib(memory.usedJSHeapSize),
      totalMiB: mib(memory.totalJSHeapSize),
      ...(collected ? { collected: true } : {})
    }
  }

  const heapMarks = {}

  /** A run of keystrokes delivered inside one frame, and the same run with a layout
   *  forced after each one.
   *
   *  The single-keystroke loop types one character per frame, which is the one rate at
   *  which a forced synchronous layout per keystroke costs nothing extra: the browser
   *  was going to lay out once for that frame anyway. A probe against a bare textarea
   *  showed exactly that — removing the forced layout cut the input handler by 86% and
   *  moved the time on screen by nothing.
   *
   *  Real typing is not paced by the compositor. A fast typist, a held key, an IME
   *  committing a phrase and a paste all deliver several edits inside one frame, and
   *  that is the case a per-edit layout cannot be coalesced out of. Removing the app's
   *  forced layout was justified by that argument and *not* by a measurement — the same
   *  mistake that once attributed a 79.5 ms keystroke to the wrong cause. So it is
   *  measured here rather than argued.
   *
   *  The A/B needs no second build of the old code: forcing a layout read from the
   *  driver, on the same stack, immediately after the edit, forces exactly the layout
   *  the app used to force. `getBoundingClientRect()` is used rather than `scrollTop`
   *  because the surface handed around here is the content element, not the scroller,
   *  and a rect read forces layout whatever the element is. The result is accumulated
   *  into `progress`, which is reachable from `window.__PERF_PROGRESS__`, so it cannot
   *  be optimised away as dead. */
  async function burst(surface, size, forceLayout) {
    const started = performance.now()
    for (let n = 0; n < size; n++) {
      typeMeasured()
      if (forceLayout) progress.layoutSink += surface.getBoundingClientRect().height
    }
    await afterPaint(forceLayout ? '连打(强制布局)' : '连打')
    return performance.now() - started
  }

  function percentile(values, fraction) {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    return Math.round(sorted[Math.max(0, index)] * 100) / 100
  }

  function stats(values) {
    return {
      samples: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values.length ? Math.round(Math.max(...values) * 100) / 100 : null
    }
  }

  const openMs = []
  const inputBlockMs = []
  const inputFrameMs = []
  const inputPaintMs = []
  const burstPaintMs = []
  const burstForcedPaintMs = []
  const switchMs = []
  /** The parts `inputBlock` is made of; see `typeMeasured`. */
  const inputEditMs = []
  const inputReactMs = []
  /** What the 内联 view cost and how much of it it kept in the DOM. Filled by the
   *  inline phase; null fields mean the run never got that far. */
  const inlineScrollMs = []
  const inline = {
    deliverMs: null,
    /** Switching to 内容 and getting the file on screen with its regions decorated —
     *  the first read of the file, so this is the diff phase's equivalent of a tab
     *  switch rather than a view toggle. */
    contentMs: null,
    showMs: null,
    rowsTotal: null,
    /** The largest number of rows in the DOM at any point, scrolling included. This
     *  is the number the gate judges: a view that stopped windowing would hold every
     *  row at every moment, so a maximum is the honest reading of it. */
    rowsMountedPeak: null,
    scrollHeightPx: null,
    scrolledToPx: null,
    /** The same pair for 「显示全文」, on the one fixture file small enough to expand.
     *  Collapsed, the row count follows the changes; expanded, it follows the file —
     *  a different branch of `buildInlineRows` and the larger of the two. */
    fullCollapsedRows: null,
    fullShowMs: null,
    fullRowsTotal: null,
    fullRowsMountedPeak: null
  }

  /** Only the parts that were actually sampled, so a failure that died before typing
   *  reports nothing rather than a row of zeros. */
  function breakdown() {
    const parts = {
      browserEdit: inputEditMs,
      react: inputReactMs
    }
    const out = {}
    for (const [name, values] of Object.entries(parts)) {
      if (values.length > 0) out[name] = stats(values)
    }
    return out
  }

  /** Everything measured so far, whether the run finished or not. A failed gate
   *  still says how far it got and how slow that part was. */
  function partial() {
    return {
      open: stats(openMs),
      /** The first tab pays for the editor chunk as well as for the file; the rest
       *  are steady state. Reported apart because gating them together let a
       *  one-time cost be read as a regression in the per-tab cost — and the
       *  code-splitting decision in docs/perf-gate-2026-08-28.md §9 turned on
       *  exactly that confusion. */
      openFirst: openMs.length > 0 ? Math.round(openMs[0] * 100) / 100 : null,
      openSteady: stats(openMs.slice(1)),
      inputBlock: stats(inputBlockMs),
      inputFrame: stats(inputFrameMs),
      inputPaint: stats(inputPaintMs),
      /** Keystrokes inside one frame, with and without a layout forced per edit.
       *  The pair is the point — either it shows the difference the app's change was
       *  supposed to make at this rate, or the claim goes. See `burst`. */
      burst: {
        size: burstSize,
        paint: stats(burstPaintMs),
        paintWithForcedLayout: stats(burstForcedPaintMs)
      },
      tabSwitch: stats(switchMs),
      inline: { ...inline, scroll: stats(inlineScrollMs) },
      inputBreakdown: breakdown()
    }
  }

  try {
    // A frame has to arrive before anything is worth timing: if callbacks are not
    // being delivered at all, fail here — at the cheap check with a clear
    // diagnosis — instead of thirty keystrokes later.
    setStage('frame-clock')
    await nextFrame('初始帧')

    // The page finishing `loadURL` is not the workbench being ready: the panels
    // mount after the session and workspace requests resolve, and the listener
    // that opens files is registered by that subtree. Wait for it to exist
    // before announcing anything at it.
    setStage('workbench')
    await waitFor('工作台面板', () => document.querySelector('[role="tablist"][aria-label="面板标签"]'))

    // 1. Open every fixture file as a tab and leave a draft in each: eight *dirty*
    //    large tabs is the state the report measured, and a dirty tab is the one that
    //    cannot be thrown away when the viewer unmounts.
    setStage('open-tabs')
    heapMarks.beforeOpen = heapMark()
    for (const path of paths) {
      const opened = await openTab(path)
      openMs.push(opened.ms)
      type(opened.area, '\n// perf draft')
      await nextFrame(`打开 ${path}`)
      progress.tabs++
    }

    await waitFor('标签栏', () => (editorTabs().length === paths.length ? true : null))
    const dirtyTabs = document.querySelectorAll(`${TAB_STRIP} [role="tab"] [title="未保存"]`).length

    // 2. Typing in the front tab, with the other seven open behind it. This is the
    //    number the user feels: 「短输入」 in the original report was 714–904 ms.
    setStage('typing')
    heapMarks.afterOpen = heapMark()
    const front = paths[paths.length - 1]
    const frontArea = await waitFor(`前台标签 ${front}`, () => surfaceFor(front))
    const inputSamples = options.inputSamples ?? 30
    placeCaret(frontArea)
    // The caret has to be settled before the first sample, or sample 1 pays for the
    // focus as if it were part of a keystroke.
    await afterPaint('输入预热')
    for (let sample = 0; sample < inputSamples; sample++) {
      const started = performance.now()
      const split = typeMeasured()
      // React renders discrete events synchronously, so this is the frame the
      // keystroke blocked; the frame time then adds layout for the changed lines.
      inputBlockMs.push(performance.now() - started)
      inputEditMs.push(split.browserEdit)
      inputReactMs.push(split.react)
      await nextFrame(`按键 ${sample + 1}/${inputSamples}`)
      inputFrameMs.push(performance.now() - started)
      await afterPaint(`按键上屏 ${sample + 1}/${inputSamples}`)
      inputPaintMs.push(performance.now() - started)
    }
    // There is no aggregate "30 characters reached the buffer" check any more, and
    // that is not a loss: the surface renders its viewport, so the DOM never carries
    // the whole document to count. What replaced it is stricter — every sample asserts
    // that `insertText` was accepted *and* that a real `input` event followed, so a
    // keystroke that failed to land names itself instead of hiding in an average.

    // 2b. The same keystrokes with no frame between them, with and without a forced
    //     layout per edit. This is the rate at which the app's change is supposed to
    //     matter, and until now nothing measured it — see `burst`. The two variants
    //     alternate so that any drift in the machine falls on both equally.
    setStage('burst-typing')
    for (let round = 0; round < burstRounds; round++) {
      burstPaintMs.push(await burst(frontArea, burstSize, false))
      burstForcedPaintMs.push(await burst(frontArea, burstSize, true))
    }

    // 3. Switching tabs. Only the front tab keeps a viewer, so a switch re-reads the
    //    file — that round-trip is part of the cost and is measured with it.
    setStage('tab-switch')
    heapMarks.afterTyping = heapMark()
    const switchRounds = options.switchRounds ?? 3
    for (let round = 0; round < switchRounds; round++) {
      for (const path of paths) {
        const tab = tabElement(path)
        if (!tab) throw new Error(`没有 ${path} 的标签`)
        const started = performance.now()
        tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        await waitFor(`切换到 ${path}`, () => surfaceFor(path))
        // Post-paint, for the same reason the keystroke is: "the new file is
        // visible" is a claim about the screen, not about a callback.
        await afterPaint(`切换 ${path}`)
        switchMs.push(performance.now() - started)
      }
    }

    const viewersWithEightTabs = mountedViewers()

    // 4. Close everything. What the renderer gives back afterwards is sampled by the
    //    main process; here we only make sure the tabs are really gone.
    setStage('close-all')
    heapMarks.afterSwitching = heapMark()
    await closeAllTabs()
    heapMarks.afterClose = heapMark()

    // 5. The 内联 view, which no earlier version of this gate could reach. It only
    //    exists for a file the assistant changed, and no agent runs here — the
    //    updater is pointed at a dead proxy precisely so none is installed. So the
    //    harness delivers one finished turn's `files_changed` over the real chat
    //    stream (harness/inject.js): the upstream is the only thing faked, and
    //    everything downstream of those SSE bytes — the merge into `changedFiles`,
    //    the diff parse, the content re-anchoring, the row building — is the app.
    //
    //    The view renders a window of rows over a scroll space it computes
    //    arithmetically, and the pair of numbers that says whether it still does is
    //    `rowsTotal` against `rowsMountedPeak`. Until now that saving was argued
    //    from the gutter measurement rather than measured here.
    const changedFiles = options.changedFiles ?? []
    if (changedFiles.length > 0) {
      setStage('inline-open')
      const deliverStarted = performance.now()
      await window.__HARNESS__.deliverSessionDiff(changedFiles, { timeoutMs })
      inline.deliverMs = performance.now() - deliverStarted
      const front = changedFiles[changedFiles.length - 1].path

      // A file that arrives with a diff opens in 内联, not 内容: closing every tab
      // pruned the remembered view state, so the viewer falls back to its default,
      // which for a changed file is the inline view. Going to 内容 first is what makes
      // the switch below a real transition — clicking 内联 while it is already showing
      // would time nothing and report it as a very fast one.
      await waitFor('文件视图切换条', () => viewModeButton('内容'))
      const contentStarted = performance.now()
      viewModeButton('内容').click()
      await waitFor(`带差异的可编辑面 ${front}`, () => surfaceFor(front))
      await afterPaint('内容上屏')
      inline.contentMs = performance.now() - contentStarted
      heapMarks.afterDeliver = heapMark()

      setStage('inline-view')
      const showStarted = performance.now()
      const inlineButton = await waitFor('「内联」按钮', () => viewModeButton('内联'))
      inlineButton.click()
      const host = await waitFor('内联行', () => inlineRowHost())
      await afterPaint('内联上屏')
      inline.showMs = performance.now() - showStarted
      const counts = inlineRowCounts(host)
      inline.rowsTotal = counts.total
      inline.rowsMountedPeak = counts.mounted

      // Scrolling is where windowing has to keep being true: the row list is rebuilt
      // as the viewport moves, and a view that quietly stopped windowing would show
      // it here as a mounted count that never comes back down. The steps are spread
      // across the whole scroll range rather than paged one screen at a time, so
      // every one of them lands outside the current window and forces a rebuild —
      // paging would often stay inside the overscan and measure nothing.
      setStage('inline-scroll')
      const scroller = host.parentElement
      inline.scrollHeightPx = scroller.scrollHeight
      const travel = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      for (let step = 0; step < inlineScrollSteps; step++) {
        const started = performance.now()
        scroller.scrollTop = Math.round((travel * (step + 1)) / (inlineScrollSteps + 1))
        await afterPaint(`内联滚动 ${step + 1}/${inlineScrollSteps}`)
        inlineScrollMs.push(performance.now() - started)
        // One more frame before counting: React schedules the window update from a
        // scroll listener, and reading in the same frame would undercount the rows
        // on screen — in the direction that makes this check pass.
        await nextFrame(`内联滚动结算 ${step + 1}`)
        const current = inlineRowHost()
        if (current) inline.rowsMountedPeak = Math.max(inline.rowsMountedPeak, current.children.length)
      }
      inline.scrolledToPx = scroller.scrollTop
      heapMarks.afterInline = heapMark()

      // 5b. 「显示全文」, on the one file small enough for the toggle to be enabled.
      //     Collapsed, the row count follows the changes; expanded, it follows the
      //     file — the other branch of `buildInlineRows`, and the one that used to put
      //     up to FULL_VIEW_LIMIT rows of three elements each into the document. The
      //     eight big files can never reach it (12,001 lines against a 4,000 limit),
      //     which is why the fixture carries a ninth.
      const expandable = options.expandablePath
      if (expandable) {
        setStage('inline-full')
        const tab = tabElement(expandable)
        if (!tab) throw new Error(`没有 ${expandable} 的标签`)
        tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        // Wait on the toggle, not on the rows: the previous file's inline view is
        // still mounted for a frame or two after the click, so reading rows first
        // would measure *it*. Over FULL_VIEW_LIMIT the toggle is disabled and carries
        // a different title, so finding an enabled one is proof the viewer on screen
        // is the expandable file's.
        const expand = await waitFor('「显示全文」按钮', () => expandButton())
        // Never opened before, so no remembered view state: a file with a diff comes
        // up in 内联 by default, which is where this phase wants it.
        const collapsedHost = await waitFor('可展开文件的内联行', () => inlineRowHost())
        await afterPaint('可展开文件内联上屏')
        inline.fullCollapsedRows = inlineRowCounts(collapsedHost).total

        const expandStarted = performance.now()
        expand.click()
        // Waited for by row count rather than by a class or a label: the whole claim
        // being made is that expanding changes how many rows the view models.
        const fullHost = await waitFor('展开后的行', () => {
          const current = inlineRowHost()
          return current && inlineRowCounts(current).total > inline.fullCollapsedRows ? current : null
        })
        await afterPaint('展开上屏')
        inline.fullShowMs = performance.now() - expandStarted
        const fullCounts = inlineRowCounts(fullHost)
        inline.fullRowsTotal = fullCounts.total
        inline.fullRowsMountedPeak = fullCounts.mounted

        // The window has to hold on this branch too, so the same jumps are made here.
        const fullScroller = fullHost.parentElement
        const fullTravel = Math.max(0, fullScroller.scrollHeight - fullScroller.clientHeight)
        for (let step = 0; step < inlineScrollSteps; step++) {
          fullScroller.scrollTop = Math.round((fullTravel * (step + 1)) / (inlineScrollSteps + 1))
          await afterPaint(`展开滚动 ${step + 1}/${inlineScrollSteps}`)
          await nextFrame(`展开滚动结算 ${step + 1}`)
          const current = inlineRowHost()
          if (current) inline.fullRowsMountedPeak = Math.max(inline.fullRowsMountedPeak, current.children.length)
        }
        heapMarks.afterInlineFull = heapMark()
      }

      setStage('inline-close')
      await closeAllTabs()
    }

    setStage('done')
    heapMarks.afterInlineClose = heapMark()
    return {
      ok: true,
      report: {
        tabs: paths.length,
        dirtyTabs,
        /** JS heap at each stage boundary, to say what the working-set peak is
         *  made of. See `heapMark`. */
        heapMarks,
        /** The architectural invariant P2-004 was fixed with: one viewer, not one per tab. */
        viewersWithEightTabs,
        viewersAfterClose: mountedViewers(),
        framesDelivered: progress.frames,
        ...partial()
      }
    }
  } catch (error) {
    // Returned, not thrown: the main process needs the stage and the partial
    // numbers to write a report, and a rejected executeJavaScript carries neither.
    return {
      ok: false,
      stage: progress.stage,
      timedOut: error instanceof PerfTimeout,
      message: error && error.message ? error.message : String(error),
      diagnostics: diagnostics(),
      partial: partial()
    }
  }
})()
