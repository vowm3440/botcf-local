const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function parseAuthority(authority: string): URL | null {
  if (authority.includes('/') || authority.includes('\\')) return null
  try {
    return new URL(`http://${authority}`)
  } catch {
    return null
  }
}

/** Reject DNS rebinding and browser CSRF while preserving native/curl callers. */
export function isTrustedLocalRequest(hostHeader: string | undefined, originHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const authority = parseAuthority(hostHeader)
  if (!authority || !LOOPBACK_HOSTS.has(authority.hostname.toLowerCase())) return false
  if (!originHeader) return true
  try {
    const origin = new URL(originHeader)
    return origin.protocol === 'http:'
      && LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())
      && origin.host.toLowerCase() === hostHeader.toLowerCase()
  } catch {
    return false
  }
}
