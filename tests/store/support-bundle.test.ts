/** `hippo support-bundle`: read-only, secret-free, one redacted JSON file. Real stores, canaries built at runtime. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { buildSupportBundle } from '../../src/support-bundle.js';
import { diagnosticsAt } from '../_helpers/cli-stores.js';
import {
  openHippoDb,
  openHippoDbReadOnly,
  closeHippoDb,
  getSchemaVersion,
  getCurrentSchemaVersion,
  setMeta,
} from '../../src/db/index.js';
import type { JsonValue, JsonObject } from '../../src/base/util/json.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.stubEnv('HIPPO_FAKE', undefined);
});

function tmp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isString(v: JsonValue): v is string {
  return typeof v === 'string';
}

/** How Claude Code names a project's folder under ~/.claude/projects. */
function claudeFolder(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

/** Every key and string in a bundle, lowercased. Raw JSON text doubles Windows backslashes, so a substring check on it proves nothing. */
function bundleText(bundle: JsonObject): string[] {
  const out: string[] = [];
  JSON.parse(JSON.stringify(bundle), (key: string, value: JsonValue) => {
    out.push(key.toLowerCase());
    if (isString(value)) out.push(value.toLowerCase());
    return value;
  });
  return out;
}

interface Seeded {
  home: string;
  cwd: string;
  hippoRoot: string;
  memoryCanary: string;
  pwCanary: string;
  qCanary: string;
  fCanary: string;
  keyCanary: string;
  authCanary: string;
  envCanary: string;
  ghpCanary: string;
  skCanary: string;
  bearerCanary: string;
  jwtCanary: string;
  pemCanary: string;
  hippoKeyCanary: string;
  basicCanary: string;
}

function seed(): Seeded {
  const home = tmp('hippo-bundle-home-');
  const cwd = join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const hippoRoot = join(cwd, '.hippo');
  initTestStore(hippoRoot);

  const memoryCanary = `canary-memory-${randomUUID()}`;
  writeEntry(hippoRoot, createMemory(memoryCanary));

  const pwCanary = `pw-${randomUUID()}`;
  const qCanary = `q-${randomUUID()}`;
  const fCanary = `f-${randomUUID()}`;
  const keyCanary = `k-${randomUUID()}`;
  const authCanary = `a-${randomUUID()}`;
  // hippo's own key shape under a key name that does not look secret, so only the value's shape can catch it.
  const hippoKeyCanary = 'hk_' + 'c'.repeat(24) + '.' + 'd'.repeat(32);
  writeFileSync(
    join(hippoRoot, 'config.json'),
    JSON.stringify({
      embeddings: {
        apiBaseUrl: `https://user:${pwCanary}@proxy.example.com/v1?key=${qCanary}#${fCanary}`,
        apiKey: keyCanary,
        authToken: authCanary,
        model: hippoKeyCanary,
      },
    }),
  );

  const logsDir = join(home, '.hippo', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const ghpCanary = 'ghp_' + 'A'.repeat(36);
  const skCanary = 'sk-' + randomUUID().replace(/-/g, '');
  const bearerCanary = 'Bearer ' + randomUUID().replace(/-/g, '');
  const jwtCanary = `eyJ${'A'.repeat(10)}.eyJ${'B'.repeat(10)}.${'C'.repeat(10)}`;
  const pemCanary = `MIIE${randomUUID().replace(/-/g, '')}`;
  const basicCanary = Buffer.from(`alice:${randomUUID()}`).toString('base64');
  writeFileSync(
    join(logsDir, 'last-sleep.log'),
    [
      `memory seen: ${memoryCanary}`,
      `token issued ${ghpCanary}`,
      `fetch failed: ${skCanary}`,
      `saw header ${bearerCanary}`,
      `Authorization: Basic ${basicCanary}`,
      `jwt ${jwtCanary}`,
      `home is ${home} now`,
      `saved to ${home}.`,
      `other user ${join(`${home}ty`, 'x')}`,
      `glued x${claudeFolder(home)}-proj`,
      '-----BEGIN RSA PRIVATE KEY-----',
      pemCanary,
      '-----END RSA PRIVATE KEY-----',
      '',
    ].join('\n'),
  );

  vi.stubEnv('HIPPO_HOME', join(home, 'unused-global'));
  const envCanary = `env-${randomUUID()}`;
  vi.stubEnv('HIPPO_FAKE', envCanary);

  return {
    home,
    cwd,
    hippoRoot,
    memoryCanary,
    pwCanary,
    qCanary,
    fCanary,
    keyCanary,
    authCanary,
    envCanary,
    ghpCanary,
    skCanary,
    bearerCanary,
    jwtCanary,
    pemCanary,
    hippoKeyCanary,
    basicCanary,
  };
}

describe('buildSupportBundle', () => {
  it('the default bundle redacts every canary, home form and secret, and keeps what it should', () => {
    const s = seed();
    const bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd: s.cwd,
      home: s.home,
      version: 'test',
      includeLogs: false,
      now: new Date(),
    });
    const text = bundleText(bundle);

    // On Windows the unresolved tmpdir form can be an 8.3 short name (ABCDEF~1), which no home form covers.
    const homes = [s.home, join(tmpdir(), basename(s.home)), homedir()];
    const forbidden = [
      s.memoryCanary,
      s.pwCanary,
      s.qCanary,
      s.fCanary,
      s.keyCanary,
      s.authCanary,
      s.envCanary,
      s.hippoKeyCanary,
      ...homes,
      ...homes.map((h) => h.replace(/\\/g, '/')),
    ];
    for (const f of forbidden) {
      expect(
        text.filter((t) => t.includes(f.toLowerCase())),
        f,
      ).toEqual([]);
    }

    const json = JSON.stringify(bundle, null, 2);
    expect(json).toContain('https://proxy.example.com/v1');
    expect(json).toContain('"memories": 1');
    expect(json).toContain('last-sleep.log');
    expect(json).toContain('HIPPO_FAKE');

    const parsed = JSON.parse(json);
    expect(parsed.stores).toHaveLength(1);
    expect(parsed.stores[0].schemaVersion).toBe(getCurrentSchemaVersion());
    expect(parsed.stores[0].path.startsWith('~')).toBe(true);
    expect(Array.isArray(parsed.doctor.checks)).toBe(true);
    // codex joins only where CODEX_HOME names a folder on this machine; no global store, so no projects check.
    expect(parsed.doctor.checks.map((c: { id: string }) => c.id).filter((id: string) => id !== 'codex')).toEqual([
      'node',
      'store',
      'schema',
      'memories',
      'fts',
      'tokens',
      'failures',
      'sleep',
      'compactions',
      'claude-code',
      'embeddings',
    ]);
    expect(parsed.logs.tails).toBeUndefined();
  });

  it('swaps a short-name or symlinked form of the home that HIPPO_HOME passes through unresolved', () => {
    const s = seed();
    // tmpdir() is often an 8.3 short form on Windows and a symlink on macOS; elsewhere this is the plain path.
    const aliasHome = join(tmpdir(), basename(s.home));
    const aliasGlobal = join(aliasHome, 'global');
    vi.stubEnv('HIPPO_HOME', aliasGlobal);
    initTestStore(aliasGlobal);
    const bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd: s.cwd,
      home: s.home,
      version: 'test',
      includeLogs: false,
      now: new Date(),
    });
    expect(
      bundleText(bundle).filter((t) => t.includes(aliasHome.toLowerCase())),
      aliasHome,
    ).toEqual([]);
    // Exact, so a swap of only the user's own home (~\AppData\...\global) does not pass for this one.
    const globalStore = JSON.parse(JSON.stringify(bundle)).stores.find((st: { kind: string }) => st.kind === 'global');
    expect(globalStore.path).toBe(join('~', 'global'));
  });

  it('swaps a home alias that a log line quotes through the temp folder', () => {
    const s = seed();
    const aliasHome = join(tmpdir(), basename(s.home));
    mkdirSync(join(s.home, 'tmp'));
    writeFileSync(join(s.home, '.hippo', 'logs', 'alias.log'), `wrote ${join(aliasHome, 'tmp', 'scratch.txt')}\n`);
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    // os.tmpdir() reads these on every call, so the bundle sees a temp folder under the home's alias.
    for (const k of Object.keys(saved)) vi.stubEnv(k, join(aliasHome, 'tmp'));
    let bundle: JsonObject;
    bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd: s.cwd,
      home: s.home,
      version: 'test',
      includeLogs: true,
      now: new Date(),
    });
    expect(JSON.parse(JSON.stringify(bundle)).logs.tails['alias.log']).toEqual([
      `wrote ${join('~', 'tmp', 'scratch.txt')}`,
    ]);
  });

  it('swaps the home in every spelling a log line uses: JSON-escaped, file URL, Claude Code folder name', () => {
    // A space and an accented letter, so the file URL spelling differs from the path.
    const home = join(tmp('hippo-bundle-home-'), 'José Q');
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, '.hippo', 'logs'), { recursive: true });
    vi.stubEnv('HIPPO_HOME', join(home, 'unused-global'));
    writeFileSync(
      join(home, '.hippo', 'logs', 'hook.log'),
      [
        `payload ${JSON.stringify({ cwd })}`,
        `at ${pathToFileURL(join(cwd, 'x.js')).href}:1:2`,
        `transcript ${join(home, '.claude', 'projects', claudeFolder(cwd), 'abc.jsonl')}`,
        '',
      ].join('\n'),
    );

    const bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd,
      home,
      version: 'test',
      includeLogs: true,
      now: new Date(),
    });
    const tail = JSON.parse(JSON.stringify(bundle)).logs.tails['hook.log'];
    expect(tail[0]).toBe(`payload ${JSON.stringify({ cwd: join('~', 'proj') })}`);
    expect(tail[1]).toMatch(/^at file:\/\/\/?~\/proj\/x\.js:1:2$/);
    expect(tail[2]).toBe(`transcript ${join('~', '.claude', 'projects', '~-proj', 'abc.jsonl')}`);
    for (const leaf of ['josé q', 'jos%c3%a9%20q', 'jos--q']) {
      expect(
        bundleText(bundle).filter((t) => t.includes(leaf)),
        leaf,
      ).toEqual([]);
    }
  });

  it('includeLogs adds tails with known secret shapes gone; memory text in a log is not (documented opt-in)', () => {
    const s = seed();
    const bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd: s.cwd,
      home: s.home,
      version: 'test',
      includeLogs: true,
      now: new Date(),
    });
    const parsed = JSON.parse(JSON.stringify(bundle));
    // SAFETY: buildLogsSection always fills tails[name] with the string[] lines returned by tailLogFile.
    const tail = (parsed.logs.tails['last-sleep.log'] as string[]).join('\n');

    expect(tail).not.toContain(s.ghpCanary);
    expect(tail).not.toContain(s.skCanary);
    expect(tail).not.toContain(s.bearerCanary);
    expect(tail).not.toContain(s.jwtCanary);
    expect(tail).not.toContain(s.pemCanary);
    expect(tail).not.toContain(s.basicCanary);
    expect(tail).not.toContain('-----END RSA PRIVATE KEY-----');
    expect(tail).toContain('[REDACTED]');
    expect(tail).toContain(s.memoryCanary);

    expect(tail).toContain('home is ~ now');
    expect(tail).toContain('saved to ~.');
    expect(tail).toContain(`${basename(s.home)}ty`);
    expect(tail).not.toContain('~ty');
    // A name that only ends in the home's folder name is another name, except on Windows, where the path below the drive names the user.
    expect(tail).toContain(process.platform === 'win32' ? 'glued x~-proj' : `glued x${claudeFolder(s.home)}-proj`);
  });

  it.skipIf(process.platform !== 'win32')(
    'swaps a Windows home however a shell mounts its drive, short name included',
    () => {
      const s = seed();
      // tmpdir() is usually the 8.3 short form; HIPPO_HOME under it makes the bundle find that alias of the home.
      const shortHome = join(tmpdir(), basename(s.home));
      vi.stubEnv('HIPPO_HOME', join(shortHome, 'unused-global'));
      // Git Bash writes C:\x as /c/x; Cygwin and WSL put the same path under /cygdrive and /mnt.
      const mount = (root: string, p: string): string =>
        `${root}/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`;
      writeFileSync(
        join(s.home, '.hippo', 'logs', 'shell.log'),
        [
          `cd ${mount('', s.cwd)} && npm test`,
          `ls ${mount('/cygdrive', s.cwd)}`,
          `ls ${mount('/mnt', s.cwd)}`,
          `ls ${mount('', join(shortHome, 'proj'))}`,
          `ls ${mount('/run/desktop/mnt/host', s.cwd)}`,
          `ls \\\\localhost\\${s.cwd[0]}$${s.cwd.slice(2)}`,
          `ls ${claudeFolder(mount('/mnt', s.cwd))}`,
          '',
        ].join('\n'),
      );

      const bundle = buildSupportBundle({
        diagnosticsAt,
        tenantId: 'default',
        cwd: s.cwd,
        home: s.home,
        version: 'test',
        includeLogs: true,
        now: new Date(),
      });
      const tail: string[] = JSON.parse(JSON.stringify(bundle)).logs.tails['shell.log'];
      expect(tail.slice(0, 4)).toEqual(['cd ~/proj && npm test', 'ls ~/proj', 'ls ~/proj', 'ls ~/proj']);
      // A mount or share no list names keeps its prefix, but the path that names the user still goes.
      for (const leaf of [basename(s.home), basename(homedir())].map((n) => n.toLowerCase())) {
        expect(
          tail.filter((t) => t.toLowerCase().includes(leaf) || t.toLowerCase().includes(claudeFolder(leaf))),
          leaf,
        ).toEqual([]);
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'swaps a one-folder Windows home only after its drive, and a drive root never',
    () => {
      const s = seed();
      // A custom HOME of Q:\x or Q:\home names a folder any path may hold, however long; the home need not exist to be swapped.
      const lines = (n: string): string[] => [
        `Q:\\${n}\\proj`,
        `q:/${n}/proj`,
        `Q:\\\\${n}\\\\proj`,
        `/q/${n}/proj`,
        `/cygdrive/q/${n}/proj`,
        `/mnt/q/${n}/proj`,
        `Q--${n}-proj`,
        `/${n}/proj`,
        `/usr/${n}/proj`,
        `C:\\${n}\\proj`,
        `Q:\\${n}y\\proj`,
        `foo-q-${n}-proj`,
      ];
      const swapped = (home: string, input: string[]): string[] => {
        writeFileSync(join(s.hippoRoot, 'config.json'), JSON.stringify({ gitLearnPatterns: input }));
        const bundle = buildSupportBundle({
          diagnosticsAt,
          tenantId: 'default',
          cwd: s.cwd,
          home,
          version: 'test',
          includeLogs: false,
          now: new Date(),
        });
        return JSON.parse(JSON.stringify(bundle)).stores[0].config.gitLearnPatterns;
      };
      for (const n of ['x', 'home']) {
        expect(swapped(`Q:\\${n}`, lines(n)), n).toEqual([
          '~\\proj',
          '~/proj',
          '~\\\\proj',
          '~/proj',
          '~/proj',
          '~/proj',
          '~-proj',
          ...lines(n).slice(7),
        ]);
      }
      expect(swapped('\\home', ['\\home\\proj', '/usr/home/proj'])).toEqual(['~\\proj', '/usr/home/proj']);
      expect(swapped('Q:\\', lines('x'))).toEqual(lines('x'));
    },
  );

  it('a log tail that starts inside a private key drops the rest of the key', () => {
    const s = seed();
    // About 325 KB of key body, so the 256 KiB tail window starts after the BEGIN line.
    const bodyLine = `MIIE${'Q'.repeat(60)}`;
    writeFileSync(
      join(s.home, '.hippo', 'logs', 'big.log'),
      `-----BEGIN RSA PRIVATE KEY-----\n${`${bodyLine}\n`.repeat(5000)}-----END RSA PRIVATE KEY-----\nafter the key\n`,
    );
    const parsed = JSON.parse(
      JSON.stringify(
        buildSupportBundle({
          diagnosticsAt,
          tenantId: 'default',
          cwd: s.cwd,
          home: s.home,
          version: 'test',
          includeLogs: true,
          now: new Date(),
        }),
      ),
    );
    // SAFETY: buildLogsSection always fills tails[name] with the string[] lines returned by tailLogFile.
    const tail = (parsed.logs.tails['big.log'] as string[]).join('\n');

    expect(tail).not.toContain(bodyLine);
    expect(tail).not.toContain('-----END');
    expect(tail).toContain('after the key');
  });

  it('never writes to the store: hippo.db bytes and an older schema_version are unchanged', () => {
    const s = seed();
    const db = openHippoDb(s.hippoRoot);
    setMeta(db, 'schema_version', '45');
    closeHippoDb(db);

    const before = sha256(join(s.hippoRoot, 'hippo.db'));
    buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd: s.cwd,
      home: s.home,
      version: 'test',
      includeLogs: false,
      now: new Date(),
    });
    expect(sha256(join(s.hippoRoot, 'hippo.db'))).toBe(before);

    const check = openHippoDbReadOnly(s.hippoRoot);
    expect(getSchemaVersion(check)).toBe(45);
    closeHippoDb(check);
  });

  it('lists the store files as they were: its own doctor check does not add an empty -wal', () => {
    const s = seed();
    expect(existsSync(join(s.hippoRoot, 'hippo.db-wal'))).toBe(false);
    const parsed = JSON.parse(
      JSON.stringify(
        buildSupportBundle({
          diagnosticsAt,
          tenantId: 'default',
          cwd: s.cwd,
          home: s.home,
          version: 'test',
          includeLogs: false,
          now: new Date(),
        }),
      ),
    );
    expect(Object.keys(parsed.stores[0].files)).toEqual(['hippo.db']);
  });

  it('a bare cwd has no stores; a bare .hippo is one error entry', () => {
    const home = tmp('hippo-bundle-empty-home-');
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HIPPO_HOME', join(home, 'unused-global'));

    const bundle = buildSupportBundle({
      diagnosticsAt,
      tenantId: 'default',
      cwd,
      home,
      version: 'test',
      includeLogs: false,
      now: new Date(),
    });
    const parsed = JSON.parse(JSON.stringify(bundle));
    expect(parsed.stores).toEqual([]);
    expect(parsed.doctor.checks.find((c: { id: string }) => c.id === 'store').status).toBe('fail');

    mkdirSync(join(cwd, '.hippo'));
    const bare = JSON.parse(
      JSON.stringify(
        buildSupportBundle({
          diagnosticsAt,
          tenantId: 'default',
          cwd,
          home,
          version: 'test',
          includeLogs: false,
          now: new Date(),
        }),
      ),
    );
    expect(bare.stores).toHaveLength(1);
    expect(bare.stores[0].error).toMatch(/no hippo\.db here/);
  });

  it('a hippo.db that is not a database is one error entry with the open error', () => {
    const home = tmp('hippo-bundle-notdb-home-');
    const cwd = join(home, 'proj');
    mkdirSync(join(cwd, '.hippo'), { recursive: true });
    writeFileSync(join(cwd, '.hippo', 'hippo.db'), 'this file is not a database. '.repeat(400));
    vi.stubEnv('HIPPO_HOME', join(home, 'unused-global'));

    const parsed = JSON.parse(
      JSON.stringify(
        buildSupportBundle({
          diagnosticsAt,
          tenantId: 'default',
          cwd,
          home,
          version: 'test',
          includeLogs: false,
          now: new Date(),
        }),
      ),
    );
    expect(parsed.stores).toEqual([
      { kind: 'project', path: expect.stringMatching(/\.hippo$/), error: 'file is not a database' },
    ]);
  });
});

describe('hippo support-bundle (CLI)', () => {
  it('writes once, refuses to overwrite, and rejects a bare --out', async () => {
    const home = tmp('hippo-bundle-cli-');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HIPPO_HOME: join(home, 'global'),
      HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    };
    const hippo = (...args: string[]) => runCliAs(args, { cwd: home, env });
    expect((await hippo('init', '--no-hooks', '--no-schedule', '--no-learn')).status).toBe(0);

    const target = join(home, 'x.json');
    expect((await hippo('support-bundle', '--out', target)).status).toBe(0);
    const first = readFileSync(target, 'utf8');
    expect(() => JSON.parse(first)).not.toThrow();

    expect((await hippo('support-bundle', '--out', target)).status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(first);

    expect((await hippo('support-bundle', '--out')).status).toBe(1);
  });
});
