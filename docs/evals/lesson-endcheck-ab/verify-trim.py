import _winapi
import importlib.util
import json
import os
import tempfile

spec = importlib.util.spec_from_file_location('trim', os.path.join(os.path.dirname(__file__), 'trim.py'))
trim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trim)


def put(path: str, text: str = 'x') -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf8') as out:
        out.write(text)


def slot(pair: str, prep: str, name: str = 's1') -> str:
    base = os.path.join(pair, prep, name)
    put(os.path.join(base, 'cache', 'pip', 'wheel.bin'))
    put(os.path.join(base, 'venv', 'pyvenv.cfg'))
    put(os.path.join(base, 'work', 'a.txt'))
    return base


def main() -> None:
    real_plan = trim.interpreter_units()
    assert len(real_plan) == 1, real_plan
    with tempfile.TemporaryDirectory() as tmp:
        trial, outside = os.path.join(tmp, 'trial'), os.path.join(tmp, 'outside')
        trim.ROOT, trim.TRIAL, trim.PC, trim.JOURNAL = tmp, trial, os.path.join(tmp, 'pc'), os.path.join(tmp, 'trim.jsonl')
        trim.DRY = False
        trim.record = lambda path: {'fixture': True}
        closed, kept, open_pair = (os.path.join(trial, n) for n in ('aaaaaaaa-1', 'kkkkkkkk-1', 'oooooooo-1'))
        a1, k1, o1 = slot(closed, 'prep-AAAAAA'), slot(kept, 'prep-KKKKKK'), slot(open_pair, 'prep-OOOOOO')
        for pair in (closed, kept):
            put(os.path.join(pair, 'result.json'), '{}')
        poetry = trim.poetry_cache(a1)
        put(os.path.join(poetry, 'artifacts', 'w.whl'))
        put(os.path.join(outside, 'result.json'), '{}')
        foreign = slot(outside, 'prep-XXXXXX')
        _winapi.CreateJunction(outside, os.path.join(trial, 'llllllll-1'))
        linked_slot = os.path.join(closed, 'prep-AAAAAA', 's2')
        put(os.path.join(linked_slot, 'work', 'a.txt'))
        _winapi.CreateJunction(os.path.join(foreign, 'cache'), os.path.join(linked_slot, 'cache'))
        trim.trim_once(frozenset({'kkkkkkkk'}))
        gone = lambda p: not os.path.exists(p)
        assert gone(os.path.join(a1, 'cache')) and gone(os.path.join(a1, 'venv')) and gone(poetry)
        assert gone(os.path.join(k1, 'cache')) and os.path.isfile(os.path.join(k1, 'venv', 'pyvenv.cfg'))
        assert os.path.isdir(os.path.join(o1, 'cache')) and os.path.isdir(os.path.join(o1, 'venv'))
        assert os.path.isfile(os.path.join(foreign, 'cache', 'pip', 'wheel.bin'))
        assert os.path.isfile(os.path.join(foreign, 'venv', 'pyvenv.cfg'))
        rows = [json.loads(line) for line in open(trim.JOURNAL, encoding='utf8')]
        assert sorted(r['path'] for r in rows) == sorted(['aaaaaaaa-1/prep-AAAAAA/s1/cache', 'aaaaaaaa-1/prep-AAAAAA/s1/venv',
                                                          'kkkkkkkk-1/prep-KKKKKK/s1/cache', '../pc/aaaaaaaa-AAAAAA-s1']), rows
        os.unlink(os.path.join(linked_slot, 'cache'))
        os.unlink(os.path.join(trial, 'llllllll-1'))
    print('Passed trim selection, kept checker venv, open pair, linked pair and linked cache refusals.')


if __name__ == '__main__':
    main()
