import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, path)
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }) } catch {}
    throw error
  }
}
