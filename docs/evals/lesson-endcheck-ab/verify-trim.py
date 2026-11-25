import _winapi
import importlib.util
import json
import os
import tempfile

spec = importlib.util.spec_from_file_location('trim', os.path.join(os.path.dirname(__file__), 'trim.py'))
trim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trim)
Q256 = '1cbe9628-edd5-47b4-9e29-0c6b4e929cc6'


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


def intact(base: str) -> bool:
    return all(os.path.isfile(os.path.join(base, *p)) for p in (('cache', 'pip', 'wheel.bin'), ('venv', 'pyvenv.cfg')))


def main() -> None:
    real_plan = trim.interpreter_units()
    assert real_plan == frozenset({Q256}), real_plan
    with open(trim.PLAN, encoding='utf8') as plan:
        enrolled = [u for u in json.load(plan)['units'] if u['id'] == Q256]
    assert len(enrolled) == 1 and enrolled[0]['lesson']['checkPath'].endswith('q256-f5-l1.mjs'), enrolled
    with tempfile.TemporaryDirectory() as tmp:
        trial, outside = os.path.join(tmp, 'trial'), os.path.join(tmp, 'outside')
        trim.ROOT, trim.TRIAL, trim.PC, trim.JOURNAL = tmp, trial, os.path.join(tmp, 'pc'), os.path.join(tmp, 'trim.jsonl')
        trim.DRY = False
        trim.record = lambda path: {'fixture': True}
        closed, kept, open_pair, marked = (os.path.join(trial, n) for n in
                                           ('aaaaaaaa-1', Q256 + '-1', 'oooooooo-1', 'mmmmmmmm-1'))
        a1, k1, o1, m1 = (slot(closed, 'prep-AAAAAA'), slot(kept, 'prep-KKKKKK'), slot(open_pair, 'prep-OOOOOO'),
                          slot(marked, 'prep-MMMMMM'))
        for pair in (closed, kept, marked):
            put(os.path.join(pair, 'result.json'), '{}')
        poetry = trim.poetry_cache(a1)
        put(os.path.join(poetry, 'artifacts', 'w.whl'))
        put(os.path.join(outside, 'result.json'), '{}')
        foreign, foreign_slot = slot(outside, 'prep-XXXXXX'), slot(outside, 'prep-YYYYYY')
        _winapi.CreateJunction(outside, os.path.join(trial, 'llllllll-1'))
        linked_cache = os.path.join(closed, 'prep-AAAAAA', 's2')
        put(os.path.join(linked_cache, 'work', 'a.txt'))
        _winapi.CreateJunction(os.path.join(foreign, 'cache'), os.path.join(linked_cache, 'cache'))
        linked_slot = os.path.join(closed, 'prep-AAAAAA', 's3')
        _winapi.CreateJunction(foreign_slot, linked_slot)
        plain = trim.linked
        trim.linked = lambda p: os.path.normcase(p) == os.path.normcase(os.path.join(marked, 'result.json')) or plain(p)
        trim.trim_once(real_plan)
        trim.linked = plain
        gone = lambda p: not os.path.exists(p)
        assert gone(os.path.join(a1, 'cache')) and gone(os.path.join(a1, 'venv')) and gone(poetry)
        assert gone(os.path.join(k1, 'cache')) and os.path.isfile(os.path.join(k1, 'venv', 'pyvenv.cfg'))
        assert intact(o1) and intact(m1) and intact(foreign) and intact(foreign_slot)
        rows = [json.loads(line) for line in open(trim.JOURNAL, encoding='utf8')]
        assert sorted(r['path'] for r in rows) == sorted(['aaaaaaaa-1/prep-AAAAAA/s1/cache', 'aaaaaaaa-1/prep-AAAAAA/s1/venv',
                                                          Q256 + '-1/prep-KKKKKK/s1/cache', '../pc/aaaaaaaa-AAAAAA-s1']), rows
        for link in (os.path.join(linked_cache, 'cache'), linked_slot, os.path.join(trial, 'llllllll-1')):
            os.unlink(link)

        def untouched(**roots: str) -> None:
            fresh = os.path.join(tmp, 'fresh')
            os.makedirs(os.path.join(fresh, 'trial'), exist_ok=True)
            os.makedirs(os.path.join(fresh, 'pc'), exist_ok=True)
            trim.ROOT, trim.TRIAL, trim.PC = fresh, os.path.join(fresh, 'trial'), os.path.join(fresh, 'pc')
            for name, target in roots.items():
                setattr(trim, name, target)
            pair = os.path.join(trim.TRIAL, 'ffffffff-1')
            base = slot(pair, 'prep-FFFFFF')
            put(os.path.join(pair, 'result.json'), '{}')
            pc = trim.poetry_cache(base)
            put(os.path.join(pc, 'artifacts', 'w.whl'))
            freed = trim.trim_once(frozenset())
            assert freed == 0 and intact(base) and os.path.isfile(os.path.join(pc, 'artifacts', 'w.whl')), roots

        elsewhere = os.path.join(tmp, 'elsewhere')
        os.makedirs(os.path.join(elsewhere, 'trial'))
        os.makedirs(os.path.join(elsewhere, 'pc'))
        untouched(TRIAL=os.path.join(elsewhere, 'trial'))
        untouched(PC=os.path.join(elsewhere, 'pc'))
        for name in ('TRIAL', 'PC'):
            link = os.path.join(tmp, 'link-' + name)
            _winapi.CreateJunction(os.path.join(tmp, 'fresh', name.lower()), link)
            untouched(**{name: link})
            os.unlink(link)
    print('Passed trim selection from the enrolled q256-f5 unit, kept checker venv, open pair, linked pair, slot, cache, '
          'completion marker and root refusals.')


if __name__ == '__main__':
    main()
