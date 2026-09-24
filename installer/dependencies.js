'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI_VERSION = '1.0.95';
const RELEASE_BASE = `https://github.com/larksuite/cli/releases/download/v${CLI_VERSION}`;
const ARCHIVES = Object.freeze({
  arm64: { file: 'lark-cli-1.0.95-darwin-arm64.tar.gz', sha256: '7ae7241b7de5ebfe86aa6b2b24af3600bd5019ec5b6206ea3bfdc0894f6fd925' },
  x64: { file: 'lark-cli-1.0.95-darwin-amd64.tar.gz', sha256: 'b8b817e7ffe793c9be2579e0b3f9165610b01ca3d425a7b8ee6fb4d528dc6cef' },
});

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} failed: ${result.error && result.error.code || result.status}`);
  return result;
}
function verifyCli(binary, home) {
  const result = run(binary, ['--version'], { env: { ...process.env, HOME: home }, timeout: 15000 });
  if (!`${result.stdout}${result.stderr}`.includes(`lark-cli version ${CLI_VERSION}`)) throw new Error(`Expected official lark-cli ${CLI_VERSION}.`);
  return sha256(binary);
}
function installCli(root, home, { archiveFile, archiveSha256, architecture = process.arch } = {}) {
  const spec = ARCHIVES[architecture];
  if (!spec) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  const targetDir = path.join(root, 'runtime', 'lark-cli', CLI_VERSION);
  const target = path.join(targetDir, 'lark-cli');
  const manifest = path.join(targetDir, 'manifest.json');
  if (fs.existsSync(targetDir) && (!fs.existsSync(target) || !fs.existsSync(manifest))) throw new Error('Existing component-owned CLI directory is incomplete.');
  if (fs.existsSync(target) && fs.existsSync(manifest)) {
    const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (saved.version === CLI_VERSION && saved.architecture === architecture && saved.binary_sha256 === sha256(target)) {
      verifyCli(target, home);
      return { path: target, version: CLI_VERSION, binary_sha256: saved.binary_sha256, archive_sha256: saved.archive_sha256, reused: true };
    }
    throw new Error('Existing component-owned lark-cli failed integrity verification.');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cli-install-'));
  try {
    const archive = path.join(work, spec.file);
    if (archiveFile) {
      fs.copyFileSync(archiveFile, archive);
    } else {
      run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--connect-timeout', '20', '--max-time', '120', '--output', archive, `${RELEASE_BASE}/${spec.file}`]);
    }
    const expected = archiveSha256 || spec.sha256;
    if (archiveSha256 && process.env.LARK_MCP_TEST_MODE !== '1') throw new Error('Checksum override is test-only.');
    if (sha256(archive) !== expected) throw new Error('Official lark-cli archive SHA-256 mismatch.');
    const listing = run('/usr/bin/tar', ['-tzf', archive]).stdout.trim().split('\n');
    if (!listing.includes('lark-cli') || listing.some((name) => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('Invalid official lark-cli archive layout.');
    const unpack = path.join(work, 'unpack');
    fs.mkdirSync(unpack);
    run('/usr/bin/tar', ['-xzf', archive, '-C', unpack]);
    const binary = path.join(unpack, 'lark-cli');
    fs.chmodSync(binary, 0o700);
    const binaryHash = verifyCli(binary, home);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
    const stage = `${targetDir}.tmp-${process.pid}`;
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    fs.copyFileSync(binary, path.join(stage, 'lark-cli'));
    fs.chmodSync(path.join(stage, 'lark-cli'), 0o700);
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ version: CLI_VERSION, architecture, archive_sha256: expected, binary_sha256: binaryHash, source: `${RELEASE_BASE}/${spec.file}` }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(stage, targetDir);
    return { path: target, version: CLI_VERSION, binary_sha256: binaryHash, archive_sha256: expected, reused: false };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function installNodeDependencies(releaseDir, root) {
  const nodeBin = path.dirname(fs.realpathSync(process.execPath));
  const npmCli = path.join(nodeBin, 'npm');
  const executable = fs.existsSync(npmCli) ? npmCli : 'npm';
  fs.mkdirSync(path.join(root, 'runtime', 'npm-cache'), { recursive: true, mode: 0o700 });
  run(executable, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: releaseDir,
    env: { ...process.env, npm_config_cache: path.join(root, 'runtime', 'npm-cache'), PATH: `${nodeBin}:${process.env.PATH || '/usr/bin:/bin'}` },
    timeout: 180000,
  });
}

module.exports = { CLI_VERSION, ARCHIVES, sha256, run, verifyCli, installCli, installNodeDependencies };
