import fs from 'node:fs'
import crypto from 'node:crypto'
import { config } from '../config.js'

/** Encrypted-at-rest secret store (AES-256-GCM via node:crypto — no native or
 *  WASM deps). Values live in SQLite as base64 ciphertext; the master key never
 *  leaves /data/secrets/master.key (mode 0600). */

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

let masterKey: Buffer | null = null

export async function initSecrets(): Promise<void> {
  fs.mkdirSync(config.secretsDir, { recursive: true })
  if (fs.existsSync(config.masterKeyPath)) {
    masterKey = fs.readFileSync(config.masterKeyPath)
    if (masterKey.length !== KEY_BYTES) {
      throw new Error('master.key is corrupt: unexpected length')
    }
  } else {
    masterKey = crypto.randomBytes(KEY_BYTES)
    fs.writeFileSync(config.masterKeyPath, masterKey, { mode: 0o600 })
  }
  try {
    fs.chmodSync(config.masterKeyPath, 0o600)
  } catch {
    /* chmod is a no-op on some Windows volumes; the container path enforces it */
  }
}

function requireKey(): Buffer {
  if (!masterKey) throw new Error('secret store not initialized: call initSecrets() first')
  return masterKey
}

/** base64( iv | authTag | ciphertext ) */
export function seal(plaintext: string): string {
  const key = requireKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function open(sealed: string): string {
  const key = requireKey()
  const packed = Buffer.from(sealed, 'base64')
  const iv = packed.subarray(0, IV_BYTES)
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = packed.subarray(IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
