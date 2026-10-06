#!/usr/bin/env python3
"""Reject private data, personal paths and credentials in publishable Git content."""
import argparse
import io
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
ALLOWED_JSON = {'package.json', 'packaging/adaptive-compact/package.json',
                'packaging/artifact-store/package.json',
                'packaging/adaptive-compact/release-integrity.json'}
ALLOWED_TAR = {'packaging/adaptive-compact/adaptive-compact-0.1.22.tgz',
               'packaging/adaptive-compact/adaptive-compact-0.1.23.tgz',
               'packaging/adaptive-compact/source-candidate-0.1.22.tgz'}
PRIVATE_ROOTS = {'releases', 'results', 'private', 'data', 'coverage', 'node_modules'}
PATTERNS = {
    'personal path': rb'(?:/home/[A-Za-z0-9_.-]+|/media/[A-Za-z0-9_.-]+|/Users/[A-Za-z0-9_.-]+|[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+)',
    'GitHub token': rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
    'API key': rb'(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})',
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'private network address': rb'\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b',
    'hardware address': rb'\b(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}\b',
    'personal email': rb'\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org|net|invalid)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b',
}
PATTERNS = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def inspect_bytes(label, data):
    for name, pattern in PATTERNS.items():
        if pattern.search(data):
            raise ValueError(f'{label}: {name} found (value withheld)')


def inspect_file(name, data):
    inspect_bytes(name, name.encode())
    path = PurePosixPath(name)
    if (path.parts[0] in PRIVATE_ROOTS or name.startswith('tests/fixtures/')
            or any(part.startswith('.env') for part in path.parts)
            or path.suffix in {'.zip', '.jsonl', '.csv', '.sse', '.log', '.txt', '.bundle'}
            or path.suffix == '.json' and name not in ALLOWED_JSON):
        raise ValueError(f'{name}: local data/configuration must not be published')
    if path.suffix == '.tgz':
        if name not in ALLOWED_TAR:
            raise ValueError(f'{name}: unapproved archive')
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive:
                member_path = PurePosixPath(member.name)
                if (not member.isfile() or member_path.is_absolute()
                        or '..' in member_path.parts or member.size > 10_000_000):
                    raise ValueError(f'{name}: unsafe archive member')
                inspect_bytes(name, member.name.encode())
                inspect_bytes(f'{name}:{member.name}', archive.extractfile(member).read())
    else:
        if b'\0' in data:
            raise ValueError(f'{name}: unapproved binary file')
        inspect_bytes(name, data)


def self_test():
    for name, data in [('README.md', b'/home/' + b'example-user/project'),
                       ('README.md', b'ghp_' + b'A' * 36),
                       ('README.md', b'-----BEGIN ' + b'PRIVATE KEY-----'),
                       ('README.md', b'192.' + b'168.1.15'),
                       ('README.md', b'00:11:22:' + b'33:44:55'),
                       ('releases/cleanup.json', b'{}'),
                       ('tests/fixtures/snapshot.json', b'{}')]:
        try:
            inspect_file(name, data)
        except ValueError:
            pass
        else:
            raise AssertionError('Publication guard accepted a forbidden test case')
    output = io.BytesIO()
    data = b'/home/' + b'example-user/private-file'
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        member = tarfile.TarInfo('package/index.js')
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    try:
        inspect_file(next(iter(ALLOWED_TAR)), output.getvalue())
    except ValueError:
        pass
    else:
        raise AssertionError('Publication guard accepted a leaking archive')
    inspect_file('README.md', b'# Public documentation\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', help='Check this commit and all its ancestors before pushing')
    args = parser.parse_args()
    self_test()
    revisions = git('rev-list', args.commit).decode().splitlines() if args.commit else [None]
    checked = set()
    for revision in revisions:
        if revision:
            inspect_bytes('commit message', git('show', '-s', '--format=%B', revision))
            for email in git('show', '-s', '--format=%ae%n%ce', revision).decode().splitlines():
                if not email.endswith('@users.noreply.github.com'):
                    raise ValueError('Commit metadata contains a non-GitHub-noreply email (value withheld)')
            records = git('ls-tree', '-rz', '--full-tree', revision).split(b'\0')
        else:
            records = git('ls-files', '--stage', '-z').split(b'\0')
        for record in filter(None, records):
            metadata, raw_name = record.split(b'\t', 1)
            parts = metadata.decode().split()
            mode, oid = (parts[0], parts[2]) if revision else (parts[0], parts[1])
            name = raw_name.decode()
            if mode not in {'100644', '100755'}:
                raise ValueError(f'{name}: symlinks and submodules require separate review')
            if (name, oid) not in checked:
                inspect_file(name, git('cat-file', 'blob', oid))
                checked.add((name, oid))
    print(f'Publication check passed: {len(checked)} file versions; local data excluded.')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(f'Publication check failed: {error}', file=sys.stderr)
        raise SystemExit(1)
