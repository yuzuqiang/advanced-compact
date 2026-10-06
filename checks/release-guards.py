#!/usr/bin/env python3
"""Dependency-free negative tests for release metadata and archive validation."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release_artifact', ROOT / 'scripts/release-artifact.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
current = json.loads((ROOT / 'packaging/adaptive-compact/release-integrity.json').read_text())
base = current.get('importedRelease', current)
checks = 0

def rejects(action, expected):
    global checks
    try:
        action()
    except ValueError as error:
        assert expected in str(error), str(error)
        checks += 1
    else:
        raise AssertionError('invalid release accepted: ' + expected)

changed = copy.deepcopy(base)
changed['regression'] = {'expectedTests': 0}
rejects(lambda: release.verify_imported(ROOT / 'packaging/adaptive-compact', changed), 'regression expectation')

with tempfile.TemporaryDirectory(prefix='compact-release-guards-') as directory:
    root = Path(directory)
    bundle = root / 'packaging/adaptive-compact'
    bundle.mkdir(parents=True)
    wrapped = copy.deepcopy(base)
    wrapped['importedRelease'] = base
    wrapped['version'] = '0.1.99'
    (bundle / 'release-integrity.json').write_text(json.dumps(wrapped))
    rejects(lambda: release.verify(root), 'requires schema version 2')

    for kind in ['duplicate', 'traversal', 'symlink']:
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as tar:
            names = ['package/a.js', 'package/a.js'] if kind == 'duplicate' else ['package/../a.js' if kind == 'traversal' else 'package/a.js']
            for name in names:
                member = tarfile.TarInfo(name)
                if kind == 'symlink':
                    member.type = tarfile.SYMTYPE
                    member.linkname = 'elsewhere'
                    tar.addfile(member)
                else:
                    member.size = 1
                    tar.addfile(member, io.BytesIO(b'x'))
        path = root / (kind + '.tgz')
        path.write_bytes(stream.getvalue())
        rejects(lambda: release.archive(path, hashlib.sha256(stream.getvalue()).hexdigest()),
                {'duplicate':'duplicate','traversal':'unsafe archive path','symlink':'non-file archive member'}[kind])

print(f'Release guard tests passed: {checks} negative cases')
