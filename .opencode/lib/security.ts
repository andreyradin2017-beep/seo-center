import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { realpathSync } from "node:fs"
import { relative, resolve, sep } from "node:path"

export type AuthRole = "admin" | "user" | "it"

export interface AuthInfo {
  role: AuthRole
  uid: string
  sessionVersion?: string
}

export function hasGlobalAccess(auth: AuthInfo | null | undefined): boolean {
  return !auth || auth.role === "admin" || auth.role === "it"
}

const PASSWORD_PREFIX = "scrypt"
const PASSWORD_KEY_LENGTH = 64
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function sanitizeOwnerName(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_.\-]+/gu, "")
    .slice(0, 40)
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, PASSWORD_KEY_LENGTH)
  return `${PASSWORD_PREFIX}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith(`${PASSWORD_PREFIX}$`)) {
    const [, saltText, hashText] = stored.split("$")
    if (!saltText || !hashText) return false
    try {
      const expected = Buffer.from(hashText, "base64url")
      const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length)
      return expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }
  return constantTimeEqual(password, stored)
}

export function constantTimeEqual(value: string, expected: string): boolean {
  const actualBuffer = Buffer.from(value)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

export function credentialVersion(secret: string, credential: string): string {
  return createHmac("sha256", secret).update(`credential:${credential}`).digest("base64url")
}

export function createAuthToken(auth: AuthInfo, secret: string, now = Date.now(), sessionVersion = ""): string {
  const payload = Buffer.from(JSON.stringify({ role: auth.role, uid: auth.uid, exp: now + SESSION_TTL_MS, sessionVersion })).toString("base64url")
  const signature = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

export function parseAuthToken(value: string, secret: string, now = Date.now()): AuthInfo | null {
  const dot = value.lastIndexOf(".")
  if (dot <= 0) return null
  const payload = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  const expected = createHmac("sha256", secret).update(payload).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, "base64url")
  } catch {
    return null
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!decoded || !["admin", "user", "it"].includes(decoded.role)) return null
    if (typeof decoded.uid !== "string" || !decoded.uid || !Number.isFinite(decoded.exp) || decoded.exp <= now) return null
    if (typeof decoded.sessionVersion !== "string" || !decoded.sessionVersion) return null
    return { role: decoded.role, uid: decoded.uid, sessionVersion: decoded.sessionVersion }
  } catch {
    return null
  }
}

export function safePath(root: string, rel: string): string | null {
  try {
    const canonicalRoot = realpathSync(root)
    const candidate = resolve(canonicalRoot, rel)
    const lexicalRelative = relative(canonicalRoot, candidate)
    if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || lexicalRelative.startsWith(`.${sep}`)) return null
    const canonicalCandidate = realpathSync(candidate)
    if (canonicalCandidate !== candidate) return null
    const canonicalRelative = relative(canonicalRoot, canonicalCandidate)
    if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) return null
    return canonicalCandidate
  } catch {
    return null
  }
}
