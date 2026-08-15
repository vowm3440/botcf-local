/** Redaction helpers: every log line and error payload passes through here so
 *  passwords, cookies, Authorization headers and API keys never reach disk. */

const PATTERNS: Array<[RegExp, string]> = [
  [/("?password"?\s*[:=]\s*")[^"]+(")/gi, '$1***$2'],
  [/("?password"?\s*[:=]\s*)[^\s,}&"]+/gi, '$1***'],
  [/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[a-z0-9._~+/-]+=*/gi, '$1$2***'],
  [/(set-cookie"?\s*[:=]\s*"?)[^";\r\n]+/gi, '$1***'],
  [/(cookie"?\s*[:=]\s*"?)[^";\r\n]+/gi, '$1***'],
  [/\bsk-[a-zA-Z0-9]{4}[a-zA-Z0-9-_]*/g, (m: string) => m.slice(0, 7) + '***'],
  [/("access_token"\s*:\s*")[^"]+(")/gi, '$1***$2'],
  [/("session"\s*:\s*")[^"]+(")/gi, '$1***$2']
] as unknown as Array<[RegExp, string]>

export function redact(input: string): string {
  let out = input
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement as string)
  }
  return out
}

/** Mask a secret for display: keep first/last 4 chars. */
export function mask(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function redactObject(obj: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(obj)))
  } catch {
    return { redacted: true }
  }
}
