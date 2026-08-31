/** Editor E2E, renderer half: what CodeMirror has to keep doing, in a real browser.
 *
 *  The text surface stopped being a `<textarea>` and became CodeMirror 6 for a memory
 *  reason (docs/perf-gate-2026-08-28.md §6), and the swap brought three behaviours
 *  with it that nothing checked: the assistant's edits drawn as line decorations, the
 *  change bars in the gutter and what clicking one does, and the read-only surface a
 *  file over 1 MiB gets. The perf gate exercises the integration but only asks how
 *  fast it is, and the unit tests deliberately stop at the pure functions —
 *  CodeMirror in jsdom measures every element as zero pixels, so its viewport
 *  calculations all degrade and a "component test" there tests the stub, greenly.
 *
 *  So this runs in the same real window the gate uses, drives the same real
 *  components, and asserts instead of timing. Every check names the line it expects
 *  and compares the text it got, because the fixture's lines state their own numbers —
 *  which is what makes "the green band is on line 6" checkable rather than plausible.
 *
 *  Reads `window.__E2E__`; resolves to { ok, checks } and never throws through
 *  `executeJavaScript`. */

(async () => {
  const options = window.__E2E__
  const timeoutMs = options.timeoutMs ?? 30_000
  const expected = options.expected

  const TAB_STRIP = '[role="tablist"][aria-label="打开的文件"]'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const checks = []
  let stopped = null

  function expect(condition, message) {
    if (!condition) throw new Error(message)
  }

  function expectEqual(actual, wanted, what) {
    if (actual !== wanted) throw new Error(`${what}:期望 ${JSON.stringify(wanted)},实际 ${JSON.stringify(actual)}`)
  }

  async function waitFor(label, predicate) {
    const until = performance.now() + timeoutMs
    for (;;) {
      const value = predicate()
      if (value) return value
      if (performance.now() > until) throw new Error(`等待 ${label} 超时`)
      await sleep(16)
    }
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
  }

  /** Two frames, because a click that changes React state and then scrolls needs the
   *  render and the effect that follows it before the DOM answers truthfully. */
  async function settle() {
    await nextFrame()
    await nextFrame()
  }

  /** One named assertion. A failure stops the run rather than cascading: these checks
   *  are sequential — the read-only file has to be open before it can be typed into —
   *  and a list of twelve failures caused by one is noise, not information. */
  async function check(name, fn) {
    if (stopped) {
      checks.push({ name, ok: null, skipped: `前一项失败:${stopped}` })
      return
    }
    const started = performance.now()
    try {
      const detail = await fn()
      checks.push({ name, ok: true, ms: Math.round(performance.now() - started), ...(detail === undefined ? {} : { detail }) })
    } catch (error) {
      stopped = name
      checks.push({ name, ok: false, ms: Math.round(performance.now() - started), message: error && error.message ? error.message : String(error) })
    }
  }

  function editorTabs() {
    return [...document.querySelectorAll(`${TAB_STRIP} [role="tab"]`)]
  }

  function surfaceFor(path) {
    return document.querySelector(`[aria-label="编辑 ${path}"], [aria-label="查看 ${path}"]`)
  }

  function viewModeButton(label) {
    return (
      [...document.querySelectorAll('[role="tablist"][aria-label="文件视图"] [role="tab"]')].find((button) =>
        button.textContent.trim().startsWith(label)
      ) ?? null
    )
  }

  function activeViewMode() {
    const selected = [...document.querySelectorAll('[role="tablist"][aria-label="文件视图"] [role="tab"]')].find(
      (button) => button.getAttribute('aria-selected') === 'true'
    )
    return selected ? selected.textContent.trim() : null
  }

  /** Which view is showing, asked of `aria-selected` rather than of the caption.
   *
   *  The 内容 caption carries the ● marker when the buffer is unsaved, so comparing
   *  text would make every mode assertion depend on the dirty state as well — and the
   *  first run of this suite did exactly that, failing 「切到内容」 because the file was
   *  wrongly marked unsaved. That is worth failing on, but on its own check. */
  function modeSelected(label) {
    const button = viewModeButton(label)
    return Boolean(button) && button.getAttribute('aria-selected') === 'true'
  }

  /** The strip above the open file. Scoped rather than searched page-wide: 「保存」 is
   *  not a word only this header uses, and a check that found some other panel's
   *  button would be reporting on the wrong thing in both directions. */
  function viewerHeader() {
    const tabs = document.querySelector('[role="tablist"][aria-label="文件视图"]')
    return tabs ? tabs.parentElement : null
  }

  function headerButton(label) {
    const header = viewerHeader()
    if (!header) return null
    return [...header.querySelectorAll('button')].find((button) => button.textContent.trim() === label) ?? null
  }

  /** Line elements carrying a region decoration. CodeMirror renders the viewport, so
   *  these are only the visible ones — which is the point: the fixture puts all three
   *  regions inside the first screen. */
  function decorated(kind) {
    return [...document.querySelectorAll(`.cm-region-${kind}`)]
  }

  function gutterBars(kind) {
    return [...document.querySelectorAll(`.cm-region-gutter .cm-region-bar-${kind}`)]
  }

  /** The inline diff's row container, and the two things worth asking it. */
  function inlineHost() {
    const row = document.querySelector('[data-line]')
    return row ? row.parentElement : null
  }

  function inlineGapRows(host) {
    return [...host.children].filter((element) => element.textContent.includes('行未改动')).length
  }

  /** Rows are one CODE_LINE_HEIGHT each, so the modelled count is arithmetic — the
   *  same property that lets the view window by index without measuring anything. */
  function inlineRowsModelled(host) {
    return Math.round(host.getBoundingClientRect().height / 18)
  }

  /** The Git panel's own text, for assertions and for failure messages. Anchored on
   *  the commit box because that is rendered whether or not the directory is a
   *  repository — so "the panel is not here" and "the panel says it is not a repo"
   *  stay distinguishable, and they are very different bugs. */
  function gitPanelText() {
    const box = document.querySelector('input[aria-label="提交信息"][placeholder^="提交信息"]')
    const panel = box ? box.closest('div')?.parentElement : null
    return panel ? panel.textContent.trim() : '(Git 面板不在页面上)'
  }

  /** The rail button that opens a workbench part. */
  function railButton(title) {
    return document.querySelector(`[aria-label="活动栏"] button[title^="${title}"]`)
  }

  /** Bring a part to the front, idempotently.
   *
   *  The rail is a *toggle* — `dock.togglePart` closes a part that is already
   *  frontmost — so a bare click is only correct if you know the part is not showing.
   *  `marker` is something the panel always renders, so this opens it when it is
   *  absent and does nothing when it is not. The harness also clears browser storage
   *  before the run, which is what stops the previous run's layout deciding this. */
  async function openPart(title, marker) {
    const button = await waitFor(`活动栏的「${title}」`, () => railButton(title))
    if (!document.querySelector(marker)) {
      button.click()
      await waitFor(`「${title}」面板出现`, () => document.querySelector(marker))
    }
    await settle()
  }

  async function openTab(path) {
    let announced = -Infinity
    // `botcf:open-file` is fire-and-forget with no buffering, so a dispatch that
    // lands before the workbench registered its listener is gone, not queued.
    return waitFor(`标签 ${path}`, () => {
      const now = performance.now()
      if (now - announced >= 1_000) {
        announced = now
        window.dispatchEvent(new CustomEvent('botcf:open-file', { detail: { path, activate: true } }))
      }
      return surfaceFor(path)
    })
  }

  /** Bring an already-open tab to the front.
   *
   *  Waits for the tab strip to mark it active, not for an editable surface: the
   *  viewer comes back in the view it was left in, and the one file here was left in
   *  内联 by the gutter-click check — which mounts no editor at all. Waiting for
   *  「编辑 …」 there waits forever. */
  async function activateTab(path) {
    const tab = editorTabs().find((entry) => entry.title.startsWith(path))
    expect(Boolean(tab), `没有 ${path} 的标签`)
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await waitFor(`切换到 ${path}`, () =>
      editorTabs().some((entry) => entry.title.startsWith(path) && entry.getAttribute('data-active') === 'true')
    )
    // …and for the viewer behind it to exist, whichever view it opens in.
    return waitFor(`${path} 的查看器`, () => viewModeButton('内容'))
  }

  async function showMode(label) {
    const button = await waitFor(`「${label}」按钮`, () => viewModeButton(label))
    button.click()
    // Waited for rather than assumed: the click is React state, and asserting on the
    // frame it happened in is how an E2E becomes flaky on a slower machine.
    await waitFor(`视图切到${label}`, () => modeSelected(label))
    await settle()
  }

  function typeInto(surface, text) {
    surface.focus()
    return document.execCommand('insertText', false, text)
  }

  /** `window.confirm` for the duration of one click.
   *
   *  Two of the Git panel's write actions are gated on it, and in an automated window
   *  nobody answers the dialog. Replaced narrowly and restored immediately: the point
   *  is to answer the question, not to remove it — a change that dropped the
   *  confirmation entirely would still pass these checks, and should not. */
  function withConfirm(answer, act) {
    const original = window.confirm
    window.confirm = () => answer
    try {
      return act()
    } finally {
      window.confirm = original
    }
  }

  /** The undo binding is `Mod-z`, which is Cmd on macOS and Ctrl everywhere else. */
  function pressUndo(target) {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...(mac ? { metaKey: true } : { ctrlKey: true }) })
    )
  }

  try {
    await waitFor('工作台面板', () => document.querySelector('[role="tablist"][aria-label="面板标签"]'))

    // The whole suite depends on the app believing the assistant changed this file:
    // no diff, no decorations, no gutter bars, no 内联 view.
    await check('本轮变更经由真实聊天流送达', async () => {
      await window.__HARNESS__.deliverSessionDiff(options.changedFiles, { timeoutMs })
      // Deliberately not waiting for the editable surface here: a file that arrives
      // with a diff opens in 内联, so there is no 「编辑 …」 element yet. The three
      // view buttons are the signal that the viewer took the diff.
      await waitFor('差异视图按钮', () => viewModeButton('内联'))
      expect(
        editorTabs().some((tab) => tab.title.startsWith(options.editedPath)),
        `变更的文件没有打开成标签:${options.editedPath}`
      )
      return { tabs: editorTabs().length, mode: activeViewMode() }
    })

    await check('文件头报出正确的改动计数', async () => {
      const chip = await waitFor('AI 计数标记', () => document.querySelector('[title^="AI 在这个文件里改了"]'))
      const title = chip.getAttribute('title')
      const wanted = `AI 在这个文件里改了 ${expected.regions} 处(+${expected.added} −${expected.removed})`
      expect(title.startsWith(wanted), `计数标记:期望以 ${JSON.stringify(wanted)} 开头,实际 ${JSON.stringify(title)}`)
      // Nothing may be reported as unlocatable: every added block in the fixture is
      // exactly what is on disk, so a 「!」 here would mean anchoring is broken.
      expect(!title.includes('无法定位'), `有改动未能锚定:${title}`)
      return title
    })

    await check('刚送达的改动文件不算「未保存」', async () => {
      // The 内联 view mounts no editor, so nothing owns the buffer — and reading that
      // as an empty one marked every file the assistant changed as unsaved *and*
      // cached an empty draft for it, which the next open would have shown as an empty
      // file. Named as its own check because the caption it corrupts (「内容 ●」) is
      // also what every other view assertion would otherwise be reading.
      expect(modeSelected('内联'), '带差异的文件应当以内联视图打开')
      const content = viewModeButton('内容')
      expect(!content.textContent.includes('●'), `文件被误报为未保存:${JSON.stringify(content.textContent)}`)
      expect(headerButton('保存') === null, '未经编辑就出现了「保存」按钮')
      const tab = editorTabs().find((entry) => entry.title.startsWith(options.editedPath))
      expect(!tab.querySelector('[title="未保存"]'), '标签上出现了未保存标记')
    })

    await check('三种改动各画出自己的装饰', async () => {
      await showMode('内容')
      await waitFor('可编辑面', () => document.querySelector(`[aria-label="编辑 ${options.editedPath}"]`))
      await settle()
      const add = decorated('add')
      const modify = decorated('modify')
      const remove = decorated('delete')
      expectEqual(add.length, 1, '新增行装饰数量')
      expectEqual(modify.length, 1, '改写行装饰数量')
      expectEqual(remove.length, 1, '删除标记数量')
      expectEqual(add[0].textContent, expected.add.text, `新增装饰所在的行(应为第 ${expected.add.line} 行)`)
      expectEqual(modify[0].textContent, expected.modify.text, `改写装饰所在的行(应为第 ${expected.modify.line} 行)`)
      // A deletion occupies no line: the rule is drawn on the line that now sits
      // where the removed text was, and marking that line as changed would claim the
      // assistant wrote code it never touched.
      expectEqual(remove[0].textContent, expected.delete.text, `删除标记所在的行(应为第 ${expected.delete.line} 行)`)
      return { add: expected.add.line, modify: expected.modify.line, delete: expected.delete.line }
    })

    await check('滚出视口再回来,装饰还在原处', async () => {
      const scroller = await waitFor('编辑器滚动容器', () => document.querySelector('.cm-scroller'))
      scroller.scrollTop = scroller.scrollHeight
      // Off screen the decorations must be gone — that is viewport rendering working,
      // and if they were all still there the surface would not be windowing at all.
      await waitFor('装饰随视口滚出 DOM', () => decorated('add').length === 0)
      scroller.scrollTop = 0
      await waitFor('装饰随视口回到 DOM', () => decorated('add').length === 1)
      await settle()
      expectEqual(decorated('add')[0].textContent, expected.add.text, '滚回顶部后新增装饰所在的行')
      expectEqual(decorated('modify')[0].textContent, expected.modify.text, '滚回顶部后改写装饰所在的行')
      expectEqual(decorated('delete')[0].textContent, expected.delete.text, '滚回顶部后删除标记所在的行')
    })

    await check('左边距为每处改动画一根条', async () => {
      expectEqual(gutterBars('add').length, 1, '新增条数量')
      expectEqual(gutterBars('modify').length, 1, '改写条数量')
      expectEqual(gutterBars('delete').length, 1, '删除条数量')
      // The tooltip is what tells you which change a bar is before you click it, so
      // each one has to name its own kind and where it is. Asserted by the two facts
      // that matter rather than by re-spelling the whole sentence — a check that
      // duplicates the format string only tests that the string was copied twice.
      const titleOf = (kind) => gutterBars(kind)[0].getAttribute('title') ?? ''
      const addTitle = titleOf('add')
      const modifyTitle = titleOf('modify')
      const deleteTitle = titleOf('delete')
      expect(addTitle.startsWith('AI 新增') && addTitle.includes(`第 ${expected.add.line} 行`), `新增条的提示:${JSON.stringify(addTitle)}`)
      expect(
        modifyTitle.startsWith('AI 改写') && modifyTitle.includes(`第 ${expected.modify.line} 行`),
        `改写条的提示:${JSON.stringify(modifyTitle)}`
      )
      // A deletion occupies no line, so its tooltip counts lines instead of naming one.
      expect(
        deleteTitle.includes(`删除了 ${expected.removedText.length} 行`),
        `删除条的提示:${JSON.stringify(deleteTitle)}`
      )
      return { addTitle, modifyTitle, deleteTitle }
    })

    await check('点击左边距的条,跳到内联视图的那一处', async () => {
      gutterBars('add')[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await waitFor('点击后切到内联', () => modeSelected('内联'))
      const row = await waitFor(`内联第 ${expected.add.line} 行`, () =>
        document.querySelector(`[data-line="${expected.add.line}"]`)
      )
      await settle()
      expect(row.textContent.includes(expected.add.text), '内联行的文本')
      // Revealed, not merely present: the point of the click is to land on it.
      const scroller = row.parentElement.parentElement
      const top = row.offsetTop - scroller.scrollTop
      expect(top >= 0 && top <= scroller.clientHeight, `第 ${expected.add.line} 行没有落在可视区内(偏移 ${Math.round(top)}px)`)
    })

    await check('内联视图把删掉的行显示在原位', async () => {
      const host = await waitFor('内联行容器', () => inlineHost())
      const text = host.textContent
      for (const removed of expected.removedText) {
        expect(text.includes(removed), `内联视图里找不到被删掉的行 ${JSON.stringify(removed)}`)
      }
      return expected.removedText.length
    })

    // The other branch of `buildInlineRows`. Collapsed, the row count follows the
    // changes; expanded, it follows the file — which is the shape that used to put
    // thousands of rows of three elements each into the document, and the branch the
    // perf gate could not reach until it grew a fixture under FULL_VIEW_LIMIT.
    await check('「显示全文」展开省略的区间,而且仍然只渲染一屏', async () => {
      const host = await waitFor('内联行容器', () => inlineHost())
      const collapsedRows = inlineRowsModelled(host)
      expect(inlineGapRows(host) > 0, '折叠视图里没有「N 行未改动」的省略行')
      expect(document.querySelector(`[data-line="${options.expandedOnlyLine}"]`) === null, `折叠视图里不应出现第 ${options.expandedOnlyLine} 行`)

      const toggle = await waitFor('「显示全文」按钮', () =>
        document.querySelector('button[title^="在整份文件与仅改动附近之间切换"]')
      )
      expectEqual(toggle.textContent.trim(), '显示全文', '折叠时的按钮文案')
      toggle.click()
      await waitFor(`展开后出现第 ${options.expandedOnlyLine} 行`, () =>
        document.querySelector(`[data-line="${options.expandedOnlyLine}"]`)
      )
      await settle()

      const expandedHost = inlineHost()
      const expandedRows = inlineRowsModelled(expandedHost)
      const mounted = expandedHost.children.length
      expect(expandedRows > collapsedRows, `展开后建模行数没有变多(${collapsedRows} → ${expandedRows})`)
      expectEqual(inlineGapRows(expandedHost), 0, '展开后仍然存在的省略行')
      // Expanded is still windowed — that is the whole reason this branch is safe to
      // offer on a file of any size up to the limit.
      expect(mounted * 2 < expandedRows, `展开后仍把 ${mounted}/${expandedRows} 行留在 DOM 里,没有窗口化`)

      toggle.click()
      await waitFor('收回折叠视图', () => document.querySelector(`[data-line="${options.expandedOnlyLine}"]`) === null)
      await settle()
      expect(inlineGapRows(inlineHost()) > 0, '收回之后省略行没有回来')
      return { collapsedRows, expandedRows, mounted }
    })

    await check('超过 1 MiB 的文件只读打开', async () => {
      const surface = await openTab(options.oversizedPath)
      expectEqual(surface.getAttribute('aria-label'), `查看 ${options.oversizedPath}`, '只读文件的无障碍名称')
      // Not `=== 'false'`: what matters is that it is not editable, and CodeMirror has
      // spelled the negative case both ways across versions.
      expect(surface.getAttribute('contenteditable') !== 'true', '只读文件的编辑面仍然可编辑')
      expect(headerButton('保存') === null, '只读文件不应出现「保存」按钮')
      const header = viewerHeader()
      expect(Boolean(header) && header.textContent.includes('只读预览'), '文件头没有说明这是只读预览')
    })

    await check('只读文件拒绝键入', async () => {
      const surface = surfaceFor(options.oversizedPath)
      // Focus first and let it settle, so what is compared afterwards is the effect of
      // the keystroke and not of the scroll that focusing can cause.
      surface.focus()
      await settle()
      const before = surfaceFor(options.oversizedPath).textContent
      document.execCommand('insertText', false, 'X')
      await settle()
      expectEqual(surfaceFor(options.oversizedPath).textContent, before, '只读文件在键入后的内容')
      expect(headerButton('保存') === null, '只读文件在键入后出现了「保存」按钮')
    })

    // The last one is here because the swap to CodeMirror took the browser's own undo
    // away with the textarea: `history()` from @codemirror/commands is what replaced
    // it, and a ● that will not clear after an undo is a lie about unsaved work.
    await check('撤销把缓冲区改回干净', async () => {
      await activateTab(options.editedPath)
      await showMode('内容')
      const surface = await waitFor('可编辑面', () => document.querySelector(`[aria-label="编辑 ${options.editedPath}"]`))
      expect(typeInto(surface, 'Z'), '编辑面拒绝了键入')
      await waitFor('未保存标记出现', () => viewModeButton('内容').textContent.includes('●'))
      expect(headerButton('保存') !== null, '键入后没有出现「保存」按钮')
      pressUndo(surface)
      await waitFor('未保存标记消失', () => !viewModeButton('内容').textContent.includes('●'))
      await settle()
      expect(headerButton('保存') === null, '撤销之后「保存」按钮没有消失')
    })

    // ── Beyond the editor ────────────────────────────────────────────────────
    // Two more parts of the workbench with no real-browser coverage either, reachable
    // from this same bootstrap because their state has an honest source: a git
    // repository on disk, and the endpoint the sandboxed preview page already uses to
    // relay a runtime error. Neither needs anything added to the product for a test.
    // They run last so that a failure here never hides an editor result.

    await check('Git 面板列出工作区里未提交的改动', async () => {
      // Not skipped when git is missing — failed, with the reason. A check nobody ran
      // is not a check that passed; the same rule `jsHeapRetainedMiB` follows.
      expect(options.gitReady, 'git 不可用,或夹具仓库没有建起来 —— 这一项没有跑,不算通过')
      await openPart('源代码管理', 'input[aria-label="提交信息"][placeholder^="提交信息"]')
      const entry = await waitFor(`${options.trackedFile} 的条目`, () =>
        document.querySelector(`button[title="${options.trackedFile}"]`)
      ).catch(() => {
        // A bare timeout here would not say whether the panel was closed, showed no
        // repository, or listed nothing — three very different bugs.
        throw new Error(`Git 面板里找不到 ${options.trackedFile};面板当前显示:${JSON.stringify(gitPanelText().slice(0, 200))}`)
      })
      expectEqual(entry.textContent.trim(), options.trackedFile, 'Git 条目显示的路径')
      const row = entry.parentElement
      expect(row.textContent.includes('修改'), `条目没有标成已修改:${JSON.stringify(row.textContent.trim())}`)
      return row.textContent.trim().slice(0, 60)
    })

    await check('Git 面板能暂存一个文件', async () => {
      expect(options.gitReady, 'git 不可用 —— 这一项没有跑,不算通过')
      const entry = await waitFor(`${options.trackedFile} 的条目`, () =>
        document.querySelector(`button[title="${options.trackedFile}"]`)
      )
      const stage = [...entry.parentElement.querySelectorAll('button')].find((button) => button.textContent.trim() === '暂存')
      expect(Boolean(stage), '找不到「暂存」按钮')
      stage.click()
      // A staged entry offers 取消暂存 instead. The panel re-reads git rather than
      // guessing, so this waits on a real `git status` round trip, not a local toggle.
      await waitFor('条目变成已暂存', () => {
        const row = document.querySelector(`button[title="${options.trackedFile}"]`)?.parentElement
        return Boolean(row && [...row.querySelectorAll('button')].some((button) => button.textContent.trim() === '取消暂存'))
      })
    })

    await check('Git 面板能提交已暂存的改动', async () => {
      expect(options.gitReady, 'git 不可用 —— 这一项没有跑,不算通过')
      // Scoped by placeholder: the review panel has a commit box with the same
      // accessible name, and only one of the two is ever mounted.
      const box = await waitFor('提交信息输入框', () =>
        document.querySelector('input[aria-label="提交信息"][placeholder^="提交信息"]')
      )
      expect(typeInto(box, options.commitMessage), '提交信息输入框拒绝了输入')
      await waitFor('提交信息进入面板状态', () => box.value.includes(options.commitMessage))
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await waitFor('工作区变干净', () => document.querySelector(`button[title="${options.trackedFile}"]`) === null)
      const panel = gitPanelText()
      expect(panel.includes('工作区是干净的'), `提交后面板没有说工作区干净:${JSON.stringify(panel.slice(0, 120))}`)
    })

    await check('Git 面板能撤销上一个提交,改动回到工作区', async () => {
      expect(options.gitReady, 'git 不可用 —— 这一项没有跑,不算通过')
      const history = await waitFor('「历史」按钮', () =>
        [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '历史')
      )
      history.click()
      const undo = await waitFor('「撤销上一个提交」按钮', () =>
        document.querySelector('button[title^="把分支指针回退一个提交"]')
      )
      withConfirm(true, () => undo.click())
      // `mixed`, so the change comes back as an *unstaged* modification — the state
      // the fixture started in.
      const entry = await waitFor('改动回到未提交列表', () =>
        document.querySelector(`button[title="${options.trackedFile}"]`)
      )
      expect(entry.parentElement.textContent.includes('修改'), '回退后的条目没有标成已修改')
    })

    await check('Git 面板能丢弃一个文件的未提交修改', async () => {
      expect(options.gitReady, 'git 不可用 —— 这一项没有跑,不算通过')
      const entry = await waitFor(`${options.trackedFile} 的条目`, () =>
        document.querySelector(`button[title="${options.trackedFile}"]`)
      )
      const discard = [...entry.parentElement.querySelectorAll('button')].find((button) =>
        (button.getAttribute('title') ?? '').startsWith('丢弃这个文件')
      )
      expect(Boolean(discard), '找不到「丢弃这个文件的未提交修改」按钮')
      withConfirm(true, () => discard.click())
      await waitFor('丢弃后工作区变干净', () => document.querySelector(`button[title="${options.trackedFile}"]`) === null)
    })

    await check('诊断中心收下运行时报错,并能跳到出错的那一行', async () => {
      // The app's own endpoint — the one the sandboxed preview page posts to when the
      // page it hosts throws. Nothing here is a hook added for testing.
      const response = await fetch('/api/diagnostics/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: options.diagnosticMessage, path: options.editedPath, line: expected.modify.line })
      })
      expect(response.ok, `诊断上报失败:HTTP ${response.status}`)
      await openPart('问题', '[aria-label="过滤诊断"]')
      // It arrives over the diagnostics SSE channel, so this says that channel is live
      // as well as that the panel renders.
      const open = await waitFor('诊断条目', () => {
        const row = [...document.querySelectorAll('div')]
          .reverse()
          .find(
            (element) =>
              element.textContent.includes(options.diagnosticMessage) &&
              element.querySelector('button[title="在编辑器中打开这一行"]')
          )
        return row ? row.querySelector('button[title="在编辑器中打开这一行"]') : null
      })
      open.click()
      // The cross-panel signal, which Git and 审查 use too: a panel hands a file and a
      // line to the editor and the dock brings the editor forward.
      await waitFor('编辑器切到出错的文件', () =>
        editorTabs().some((tab) => tab.title.startsWith(options.editedPath) && tab.getAttribute('data-active') === 'true')
      )
    })

    return { ok: checks.every((entry) => entry.ok === true), checks }
  } catch (error) {
    // Returned, not thrown: the main process needs the checks that did run.
    return {
      ok: false,
      checks,
      fatal: error && error.message ? error.message : String(error),
      diagnostics: {
        visibility: document.visibilityState,
        openTabs: editorTabs().length,
        mode: activeViewMode()
      }
    }
  }
})()
