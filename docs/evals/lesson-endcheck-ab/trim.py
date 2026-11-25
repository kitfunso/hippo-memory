"""Delete rebuildable slot caches and venvs in closed A/B pairs; --dry lists, --loop SECONDS repeats."""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

LP = chr(92) * 2 + '?' + chr(92)
ROOT = 'C:/z0-lessons/lesson-endcheck-ab'
TRIAL = os.path.join(ROOT, 'trial')
PC = os.path.join(ROOT, 'pc')
PLAN = os.path.join(ROOT, 'corpus', 'plan.json')
JOURNAL = os.path.join(ROOT, 'trim.jsonl')
DRY = '--dry' in sys.argv


def runs_python(check_path: str, seen: frozenset = frozenset()) -> bool:
    src = open(check_path, encoding='utf8').read()
    if 'CHECK_PYTHON' in src or re.search(r'spawn\w*\(\s*["\']python', src):
        return True
    local = [os.path.normpath(os.path.join(os.path.dirname(check_path), m))
             for m in re.findall(r'from\s+["\'](\.[^"\']+)["\']', src)]
    return any(runs_python(m, seen | {check_path}) for m in local if m not in seen)


def interpreter_units() -> frozenset:
    with open(PLAN, encoding='utf8') as plan:
        return frozenset(u['id'] for u in json.load(plan)['units'] if runs_python(u['lesson']['checkPath']))


def linked(path: str) -> bool:
    return os.path.islink(path) or os.path.isjunction(path)


def inside(path: str, base: str) -> bool:
    real, top = os.path.realpath(path), os.path.realpath(base)
    return real != top and os.path.commonpath([real, top]) == top


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
    return os.path.join(PC, pair[:8] + '-' + prep[-6:] + '-' + os.path.basename(slot))


def targets(slot: str, keep_venv: bool) -> list[str]:
    owned = [(os.path.join(slot, 'cache'), slot), (poetry_cache(slot), PC)]
    venv = os.path.join(slot, 'venv')
    if not keep_venv and os.path.isfile(os.path.join(venv, 'pyvenv.cfg')):
        owned.append((venv, slot))
    return [p for p, base in owned if os.path.isdir(p) and not linked(p) and inside(p, base)]


def refuse(path: str, reason: str) -> None:
    print(json.dumps({'refused': path, 'reason': reason}), flush=True)


def record(path: str) -> dict:
    if os.path.basename(path) == 'venv':
        freeze = subprocess.run([os.path.join(path, 'Scripts', 'python.exe'), '-m', 'pip', 'freeze', '--all'],
                                capture_output=True, text=True, check=True).stdout
        with open(path + '.freeze.txt', 'w', encoding='utf8') as out:
            out.write(freeze)
        return {'freeze': os.path.basename(path) + '.freeze.txt'}
    return {'parts': {name: round(size(os.path.join(path, name)) / 1e9, 3) for name in os.listdir(path)
                      if os.path.isdir(os.path.join(path, name))}}


def trim_once(keep: frozenset) -> float:
    freed = 0
    for name in sorted(os.listdir(TRIAL)):
        pair = os.path.join(TRIAL, name)
        if linked(pair) or not inside(pair, TRIAL):
            refuse(pair, 'linked pair')
            continue
        if not os.path.isfile(os.path.join(pair, 'result.json')):
            continue
        for slot in slots(pair):
            if linked(slot) or not inside(slot, pair):
                refuse(slot, 'slot outside its pair')
                continue
            for path in targets(slot, re.sub(r'-\d+$', '', name) in keep):
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
    keep = interpreter_units()
    print(json.dumps({'dry': DRY, 'keep_venv_units': sorted(keep)}), flush=True)
    while True:
        print(json.dumps({'dry': DRY, 'freed_gb': round(trim_once(keep), 2)}), flush=True)
        if not loop:
            break
        time.sleep(loop)
