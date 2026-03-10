/**
 * AES-256-GCM encryption/decryption for storing provider API keys.
 *
 * Uses Web Crypto API — works in both Bun/Node and Deno (Supabase Edge Functions).
 *
 * Uses ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 * Falls back to a key derived from JWT_SECRET if ENCRYPTION_KEY is not set.
 */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function getKeyBytes(): Promise<Uint8Array> {
  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    return hexToBytes(envKey)
  }
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error("Neither ENCRYPTION_KEY nor JWT_SECRET is set")
  }
  // Derive a 32-byte key from JWT_SECRET via SHA-256
  const encoded = new TextEncoder().encode(jwtSecret)
  const hash = await crypto.subtle.digest("SHA-256", encoded as BufferSource)
  return new Uint8Array(hash)
}

async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64(iv + ciphertext + authTag).
 * Tag is appended by Web Crypto automatically.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const keyBytes = await getKeyBytes()
  const key = await importKey(keyBytes)
  const iv = crypto.getRandomValues(new Uint8Array(12)) // 12-byte IV for GCM
  const encoded = new TextEncoder().encode(plaintext)

  // Web Crypto AES-GCM appends the 16-byte auth tag to the ciphertext
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoded as BufferSource,
  )

  // Combine: iv (12) + ciphertext+tag (variable)
  const result = new Uint8Array(iv.length + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), iv.length)

  return bytesToBase64(result)
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects base64(iv + ciphertext + authTag).
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const keyBytes = await getKeyBytes()
  const key = await importKey(keyBytes)
  const data = base64ToBytes(ciphertext)

  const iv = data.subarray(0, 12)
  // Web Crypto expects ciphertext+tag together (it handles tag extraction internally)
  const encrypted = data.subarray(12)

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encrypted as BufferSource,
  )

  return new TextDecoder().decode(decrypted)
}
