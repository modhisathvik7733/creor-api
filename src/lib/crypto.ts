import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"

/**
 * AES-256-GCM encryption/decryption for storing provider API keys.
 *
 * Uses ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 * Falls back to a key derived from JWT_SECRET if ENCRYPTION_KEY is not set.
 */

function getKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    return Buffer.from(envKey, "hex")
  }
  // Derive a 32-byte key from JWT_SECRET
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error("Neither ENCRYPTION_KEY nor JWT_SECRET is set")
  }
  return createHash("sha256").update(jwtSecret).digest()
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64(iv + ciphertext + authTag).
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(12) // 12-byte IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag() // 16 bytes

  // iv (12) + ciphertext (variable) + tag (16)
  const result = Buffer.concat([iv, encrypted, tag])
  return result.toString("base64")
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects base64(iv + ciphertext + authTag).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey()
  const data = Buffer.from(ciphertext, "base64")

  const iv = data.subarray(0, 12)
  const tag = data.subarray(data.length - 16)
  const encrypted = data.subarray(12, data.length - 16)

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ])
  return decrypted.toString("utf8")
}
