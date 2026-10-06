import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Verify original imports or schema-2 optimized releases using strict archive parsing. */
export function verifyImportedRelease(root) {
  execFileSync('python3', [
    fileURLToPath(new URL('./release-artifact.py', import.meta.url)),
    'verify', '--root', root,
  ], { stdio: 'inherit' })
}
