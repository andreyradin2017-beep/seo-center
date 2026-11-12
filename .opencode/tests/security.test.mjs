import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createAuthToken, hasGlobalAccess, hashPassword, parseAuthToken, safePath, verifyPassword } from "../lib/security.ts"
import { writeJsonAtomic } from "../lib/json-store.ts"

test("passwords are salted hashes and verify without exposing the original", () => {
  const first = hashPassword("correct horse battery staple")
  const second = hashPassword("correct horse battery staple")
  assert.notEqual(first, second)
  assert.match(first, /^scrypt\$/)
  assert.equal(verifyPassword("correct horse battery staple", first), true)
  assert.equal(verifyPassword("wrong password", first), false)
})

test("auth cookies are signed, role-checked and expire", () => {
  const auth = { role: "admin", uid: "operator" }
  const token = createAuthToken(auth, "test-session-secret", 1_000, "credential-v1")
  assert.deepEqual(parseAuthToken(token, "test-session-secret", 2_000), { ...auth, sessionVersion: "credential-v1" })
  assert.equal(parseAuthToken(`${token}x`, "test-session-secret", 2_000), null)
  assert.equal(parseAuthToken(token, "another-secret", 2_000), null)
  assert.equal(parseAuthToken(token, "test-session-secret", 31 * 24 * 60 * 60 * 1000), null)
})

test("admin and IT roles share global project access; employees do not", () => {
  assert.equal(hasGlobalAccess({ role: "admin", uid: "admin" }), true)
  assert.equal(hasGlobalAccess({ role: "it", uid: "melnikov" }), true)
  assert.equal(hasGlobalAccess({ role: "user", uid: "alex" }), false)
})

test("safe paths reject traversal and symlink traversal", () => {
  const base = mkdtempSync(join(tmpdir(), "seo-security-"))
  const root = join(base, "results")
  const outside = join(base, "outside")
  try {
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(root, "report.csv"), "a,b\n1,2\n")
    writeFileSync(join(outside, "secret.csv"), "secret")
    symlinkSync(outside, join(root, "linked"), "dir")
    assert.equal(safePath(root, "report.csv"), join(root, "report.csv"))
    assert.equal(safePath(root, "../outside/secret.csv"), null)
    assert.equal(safePath(root, "linked/secret.csv"), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("JSON store replaces data atomically and keeps private permissions", () => {
  const base = mkdtempSync(join(tmpdir(), "seo-json-store-"))
  const path = join(base, "nested", "store.json")
  try {
    writeJsonAtomic(path, { version: 1 })
    writeJsonAtomic(path, { version: 2 })
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2 })
    // Windows не отдаёт POSIX-биты: chmod 600 там не выражается через mode.
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
