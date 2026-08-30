import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DATA_DIR = process.env.BOTCF_DATA_DIR ?? path.resolve(process.cwd(), 'data')
export const DEFAULT_OMP_GITHUB_REPO = 'can1357/oh-my-pi'

/** An unset or unusable duration means "derive it" — not zero. */
function optionalMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export const config = {
  /** Bind address. 127.0.0.1 for bare-metal dev; the container sets HOST=0.0.0.0
   *  and compose maps it back to 127.0.0.1 on the host. */
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 7788),
  proxyPort: Number(process.env.PROXY_PORT ?? 7789),

  botcfBaseUrl: process.env.BOTCF_BASE_URL ?? 'https://botcf.com',

  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'botcf.db'),
  secretsDir: path.join(DATA_DIR, 'secrets'),
  masterKeyPath: path.join(DATA_DIR, 'secrets', 'master.key'),
  ompDir: path.join(DATA_DIR, 'omp'),
  /** Per-process capability presented by OMP to the loopback credential proxy. */
  proxyToken: crypto.randomBytes(32).toString('base64url'),

  webDistDir: process.env.WEB_DIST_DIR ?? path.resolve(process.cwd(), '..', 'web', 'dist'),

  /** Live preview host. 0 picks an ephemeral loopback port per start; set a
   *  fixed port when the preview must be reachable through a port mapping
   *  (Docker), since the iframe URL is handed to the browser verbatim. */
  previewPort: Number(process.env.PREVIEW_PORT ?? 0),

  /** Stable per-installation id used in dedicated key names (omp-local-<deviceId>-<group>). */
  deviceId: process.env.BOTCF_DEVICE_ID ?? (os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) || 'local'),

  ompUpdate: {
    /** Official release source. A fresh installation checks and installs OMP
     *  automatically; the environment variable remains an explicit override. */
    githubRepo: process.env.OMP_GITHUB_REPO?.trim() || DEFAULT_OMP_GITHUB_REPO,
    channel: (process.env.OMP_CHANNEL ?? 'fast') as 'fast' | 'stable' | 'experimental',
    /** Delay before a release is eligible per channel, in minutes. */
    channelDelayMinutes: { fast: 15, stable: 1440, experimental: 0 } as Record<string, number>,
    checkIntervalMs: Number(process.env.OMP_CHECK_INTERVAL_MS ?? 10 * 60 * 1000)
  },

  /** Agent startup ceilings. All three are overrides: left unset, the budget is
   *  derived from the machine (native vs. emulated CPU) and clamped — see
   *  omp/startupBudget.ts. Raise them only with measured spawn → ready
   *  percentiles from `/api/omp/status`, which is why those are reported. */
  ompStartup: {
    /** 'auto' | 'native' | 'emulated'. */
    profile: process.env.OMP_STARTUP_PROFILE,
    readyTimeoutMs: optionalMs(process.env.OMP_READY_TIMEOUT_MS),
    stateTimeoutMs: optionalMs(process.env.OMP_STATE_TIMEOUT_MS)
  }
}
