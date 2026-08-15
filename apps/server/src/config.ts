import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DATA_DIR = process.env.BOTCF_DATA_DIR ?? path.resolve(process.cwd(), 'data')

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

  /** Stable per-installation id used in dedicated key names (omp-local-<deviceId>-<group>). */
  deviceId: process.env.BOTCF_DEVICE_ID ?? (os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) || 'local'),

  ompUpdate: {
    /** GitHub repo that publishes OMP releases, e.g. "openmodelproxy/omp". */
    githubRepo: process.env.OMP_GITHUB_REPO ?? '',
    channel: (process.env.OMP_CHANNEL ?? 'fast') as 'fast' | 'stable' | 'experimental',
    /** Delay before a release is eligible per channel, in minutes. */
    channelDelayMinutes: { fast: 15, stable: 1440, experimental: 0 } as Record<string, number>,
    checkIntervalMs: Number(process.env.OMP_CHECK_INTERVAL_MS ?? 10 * 60 * 1000)
  }
}
