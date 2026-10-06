"""Small fixture-free checks for immutable resumes and exact dispatch accounting."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def rejects(call):
    try:
        call()
    except (AssertionError, RuntimeError):
        return
    raise AssertionError('Invalid evidence accepted')

runner, report = load('headless-run'), load('headless-report')
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    for name, data in [('job.json', {}), ('observer.patch.yml', []),
                       ('native-result.json', {'reason': {'kind': 'completed'}})]:
        (out / name).write_text(json.dumps(data))
    spec = {'id': 'synthetic', 'output': str(out), 'job_sha256': runner.sha(out / 'job.json'),
            'patch_sha256': runner.sha(out / 'observer.patch.yml')}
    record = {**spec, 'exit_code': 0}
    runner.validate_records([record], [spec])
    for bad in [[record, record], [{**record, 'id': 'unknown'}],
                [{**record, 'exit_code': 1}], [{**record, 'job_sha256': 'changed'}]]:
        rejects(lambda: runner.validate_records(bad, [spec]))
    (out / 'job.json').write_text('{"modified":true}')
    rejects(lambda: runner.validate_records([], [spec]))
    (out / 'evidence').mkdir()
    (out / 'evidence/freeze.json').write_text('{}')
    before = {p.name: p.read_bytes() for p in out.iterdir() if p.is_file()}
    with patch.object(sys, 'argv', ['headless-run.py', '--run', tmp, '--offline']):
        rejects(runner.main)
    assert before == {p.name: p.read_bytes() for p in out.iterdir() if p.is_file()}

ledger = [{'job': 'synthetic', 'index': 1, 'purpose': 'conversation', 'wireSha256': 'digest'}]
attempt = {**ledger[0], 'id': 1}
report.validate_attempts([attempt], ledger, 3)
for bad in [[], [{**attempt, 'id': 2}], [{**attempt, 'job': 'unknown'}],
            [{**attempt, 'wireSha256': 'changed'}], [attempt, attempt]]:
    rejects(lambda: report.validate_attempts(bad, ledger, 3))
rejects(lambda: report.validate_attempts([attempt], ledger, 0))
print('Harness checks passed: immutable resumes and exact dispatch accounting.')
