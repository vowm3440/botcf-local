import path from 'node:path'

/** Shell selection for the built-in terminal.
 *
 *  The session drives a real shell over pipes (there is no PTY in this stack, so
 *  no curses/TUI programs and no password prompts — see terminal/session.ts).
 *  Each shell is started in a "read commands from stdin" mode, which is what
 *  makes a pipe-driven session behave like a console at all.
 *
 *  Only these fixed kinds exist: the project config may *pick* a shell, never
 *  supply an executable path or extra arguments. */

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'sh' | 'zsh'

export interface ShellSpec {
  kind: ShellKind
  file: string
  args: string[]
  label: string
}

export const SHELL_KINDS: readonly ShellKind[] = ['powershell', 'cmd', 'bash', 'sh', 'zsh']

/** `-Command -` / `/K` / `-s` all mean the same thing: keep reading commands
 *  from stdin until it closes. */
const SPECS: Record<ShellKind, Omit<ShellSpec, 'kind'>> = {
  powershell: {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    label: 'PowerShell'
  },
  cmd: { file: 'cmd.exe', args: ['/Q', '/K'], label: 'cmd.exe' },
  bash: { file: 'bash', args: ['-s'], label: 'bash' },
  sh: { file: 'sh', args: ['-s'], label: 'sh' },
  zsh: { file: 'zsh', args: ['-s'], label: 'zsh' }
}

export function shellByKind(kind: ShellKind): ShellSpec {
  return { kind, ...SPECS[kind] }
}

export function isShellKind(value: unknown): value is ShellKind {
  return typeof value === 'string' && (SHELL_KINDS as readonly string[]).includes(value)
}

/** Kind implied by a login shell path (`/bin/zsh` → zsh), null when unknown. */
export function kindFromShellPath(shellPath: string): ShellKind | null {
  const base = path.basename(shellPath).toLowerCase().replace(/\.exe$/, '')
  return isShellKind(base) ? base : null
}

/** Platform default: PowerShell on Windows, else the user's login shell when we
 *  know how to drive it, else sh — which every POSIX system has. */
export function defaultShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellSpec {
  if (platform === 'win32') return shellByKind('powershell')
  const login = env.SHELL ? kindFromShellPath(env.SHELL) : null
  return shellByKind(login ?? 'sh')
}

/** Resolve a configured preference, falling back to the platform default when it
 *  cannot apply (a POSIX shell requested on Windows, or the other way round). */
export function resolveShell(
  preferred: ShellKind | null | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ShellSpec {
  if (!preferred) return defaultShell(platform, env)
  const windowsOnly = preferred === 'powershell' || preferred === 'cmd'
  if (windowsOnly !== (platform === 'win32')) return defaultShell(platform, env)
  return shellByKind(preferred)
}
