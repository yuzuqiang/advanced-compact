#!/usr/bin/env python3
"""Build/verify explicit, reproducible release artifacts without npm or network.

Build writes a separate staging tree only. It never overwrites the input checkout.
The preserved 0.1.22 archives are provenance, not the source of new executable code.
"""
import argparse
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile

PREFIX = 'node_modules/@adaptive-compact/dsh-artifact-store/'
BASE_ARCHIVE = 'adaptive-compact-0.1.22.tgz'
BASE_HASH = 'cb0efe9eb531baff457506c273c450720cd7368d93bb9f026a929890dd92d64a'
SOURCE_ARCHIVE = 'source-candidate-0.1.22.tgz'
SOURCE_HASH = '598625285512fc56be30168d1631c92319d4dca74bd66ae49a413cac7a96c396'
SEMVER = re.compile(r'0\.1\.(?:0|[1-9][0-9]*)\Z')
SHA256 = re.compile(r'[0-9a-f]{64}\Z')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def archive(path, expected_hash):
    require(not path.is_symlink() and path.is_file(), 'archive must be a regular file')
    raw = path.read_bytes()
    require(sha(raw) == expected_hash, 'archive digest mismatch: ' + path.name)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:
        for member in tar:
            name = member.name
            p = PurePosixPath(name)
            require(member.isfile() and not member.issym() and not member.islnk(), 'non-file archive member')
            require(name.startswith('package/') and not p.is_absolute()
                    and '..' not in p.parts and str(p) == name, 'unsafe archive path')
            require(0 <= member.size <= 10_000_000, 'oversized archive member')
            relative = name[len('package/'):]
            require(relative not in files and relative, 'duplicate/empty archive member')
            files[relative] = tar.extractfile(member).read()
    return files


def verify_hashes(payload, hashes, label):
    require(set(payload) == set(hashes), label + ' inventory mismatch')
    for name, digest in hashes.items():
        require(SHA256.fullmatch(digest) is not None, label + ' invalid digest')
        require(sha(payload[name]) == digest, label + ' file digest mismatch: ' + name)


def verify_imported(bundle, base):
    require(base['regression'] == {'expectedTests': 54}, 'historical regression expectation changed')
    require(base['version'] == '0.1.22' and base['sourceVersion'] == '0.1.22-local.2', 'baseline version changed')
    require(base['tarball'] == BASE_ARCHIVE and base['tarballSha256'] == BASE_HASH, 'baseline identity changed')
    require(base['sourceArchive'] == SOURCE_ARCHIVE and base['sourceArchiveSha256'] == SOURCE_HASH, 'source identity changed')
    packed = archive(bundle / BASE_ARCHIVE, BASE_HASH)
    source = archive(bundle / SOURCE_ARCHIVE, SOURCE_HASH)
    verify_hashes(packed, base['files'], 'baseline')
    require(set(source) == set(packed), 'source inventory differs from baseline')
    changes = {name for name in source if source[name] != packed[name]}
    require(set(base['sourceChanges']) == changes, 'historical source change inventory differs')
    for name in changes:
        change = base['sourceChanges'][name]
        require(change['sourceSha256'] == sha(source[name]), 'historical source hash changed')
        expected = ('package-metadata' if name.endswith('package.json') else
                    'comments-and-auth-error-text' if name in {'index.js', 'config.js'} else 'comments')
        require(change['kind'] == expected, 'historical source change category changed')
    manifest = json.loads(packed['package.json'])
    source_manifest = json.loads(source['package.json'])
    require(source_manifest['version'] == base['sourceVersion'], 'source package version differs')
    source_manifest['version'] = manifest['version']
    source_manifest.pop('dshLocalPackaging', None)
    require(source_manifest == manifest, 'historical operational package fields changed')
    dep = json.loads(source[PREFIX + 'package.json'])
    dep.pop('comment', None)
    require(dep == json.loads(packed[PREFIX + 'package.json']), 'historical dependency fields changed')
    return packed


