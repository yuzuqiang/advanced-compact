#!/usr/bin/env python3
"""Run final-release regressions against an installed dsh profile, without network."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--profile-dir', type=Path, default=Path.home() / '.dsh/profiles/web')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
profile = args.profile_dir.resolve()
candidate = profile / 'node_modules/adaptive-compact'
integrity = json.loads((ROOT / 'packaging/adaptive-compact/release-integrity.json').read_text())
assert integrity['version'] == '0.1.22'
subprocess.run(['node', str(ROOT / 'scripts/check-packaging-sync.mjs')], check=True)
for name, digest in integrity['files'].items():
    assert hashlib.sha256((candidate / name).read_bytes()).hexdigest() == digest, name
inventory = json.loads((ROOT / 'releases/0.1.22/test-integrity.json').read_text())
actual = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in (ROOT / 'tests').rglob('*') if p.is_file()}
assert actual == inventory, 'Test or fixture inventory changed'
output = (args.output or ROOT / f'results/release-0.1.22-{profile.name}').resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='adaptive-compact-022-test-') as tmp:
    temp = Path(tmp)
    shutil.copytree(ROOT / 'tests', temp / 'tests')
    (temp / 'plugin').symlink_to(candidate, target_is_directory=True)
    (temp / 'node_modules').mkdir()
    (temp / 'node_modules/@deepseek-ai').symlink_to(
        profile.parent / 'node_modules/@deepseek-ai', target_is_directory=True)
    command = ['node', '--test', '--test-reporter=tap',
               *[str(p.relative_to(temp)) for p in sorted((temp / 'tests').glob('*.test.mjs'))]]
    result = subprocess.run(command, cwd=temp, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, timeout=60)
    (output / 'regression.log').write_text(result.stdout)
    counts = {name: int(value) for name, value in re.findall(
        r'^# (tests|pass|fail|skipped) (\d+)$', result.stdout, re.MULTILINE)}
    expected = integrity['regression']['expectedTests']
    passed = result.returncode == 0 and counts == {
        'tests': expected, 'pass': expected, 'fail': 0, 'skipped': 0}
    for name in ['cost-wire-replay.json', 'cost-native-replay-results.json', 'cost-cancellation-results.json']:
        if (temp / name).exists(): shutil.copy2(temp / name, output / name)
    receipt = {'version': integrity['version'], 'profile': str(profile),
               'installedPlugin': str(candidate), 'payloadFilesVerified': len(integrity['files']),
               'testFilesVerified': len(inventory), 'command': command,
               'exitCode': result.returncode, 'counts': counts, 'passed': passed,
               'newModelCalls': 0, 'scope': 'Final installed runtime; native mock transactions, saved final outputs, lossless payload references, provenance, budgets and cancellation rollback.'}
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('\n'.join(result.stdout.splitlines()[-9:]))
    if not passed:
        print(result.stdout)
        raise SystemExit(1)
