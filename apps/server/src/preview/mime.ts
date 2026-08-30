/** Static-host helpers for the live-preview engine: content types, HTML client
 *  injection and the directory index. All pure so they can be unit tested
 *  without opening a socket. */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf'
}

function extensionOf(file: string): string {
  const match = /\.[^./\\]+$/.exec(file)
  return match ? match[0].toLowerCase() : ''
}

/** Content type for a served path; unknown extensions download as bytes. */
export function contentTypeFor(file: string): string {
  return TYPES[extensionOf(file)] ?? 'application/octet-stream'
}

export function isHtmlPath(file: string): boolean {
  const ext = extensionOf(file)
  return ext === '.html' || ext === '.htm'
}

/** True for a URL path that looks like a client-routed page rather than an
 *  asset, so the static host can fall back to the html entry (SPA behaviour). */
export function looksLikeRoute(urlPath: string): boolean {
  const last = urlPath.split('/').pop() ?? ''
  return last === '' || !last.includes('.')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Insert the live-reload client before </body> (or </html>, or at the end). */
export function injectClientScript(html: string, scriptTag: string): string {
  const bodyClose = html.toLowerCase().lastIndexOf('</body>')
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${scriptTag}\n${html.slice(bodyClose)}`
  const htmlClose = html.toLowerCase().lastIndexOf('</html>')
  if (htmlClose >= 0) return `${html.slice(0, htmlClose)}${scriptTag}\n${html.slice(htmlClose)}`
  return `${html}\n${scriptTag}`
}

export interface IndexEntry {
  name: string
  type: 'dir' | 'file'
}

const PAGE_STYLE =
  'body{font:14px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px;color:#24292f;background:#fff}'
  + 'h1{font-size:15px;font-family:ui-monospace,Consolas,monospace;color:#57606a;font-weight:600;margin:0 0 12px}'
  + 'ul{list-style:none;margin:0;padding:0}li{padding:2px 0}'
  + 'a{color:#0969da;text-decoration:none;font-family:ui-monospace,Consolas,monospace}a:hover{text-decoration:underline}'
  + 'p{color:#57606a}'

function page(title: string, body: string, scriptTag: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>`
    + `<body>${body}${scriptTag}</body></html>`
}

/** Fallback listing when a directory has no html entry. */
export function directoryIndexHtml(relPath: string, entries: readonly IndexEntry[], scriptTag = ''): string {
  const prefix = relPath ? `/${relPath.replace(/^\/+|\/+$/g, '')}/` : '/'
  const items = entries
    .map((entry) => {
      const href = `${prefix}${encodeURIComponent(entry.name)}${entry.type === 'dir' ? '/' : ''}`
      const label = entry.type === 'dir' ? `${entry.name}/` : entry.name
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`
    })
    .join('')
  const parent = relPath ? `<li><a href="${escapeHtml(prefix.replace(/[^/]+\/$/, ''))}">../</a></li>` : ''
  return page(
    `预览目录 ${prefix}`,
    `<h1>${escapeHtml(prefix)}</h1><ul>${parent}${items}</ul>`
    + (entries.length === 0 ? '<p>目录为空。放入 index.html 后此处会直接渲染页面。</p>' : ''),
    scriptTag
  )
}

/** Error page kept in the same shape so live reload keeps working on 404. */
export function errorPageHtml(status: number, message: string, scriptTag = ''): string {
  return page(`预览 ${status}`, `<h1>${status}</h1><p>${escapeHtml(message)}</p>`, scriptTag)
}
