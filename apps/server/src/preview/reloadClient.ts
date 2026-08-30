/** Live-reload client injected into every HTML page the static preview host
 *  serves. It is plain ES2018 script text — no build step, no dependencies —
 *  and runs inside the sandboxed preview iframe.
 *
 *  Channel: SSE on /__botcf_preview/events.
 *    {type:'css'}    → swap every stylesheet in place, keeping app state
 *    {type:'reload'} → full reload
 *  It also relays runtime errors and the current location to the host panel via
 *  postMessage, which is how the preview toolbar shows the URL and error count.
 */

export const PREVIEW_CLIENT_PATH = '/__botcf_preview/client.js'
export const PREVIEW_EVENTS_PATH = '/__botcf_preview/events'
export const PREVIEW_CLIENT_TAG = `<script src="${PREVIEW_CLIENT_PATH}" defer></script>`

export const PREVIEW_CLIENT_SOURCE = `(function () {
  var BADGE_ID = '__botcf_preview_badge'
  var post = function (payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ source: 'botcf-preview' }, payload), '*')
      }
    } catch (e) { /* cross-origin parent refused the message */ }
  }

  var badge = function (text) {
    var el = document.getElementById(BADGE_ID)
    if (!text) { if (el) el.remove(); return }
    if (!el) {
      el = document.createElement('div')
      el.id = BADGE_ID
      el.style.cssText = 'position:fixed;z-index:2147483647;left:8px;bottom:8px;padding:4px 10px;'
        + 'border-radius:6px;background:rgba(20,20,20,.82);color:#fff;font:12px ui-sans-serif,system-ui,sans-serif;'
        + 'pointer-events:none;box-shadow:0 1px 6px rgba(0,0,0,.25)'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.textContent = text
  }

  var swapOne = function (link, stamp) {
    var href = link.getAttribute('href')
    if (!href || /^(data|blob):/i.test(href)) return
    var base = href.split('__botcf=')[0].replace(/[?&]$/, '')
    var next = link.cloneNode()
    next.setAttribute('href', base + (base.indexOf('?') >= 0 ? '&' : '?') + stamp)
    // Keep the stale sheet until the new one paints, otherwise the page flashes.
    var drop = function () { if (link.parentNode) link.parentNode.removeChild(link) }
    next.addEventListener('load', drop)
    next.addEventListener('error', drop)
    link.parentNode.insertBefore(next, link.nextSibling)
  }

  var swapStyles = function () {
    var links = document.querySelectorAll('link[rel="stylesheet"][href]')
    var stamp = '__botcf=' + Date.now()
    // querySelectorAll is static, and each swap closes over its own link, so the
    // clones inserted here cannot disturb the iteration.
    for (var i = 0; i < links.length; i++) swapOne(links[i], stamp)
    post({ type: 'css-applied', at: Date.now() })
  }

  var connect = function () {
    var source = new EventSource('${PREVIEW_EVENTS_PATH}')
    source.onopen = function () { badge('') ; post({ type: 'connected' }) }
    source.onmessage = function (event) {
      var msg
      try { msg = JSON.parse(event.data) } catch (e) { return }
      if (msg.type === 'css') { badge('样式已热更新'); setTimeout(function () { badge('') }, 900); swapStyles(); return }
      if (msg.type === 'reload') { badge('重新加载…'); location.reload(); return }
    }
    source.onerror = function () {
      badge('预览服务已断开,等待重连…')
      post({ type: 'disconnected' })
    }
  }

  window.addEventListener('error', function (event) {
    post({ type: 'error', message: String((event && event.message) || '脚本错误'), at: Date.now() })
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    post({ type: 'error', message: '未处理的 Promise 拒绝: ' + String((reason && reason.message) || reason), at: Date.now() })
  })
  window.addEventListener('load', function () { post({ type: 'location', href: location.href }) })

  if (typeof EventSource === 'function') connect()
})()
`
