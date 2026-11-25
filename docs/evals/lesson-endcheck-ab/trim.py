"""Delete rebuildable slot caches and venvs in closed A/B pairs; --dry lists, --loop SECONDS repeats."""
import json
import os
import shutil
import stat
import subprocess
import sys
import time

LP = chr(92) * 2 + '?' + chr(92)
ROOT = 'C:/z0-lessons/lesson-endcheck-ab'
TRIAL = os.path.join(ROOT, 'trial')
JOURNAL = os.path.join(ROOT, 'trim.jsonl')
DRY = '--dry' in sys.argv


def long_path(path: str) -> str:
    return LP + os.path.abspath(path)


def size(path: str) -> int:
    total, stack = 0, [long_path(path)]
    while stack:
        with os.scandir(stack.pop()) as entries:
            for entry in entries:
                if entry.is_junction() or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                else:
                    total += entry.stat(follow_symlinks=False).st_size
    return total


def unlock(func, path: str, _exc: BaseException) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def slots(pair: str) -> list[str]:
    found, stack = [], [(pair, 0)]
    while stack:
        folder, depth = stack.pop()
        names = set(os.listdir(folder))
        if 'cache' in names and ('work' in names or 'cc' in names):
            found.append(folder)
            continue
        if depth < 2:
            for name in names:
                child = os.path.join(folder, name)
                if os.path.isdir(child) and not os.path.islink(child) and not os.path.isjunction(child):
                    stack.append((child, depth + 1))
    return found


def poetry_cache(slot: str) -> str:
    prep, pair = os.path.basename(os.path.dirname(slot)), os.path.basename(os.path.dirname(os.path.dirname(slot)))
    return os.path.join(ROOT, 'pc', pair[:8] + '-' + prep[-6:] + '-' + os.path.basename(slot))


def targets(slot: str) -> list[str]:
    out = [os.path.join(slot, 'cache'), poetry_cache(slot)]
    venv = os.path.join(slot, 'venv')
    if os.path.isfile(os.path.join(venv, 'pyvenv.cfg')):
        out.append(venv)
    return [p for p in out if os.path.isdir(p) and not os.path.isjunction(p)]


def record(path: str) -> dict:
    if os.path.basename(path) == 'venv':
        freeze = subprocess.run([os.path.join(path, 'Scripts', 'python.exe'), '-m', 'pip', 'freeze', '--all'],
                                capture_output=True, text=True, check=True).stdout
        with open(path + '.freeze.txt', 'w', encoding='utf8') as out:
            out.write(freeze)
        return {'freeze': os.path.basename(path) + '.freeze.txt'}
    return {'parts': {name: round(size(os.path.join(path, name)) / 1e9, 3) for name in os.listdir(path)
                      if os.path.isdir(os.path.join(path, name))}}


def trim_once() -> float:
    freed = 0
    for name in sorted(os.listdir(TRIAL)):
        pair = os.path.join(TRIAL, name)
        if not os.path.isfile(os.path.join(pair, 'result.json')):
            continue
        for slot in slots(pair):
            for path in targets(slot):
                gb = size(path) / 1e9
                if not DRY:
                    kept = record(path)
                    shutil.rmtree(long_path(path), onexc=unlock)
                    with open(JOURNAL, 'a', encoding='utf8') as journal:
                        journal.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'pair': name,
                                                  'path': os.path.relpath(path, TRIAL).replace(chr(92), '/'),
                                                  'gb': round(gb, 3), **kept}) + '\n')
                freed += gb
                print(json.dumps({'dry': DRY, 'pair': name, 'path': path, 'gb': round(gb, 3)}), flush=True)
    return freed


if __name__ == '__main__':
    loop = float(sys.argv[sys.argv.index('--loop') + 1]) if '--loop' in sys.argv else 0
    while True:
        print(json.dumps({'dry': DRY, 'freed_gb': round(trim_once(), 2)}), flush=True)
        if not loop:
            break
        time.sleep(loop)
