import { fileURLToPath } from 'node:url'
import { verifyImportedRelease } from './verify-imported-release.mjs'

verifyImportedRelease(fileURLToPath(new URL('../', import.meta.url)))
