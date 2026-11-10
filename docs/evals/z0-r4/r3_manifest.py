"""Check a round's runs files against a sha256 manifest before any script prints a figure; stdlib only, imported by path."""
import datetime
import hashlib
import json
import pathlib
import sys

DEFAULT_MANIFEST = pathlib.Path(__file__).with_name('r3-total-spend.inputs.json')
FIX = "restore round 3's file, or pass --manifest for another frozen set"


def add_flags(ap):
    ap.add_argument('root', type=pathlib.Path)
    ap.add_argument('--manifest', type=pathlib.Path, default=DEFAULT_MANIFEST)


def _digests(root):
    files = sorted(root.glob('*/run/runs.jsonl'))
    return files, {f.relative_to(root).as_posix(): hashlib.sha256(f.read_bytes()).hexdigest() for f in files}


def write(root, manifest):
    if manifest.exists():
        sys.exit(f'{manifest} exists; pass --manifest with a new path to write another')
    _, digests = _digests(root)
    entries = [{'file': name, 'sha256': digests[name]} for name in sorted(digests)]
    body = {'root': root.as_posix(), 'written': datetime.date.today().isoformat(), 'files': entries}
    manifest.write_text(json.dumps(body, indent=2) + '\n', encoding='utf-8')
    print(f'wrote {len(entries)} files to {manifest}')


def checked_files(root, manifest):
    """The runs files under root, returned only when the set and every sha256 equal the manifest's."""
    files, digests = _digests(root)
    try:
        recorded = {e['file']: e['sha256'] for e in json.loads(manifest.read_text(encoding='utf-8'))['files']}
    except (OSError, ValueError, KeyError, TypeError) as e:
        sys.exit(f'cannot read manifest {manifest} ({e}); {FIX}')
    problems = [
        f'{name}: sha256 {digests.get(name, "missing")} under {root}, the manifest {manifest} recorded {recorded.get(name, "no entry")}'
        for name in sorted(digests.keys() | recorded.keys())
        if digests.get(name) != recorded.get(name)
    ]
    if problems:
        sys.exit('\n'.join(problems) + f'\n{FIX}')
    return files
