import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Verify an imported release, its tarball, and the bundled runtime dependency. */
export function verifyImportedRelease(root) {
  const bundle = join(root, 'packaging', 'adaptive-compact')
  const integrity = JSON.parse(readFileSync(join(bundle, 'release-integrity.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
  assert.equal(manifest.version, integrity.version, 'release version')
  assert.equal(integrity.tarball, `${manifest.name}-${manifest.version}.tgz`, 'tarball filename')
  const tarball = join(bundle, integrity.tarball)
  assert.equal(digest(readFileSync(tarball)), integrity.tarballSha256, 'tarball digest')
  assert.equal(digest(readFileSync(resolve(bundle, integrity.sourceArchive))), integrity.sourceArchiveSha256, 'source archive digest')

  const expected = Object.keys(integrity.files).sort()
  const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim().split('\n').map(name => {
      assert(name.startsWith('package/') && !name.split('/').includes('..'), `unsafe member: ${name}`)
      return name.slice('package/'.length)
    }).sort()
  assert.deepEqual(members, expected, 'complete tarball inventory')
  const sourceTarball = resolve(bundle, integrity.sourceArchive)
  assert.deepEqual(execFileSync('tar', ['-tzf', sourceTarball], { encoding: 'utf8' })
    .trim().split('\n').sort(), expected.map(name => `package/${name}`).sort(), 'source candidate inventory')
  const sourceManifest = JSON.parse(execFileSync('tar', ['-xzOf', sourceTarball, 'package/package.json']))
  assert.equal(sourceManifest.version, integrity.sourceVersion, 'source candidate version')
  sourceManifest.version = manifest.version
  assert.deepEqual(sourceManifest, manifest, 'only source package version normalized')
  const dependencyPrefix = 'node_modules/@adaptive-compact/dsh-artifact-store/'
  const sourceFiles = expected.filter(name => !name.startsWith(dependencyPrefix))
  const actualFiles = readdirSync(bundle).filter(name => /\.(js|yml)$/.test(name) || name === 'package.json').sort()
  assert.deepEqual(actualFiles, sourceFiles.sort(), 'complete loose release inventory')
  const dependencyFiles = expected.filter(name => name.startsWith(dependencyPrefix))
    .map(name => name.slice(dependencyPrefix.length)).sort()
  assert.deepEqual(readdirSync(join(root, 'packaging', 'artifact-store')).filter(name => /\.(js|json)$/.test(name)).sort(), dependencyFiles, 'complete dependency inventory')

  for (const [name, hash] of Object.entries(integrity.files)) {
    const loose = name.startsWith(dependencyPrefix)
      ? join(root, 'packaging', 'artifact-store', name.slice(dependencyPrefix.length))
      : join(bundle, name)
    assert.equal(digest(readFileSync(loose)), hash, `loose file: ${name}`)
    const packed = execFileSync('tar', ['-xzOf', tarball, `package/${name}`])
    assert.equal(digest(packed), hash, `packed file: ${name}`)
    if (name !== 'package.json') {
      assert.equal(digest(execFileSync('tar', ['-xzOf', sourceTarball, `package/${name}`])), hash, `source candidate: ${name}`)
    }
    if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', loose], { stdio: 'pipe' })
  }
  console.log(`✓ adaptive-compact ${manifest.version}: ${expected.length} payload files, bundled dependency, syntax and release hashes verified`)
}
