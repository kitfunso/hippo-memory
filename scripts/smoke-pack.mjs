import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pack-smoke-'));
const installDir = path.join(scratchRoot, 'install');
const workspaceDir = path.join(scratchRoot, 'workspace');

fs.mkdirSync(installDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function run(command, cwd) {
  console.log(`> ${command}`);
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

let tarballPath = null;

try {
  run('npm run build', repoRoot);

  const packOutput = run('npm pack --json', repoRoot);
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult?.[0]?.filename;
  if (!tarballName) {
    throw new Error(`Could not parse npm pack output: ${packOutput}`);
  }

  tarballPath = path.join(repoRoot, tarballName);

  run('npm init -y', installDir);
  run(`npm install ${quote(tarballPath)}`, installDir);

  const hippoBin = process.platform === 'win32'
    ? path.join(installDir, 'node_modules', '.bin', 'hippo.cmd')
    : path.join(installDir, 'node_modules', '.bin', 'hippo');

  const initOutput = run(`${quote(hippoBin)} init --no-schedule --no-hooks`, workspaceDir);
  if (!/Initialized Hippo/i.test(initOutput)) {
    throw new Error(`Pack smoke test expected init confirmation, got:\n${initOutput}`);
  }

  const statusOutput = run(`${quote(hippoBin)} status`, workspaceDir);
  if (!/Hippo Status/i.test(statusOutput)) {
    throw new Error(`Pack smoke test expected status output, got:\n${statusOutput}`);
  }

  const rememberOutput = run(`${quote(hippoBin)} remember "pack smoke memory" --tag smoke`, workspaceDir);
  const idMatch = rememberOutput.match(/\[(mem_[^\]]+)\]/);
  if (!idMatch) {
    throw new Error(`Could not extract memory id from remember output:\n${rememberOutput}`);
  }
  const memoryId = idMatch[1];

  const recallOutput = run(`${quote(hippoBin)} recall "pack smoke memory"`, workspaceDir);
  if (!recallOutput.toLowerCase().includes('pack smoke memory')) {
    throw new Error(`Pack smoke test expected recall output to include stored memory, got:\n${recallOutput}`);
  }

  const outcomeOutput = run(`${quote(hippoBin)} outcome --good`, workspaceDir);
  if (!/Applied positive outcome/i.test(outcomeOutput)) {
    throw new Error(`Pack smoke test expected outcome confirmation, got:\n${outcomeOutput}`);
  }

  const inspectOutput = run(`${quote(hippoBin)} inspect ${memoryId}`, workspaceDir);
  if (!inspectOutput.includes(memoryId)) {
    throw new Error(`Pack smoke test expected inspect output for ${memoryId}, got:\n${inspectOutput}`);
  }

  const forgetOutput = run(`${quote(hippoBin)} forget ${memoryId}`, workspaceDir);
  if (!/Forgot /i.test(forgetOutput)) {
    throw new Error(`Pack smoke test expected forget confirmation, got:\n${forgetOutput}`);
  }

  console.log('Pack smoke test passed.');
} finally {
  if (tarballPath && fs.existsSync(tarballPath)) {
    fs.rmSync(tarballPath, { force: true });
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
