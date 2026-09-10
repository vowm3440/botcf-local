/** Shared fetch plumbing for the panel services.
 *
 *  Every local endpoint answers `{ success, ... }` and reports failures as
 *  `{ success: false, error }`, so one helper turns both HTTP and application
 *  failures into a thrown Error with the server's own message — the panels then
 *  只需 try/catch 一次就能把原因显示给用户。 */

export async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { success?: boolean; error?: string }
  if (!res.ok || body.success === false) {
    throw new Error(body.error ?? `请求失败 (HTTP ${res.status})`)
  }
  return body
}

export function getJson<T>(url: string): Promise<T> {
  return fetch(url).then((res) => unwrap<T>(res))
}

export function postJson<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }).then((res) => unwrap<T>(res))
}

/** Query string from defined values only, so optional params stay absent. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}
