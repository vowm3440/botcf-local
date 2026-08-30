import type { WorkspaceRootInfo } from '../api'
import { SELECT } from './ui'

/** Workspace-root selector shared by the panels that act on one directory.
 *
 *  The empty value means "let the server pick" (the primary root), which is what
 *  a single-directory workspace always meant. A root whose directory disappeared
 *  stays listed but is not selectable — removing it is a deliberate action in the
 *  file panel. */

export interface RootPickerProps {
  roots: readonly WorkspaceRootInfo[]
  /** Selected root id, or '' for the server's default. */
  value: string
  onChange: (rootId: string) => void
  disabled?: boolean
  label?: string
  /** Render even when only one root is open (default: hide the noise). */
  alwaysShow?: boolean
}

export default function RootPicker({ roots, value, onChange, disabled, label = '目录', alwaysShow }: RootPickerProps) {
  if (roots.length <= 1 && !alwaysShow) return null
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      style={SELECT}
    >
      {roots.map((root) => (
        <option key={root.id} value={root.id} disabled={!root.exists}>
          {root.name}
          {root.primary ? ' (主)' : ''}
          {root.exists ? '' : '(不存在)'}
        </option>
      ))}
    </select>
  )
}
