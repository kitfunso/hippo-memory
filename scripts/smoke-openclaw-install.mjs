import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-openclaw-smoke-'));
const stateDir = path.join(scratchRoot, 'state');
const configPath = path.join(stateDir, 'openclaw.json');

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(configPath, '{}\n', 'utf8');

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function run(command, cwd, envOverrides = {}) {
  console.log(`> ${command}`);
  return execSync(command, {
    cwd,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      ...envOverrides,
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commandExists(command) {
  try {
    const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
    execSync(probe, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

let tarballPath = null;

try {
  if (!commandExists('openclaw')) {
    console.log('OpenClaw CLI not found; skipping OpenClaw install smoke test.');
    process.exit(0);
  }

  run('npm run build', repoRoot, process.env);

  const packOutput = execSync('npm pack --json', {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult?.[0]?.filename;
  if (!tarballName) {
    throw new Error(`Could not parse npm pack output: ${packOutput}`);
  }
  tarballPath = path.join(repoRoot, tarballName);

  run(`openclaw plugins install ${quote(tarballPath)}`, repoRoot);

  const listOutput = run('openclaw plugins list', repoRoot);
  if (!/hippo-memory/i.test(listOutput)) {
    throw new Error(`Expected installed plugin to appear in openclaw plugins list, got:\n${listOutput}`);
  }

  const installDir = path.join(stateDir, 'extensions', 'hippo-memory');
  const rootManifestPath = path.join(installDir, 'openclaw.plugin.json');
  const rootPackagePath = path.join(installDir, 'package.json');
  const runtimeEntryPath = path.join(installDir, 'extensions', 'openclaw-plugin', 'index.ts');

  if (!fs.existsSync(rootManifestPath)) {
    throw new Error(`Expected installed plugin manifest at ${rootManifestPath}`);
  }
  if (!fs.existsSync(rootPackagePath)) {
    throw new Error(`Expected installed plugin package.json at ${rootPackagePath}`);
  }
  if (!fs.existsSync(runtimeEntryPath)) {
    throw new Error(`Expected installed plugin runtime entry at ${runtimeEntryPath}`);
  }

  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  if (!Array.isArray(rootPackage.openclaw?.extensions) || !rootPackage.openclaw.extensions.includes('./extensions/openclaw-plugin/index.ts')) {
    throw new Error(`Expected installed package.json to include openclaw.extensions, got:\n${JSON.stringify(rootPackage.openclaw)}`);
  }
  if (rootManifest.id !== 'hippo-memory') {
    throw new Error(`Expected installed root plugin manifest id to be hippo-memory, got: ${rootManifest.id}`);
  }

  console.log('OpenClaw npm install smoke test passed.');
} finally {
  if (tarballPath && fs.existsSync(tarballPath)) {
    fs.rmSync(tarballPath, { force: true });
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