def loose_files(root, inventory):
    bundle = root / 'packaging/adaptive-compact'
    dependency = root / 'packaging/artifact-store'
    payload = {}
    for name in inventory:
        p = PurePosixPath(name)
        require(not p.is_absolute() and '..' not in p.parts and str(p) == name, 'unsafe payload path')
        path = dependency / name[len(PREFIX):] if name.startswith(PREFIX) else bundle / name
        require(not path.is_symlink() and path.is_file(), 'loose payload is not a regular file: ' + name)
        payload[name] = path.read_bytes()
    source_files = {p.name for p in bundle.iterdir() if p.suffix in {'.js', '.yml'} or p.name == 'package.json'}
    dep_files = {p.name for p in dependency.iterdir() if p.suffix in {'.js', '.json'}}
    require(source_files == {n for n in inventory if not n.startswith(PREFIX)}, 'unexpected loose release files')
    require(dep_files == {n[len(PREFIX):] for n in inventory if n.startswith(PREFIX)}, 'unexpected dependency files')
    return payload


def validate_manifest(payload, base_payload, version):
    require(SEMVER.fullmatch(version) is not None, 'only explicit 0.1.x versions are supported')
    manifest = json.loads(payload['package.json'])
    base_manifest = json.loads(base_payload['package.json'])
    base_manifest['version'] = version
    require(manifest == base_manifest, 'only release version may change package operational fields')
    require(payload[PREFIX + 'package.json'] == base_payload[PREFIX + 'package.json'], 'dependency package metadata changed')
    expected = set(manifest['files']) | {PREFIX + n for n in json.loads(payload[PREFIX + 'package.json'])['files']}
    require(expected == set(payload), 'manifest file inventory mismatch')


def pack_bytes(payload):
    raw = io.BytesIO()
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode='w|', format=tarfile.USTAR_FORMAT) as tar:
            for name, data in sorted(payload.items()):
                member = tarfile.TarInfo('package/' + name)
                member.size = len(data)
                member.mode = 0o644
                member.uid = member.gid = member.mtime = 0
                member.uname = member.gname = ''
                tar.addfile(member, io.BytesIO(data))
    return raw.getvalue()


