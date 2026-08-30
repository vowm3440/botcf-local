import { execFile } from 'node:child_process'

/** The only place a `git` process is started.
 *
 *  Rules that keep this safe to expose over the local HTTP surface:
 *   - never a shell: argv is passed through, so no path or message can be
 *     interpreted as a command;
 *   - `--` before user-supplied pathspecs is the caller's job, but every value
 *     that could start with `-` is additionally rejected by git/service.ts;
 *   - no credential or editor prompts (they would hang a request forever);
 *   - bounded output and a timeout, so a huge diff or a wedged repository
 *     degrades into an error instead of eating the process. */

export interface GitResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export const GIT_TIMEOUT_MS = 15_000
export const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Environment for a non-interactive, locale-stable git run. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    // Porcelain output is stable, but hints/warnings are not: force English so
    // error text stays greppable across machines.
    LC_ALL: 'C'
  }
}

export interface RunGitOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  /** Text written to git's stdin (commit messages avoid the argv/quoting mess). */
  stdin?: string
}

export function runGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
  const { timeoutMs = GIT_TIMEOUT_MS, maxOutputBytes = GIT_MAX_OUTPUT_BYTES, stdin } = options
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        env: gitEnv(),
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout, stderr })
          return
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
        const message = stderr || error.message
        resolve({ ok: false, code, stdout, stderr: message })
      }
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

/** True when a `git` executable can be found at all. Cached: the answer cannot
 *  change while the process runs, and every git panel refresh would otherwise
 *  pay for a spawn. */
let gitAvailable: boolean | null = null

export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable
  const result = await runGit(process.cwd(), ['--version'], { timeoutMs: 5_000 })
  gitAvailable = result.ok
  return gitAvailable
}

/** Test seam: reset the cached availability probe. */
export function resetGitAvailability(): void {
  gitAvailable = null
}