def verify(root):
    bundle = root / 'packaging/adaptive-compact'
    integrity = read_json(bundle / 'release-integrity.json')
    require('importedRelease' not in integrity or integrity.get('schemaVersion') == 2, 'importedRelease requires schema version 2')
    base = integrity.get('importedRelease', integrity)
    base_payload = verify_imported(bundle, base)
    payload = loose_files(root, base_payload)
    if integrity.get('schemaVersion') == 2:
        version = integrity['version']
        require(int(version.split('.')[-1]) > 22 and SEMVER.fullmatch(version), 'new version must follow 0.1.22')
        require(integrity['tarball'] == f'adaptive-compact-{version}.tgz', 'tarball filename mismatch')
        packed = archive(bundle / integrity['tarball'], integrity['tarballSha256'])
        verify_hashes(payload, integrity['files'], 'loose')
        verify_hashes(packed, integrity['files'], 'packed')
        validate_manifest(payload, base_payload, version)
        changes = {name for name in payload if payload[name] != base_payload[name]}
        require(set(integrity['releaseChanges']) == changes, 'new source change inventory mismatch')
        for name in changes:
            change = integrity['releaseChanges'][name]
            require(change['beforeSha256'] == sha(base_payload[name]) and change['afterSha256'] == sha(payload[name]), 'release change hashes differ')
            require(change['kind'] == ('version-metadata' if name == 'package.json' else 'source-change'), 'release change kind differs')
            require(isinstance(change['note'], str) and 0 < len(change['note']) <= 500, 'missing/oversized source change note')
        require(any(n != 'package.json' for n in changes), 'version-only release is not permitted')
        require(pack_bytes(payload) == (bundle / integrity['tarball']).read_bytes(), 'release is not reproducible in this Python/zlib toolchain')
        require(integrity['regression'] == base['regression'], 'regression expectations must not silently change')
    else:
        require('schemaVersion' not in integrity, 'unsupported integrity schema')
        verify_hashes(payload, base['files'], 'loose imported release')
    for name, data in payload.items():
        require(not re.search(rb'\bdocs/|sourceMappingURL=', data), 'obsolete reference: ' + name)
        if name.endswith('.js'):
            path = root / 'packaging/artifact-store' / name[len(PREFIX):] if name.startswith(PREFIX) else bundle / name
            subprocess.run(['node', '--check', str(path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # Scan only explicit publication inputs. Never copy fixtures, results or a
    # development node_modules tree into the release. The separate Git guard
    # remains mandatory for scripts, documentation, and commit history.
    guard_spec = importlib.util.spec_from_file_location('publication_guard', Path(__file__).with_name('check-publication.py'))
    guard = importlib.util.module_from_spec(guard_spec)
    guard_spec.loader.exec_module(guard)
    guard.self_test()
    paths = [root / 'package.json', bundle / 'release-integrity.json',
             bundle / BASE_ARCHIVE, bundle / SOURCE_ARCHIVE]
    if integrity.get('schemaVersion') == 2:
        paths.append(bundle / integrity['tarball'])
    for name in payload:
        paths.append(root / 'packaging/artifact-store' / name[len(PREFIX):]
                     if name.startswith(PREFIX) else bundle / name)
    for path in paths:
        guard.inspect_file(path.relative_to(root).as_posix(), path.read_bytes())
    print(f"Verified adaptive-compact {integrity['version']}: {len(payload)} payload files, hashes, provenance, syntax")


def build(root, output, version, notes):
    require(output != root and not output.exists(), 'output must be a new staging directory')
    require(SEMVER.fullmatch(version) and int(version.split('.')[-1]) > 22, 'version must follow 0.1.22')
    bundle = root / 'packaging/adaptive-compact'
    current = read_json(bundle / 'release-integrity.json')
    base = copy.deepcopy(current.get('importedRelease', current))
    base_payload = verify_imported(bundle, base)
    payload = loose_files(root, base_payload)
    manifest = json.loads(payload['package.json'])
    manifest['version'] = version
    payload['package.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    validate_manifest(payload, base_payload, version)
    changes = {n for n in payload if payload[n] != base_payload[n]}
    require(set(notes) == changes - {'package.json'}, 'notes must list every changed source file and no unchanged files')
    require(notes, 'no source improvements supplied; do not create a version-only release')
    for note in notes.values():
        require(isinstance(note, str) and 0 < len(note) <= 500, 'change notes must be nonempty public-safe strings of <=500 characters')
    tarball = f'adaptive-compact-{version}.tgz'
    packed = pack_bytes(payload)
    integrity = {
        'schemaVersion': 2, 'version': version,
        'change': 'Source changes against preserved 0.1.22. Hash verification does not replace tests or GitHub review.',
        'tarball': tarball, 'tarballSha256': sha(packed),
        'files': {n: sha(data) for n, data in sorted(payload.items())},
        'regression': copy.deepcopy(base['regression']),
        'importedRelease': base,
        'releaseChanges': {n: {'beforeSha256': sha(base_payload[n]), 'afterSha256': sha(payload[n]),
                              'kind': 'version-metadata' if n == 'package.json' else 'source-change',
                              'note': 'Release version updated; operational package fields unchanged.' if n == 'package.json' else notes[n]}
                           for n in sorted(changes)},
    }
    output.mkdir(parents=True)
    for name, data in payload.items():
        path = output / 'packaging/artifact-store' / name[len(PREFIX):] if name.startswith(PREFIX) else output / 'packaging/adaptive-compact' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    out_bundle = output / 'packaging/adaptive-compact'
    for name in [BASE_ARCHIVE, SOURCE_ARCHIVE]:
        shutil.copyfile(bundle / name, out_bundle / name)
    (out_bundle / tarball).write_bytes(packed)
    write_json(out_bundle / 'release-integrity.json', integrity)
    workspace = read_json(root / 'package.json')
    workspace['version'] = version
    write_json(output / 'package.json', workspace)
    verify(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build', 'verify'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--version')
    parser.add_argument('--changes', type=Path, help='JSON map of changed payload paths to public change notes')
    args = parser.parse_args()
    if args.action == 'verify':
        verify(args.root.resolve())
    else:
        require(args.output and args.version and args.changes, 'build requires output, version and changes')
        build(args.root.resolve(), args.output.resolve(), args.version, read_json(args.changes))


if __name__ == '__main__':
    main()
