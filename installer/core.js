'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CLI_VERSION, installCli, installNodeDependencies, verifyCli, sha256, run } = require('./dependencies.js');
const { atomicWrite, configPath, endpoint, patchClient, restorePatch } = require('./client-config.js');

const LABEL = 'com.openai.lark-mcp-shared';
const COMPONENT = 'lark-mcp-shared';
const VERSION = require('../package.json').version;
const BUNDLE = ['server.js', 'user-semantic-tools.js', 'shared-lark-cli-user.js', 'capabilities', 'semantic', 'policy', 'verification', 'package.json', 'package-lock.json'];

function digestBundle(source) {
  const rows = [];
  for (const name of BUNDLE) {
    const entry = path.join(source, name);
    if (!fs.existsSync(entry)) throw new Error(`Missing source bundle item: ${name}`);
    const files = fs.statSync(entry).isDirectory() ? walk(entry) : [entry];
    for (const file of files) rows.push(`${path.relative(source, file)} ${sha256(file)}`);
  }
  return crypto.createHash('sha256').update(rows.sort().join('\n')).digest('hex');
}
function walk(dir) {
  return fs.readdirSync(dir).sort().flatMap((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Source bundle symlinks are forbidden.');
    return stat.isDirectory() ? walk(file) : [file];
  });
}
function nodePreflight({ platform = process.platform, version = process.versions.node } = {}) {
  if (platform !== 'darwin') throw new Error('This component supports macOS only.');
  if (Number(version.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  return fs.realpathSync(process.execPath);
}
function xml(value) { return String(value).replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]); }
function plist({ node, server, cli, home, port }) {
  const logDir = path.join(home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(server)}</string></array>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>LARK_CLI_PATH</key><string>${xml(cli)}</string><key>LARK_MCP_SHARED_PORT</key><string>${port}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(logDir, 'stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(logDir, 'stderr.log'))}</string>\n</dict></plist>\n`;
}
function defaultServiceController(testMode) {
  if (testMode) return { async reload() {}, async stop() {}, status: () => ({ registered: false, test_mode: true }) };
  const target = `gui/${process.getuid()}`;
  const listed = () => spawnSync('/bin/launchctl', ['print', `${target}/${LABEL}`], { encoding: 'utf8', timeout: 10000 }).status === 0;
  return {
    async reload(agent) {
      if (listed()) run('/bin/launchctl', ['bootout', target, agent], { timeout: 15000 });
      run('/bin/launchctl', ['bootstrap', target, agent], { timeout: 15000 });
    },
    async stop(agent) { if (listed()) run('/bin/launchctl', ['bootout', target, agent], { timeout: 15000 }); },
    status: () => ({ registered: listed() }),
  };
}
function httpHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ ok: false }); } });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({ ok: false }));
  });
}
async function waitHealth(port, testMode) {
  if (testMode) return { ok: true, test_mode: true };
  for (let i = 0; i < 20; i += 1) {
    const health = await httpHealth(port);
    if (health.ok && health.service === COMPONENT && health.runtime_version === VERSION) return health;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Service did not become healthy after activation.');
}
function readState(root) {
  const file = path.join(root, 'state', 'state.json');
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.component !== COMPONENT) throw new Error('Component state identity mismatch.');
  return state;
}
function symlinkValue(file) { return fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false }) ? fs.readlinkSync(file) : null; }
function replaceSymlink(file, value) {
  if (value === null) { fs.rmSync(file, { force: true }); return; }
  const temp = `${file}.tmp-${process.pid}`;
  fs.rmSync(temp, { force: true });
  fs.symlinkSync(value, temp);
  fs.renameSync(temp, file);
}
function releaseIdFromLink(link) { return link ? path.basename(link) : null; }
function copyBundle(source, stage) {
  for (const name of BUNDLE) fs.cpSync(path.join(source, name), path.join(stage, name), { recursive: true, dereference: false });
}
function validateRelease(releaseDir, node) {
  run(node, ['--check', path.join(releaseDir, 'server.js')], { timeout: 15000 });
  run(node, ['-e', `const s=require(${JSON.stringify(path.join(releaseDir, 'server.js'))});const x=s.createSemanticServer({});if(x.names.length!==48)process.exit(2);Promise.resolve(x.server.close()).catch(()=>process.exit(3));`], { cwd: releaseDir, timeout: 15000 });
}
function clientBindings(home, port) {
  const out = {};
  for (const client of ['cursor', 'codex']) {
    const file = configPath(home, client);
    if (!fs.existsSync(file)) { out[client] = false; continue; }
    const text = fs.readFileSync(file, 'utf8');
    if (client === 'cursor') {
      try { out[client] = JSON.parse(text).mcpServers?.[COMPONENT]?.url === endpoint(port, client); } catch { out[client] = false; }
    } else out[client] = text.includes(`[mcp_servers."${COMPONENT}"]`) && text.includes(`url = "${endpoint(port, client)}"`);
  }
  return out;
}

function createManager(options = {}) {
  const home = options.home || os.homedir();
  const testMode = Boolean(options.testMode);
  if (testMode && path.resolve(home) === path.resolve(os.userInfo().homedir)) throw new Error('Test mode requires an isolated HOME.');
  const root = options.root || path.join(home, 'Library', 'Application Support', 'Lark-MCP-Shared');
  const source = options.source || path.resolve(__dirname, '..');
  const port = options.port || 33332;
  if (testMode && port === 33332) throw new Error('Test mode must use a non-Production port.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const agent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const controller = options.serviceController || defaultServiceController(testMode);
  const acquireCli = options.acquireCli || ((rootDir) => installCli(rootDir, home));
  const installDeps = options.installDependencies || ((stage) => installNodeDependencies(stage, root));
  const health = options.healthCheck || (() => waitHealth(port, testMode));
  const node = nodePreflight(options.preflight);

  async function install({ clients = [], update = false } = {}) {
    const selected = [...new Set(clients)];
    if (selected.some((client) => !['cursor', 'codex'].includes(client))) throw new Error('Unsupported client.');
    const before = readState(root);
    if (update && !before) throw new Error('Cannot update a missing installation.');
    if (fs.existsSync(agent) && !before) throw new Error('An unmanaged LaunchAgent already owns this service label.');
    const rootExisted = fs.existsSync(root);
    const cliExisted = fs.existsSync(path.join(root, 'runtime', 'lark-cli', CLI_VERSION, 'lark-cli'));
    const priorCurrent = symlinkValue(path.join(root, 'app', 'current'));
    const priorPrevious = symlinkValue(path.join(root, 'app', 'previous'));
    const priorPlist = fs.existsSync(agent) ? fs.readFileSync(agent, 'utf8') : null;
    const patches = [];
    let newRelease = null;
    let activated = false;
    try {
      for (const dir of ['app/releases', 'runtime', 'state/backups', 'config', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(agent), { recursive: true, mode: 0o700 });
      const cli = await acquireCli(root);
      if (cli.version !== CLI_VERSION || !cli.path.startsWith(path.join(root, 'runtime') + path.sep)) throw new Error('CLI acquisition contract failed.');
      const id = options.releaseIdOverride && testMode ? options.releaseIdOverride : `${VERSION}-${digestBundle(source).slice(0, 12)}`;
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid release id.');
      const releases = path.join(root, 'app', 'releases');
      const releaseDir = path.join(releases, id);
      if (!fs.existsSync(releaseDir)) {
        const stage = fs.mkdtempSync(path.join(root, 'app', 'stage-'));
        try { copyBundle(source, stage); await installDeps(stage); validateRelease(stage, node); fs.renameSync(stage, releaseDir); newRelease = releaseDir; }
        finally { fs.rmSync(stage, { recursive: true, force: true }); }
      } else validateRelease(releaseDir, node);
      const currentValue = `releases/${id}`;
      if (priorCurrent !== currentValue) {
        replaceSymlink(path.join(root, 'app', 'previous'), priorCurrent);
        replaceSymlink(path.join(root, 'app', 'current'), currentValue);
        activated = true;
      }
      const nextPlist = plist({ node, server: path.join(root, 'app', 'current', 'server.js'), cli: cli.path, home, port });
      if (priorPlist !== nextPlist || activated) {
        atomicWrite(agent, nextPlist);
        await controller.reload(agent);
      }
      const readiness = await health();
      if (!readiness.ok) throw new Error('Service health check failed.');
      const bound = new Set(before?.bound_clients || []);
      const clientsToPatch = update ? [] : selected;
      for (const client of clientsToPatch) {
        const patch = patchClient(home, client, port, path.join(root, 'state', 'backups'));
        patches.push(patch);
        bound.add(client);
      }
      const state = { component: COMPONENT, version: VERSION, release: id, previous: releaseIdFromLink(symlinkValue(path.join(root, 'app', 'previous'))), node, cli_version: CLI_VERSION, cli_binary_sha256: cli.binary_sha256, port, bound_clients: [...bound].sort(), updated_at: new Date().toISOString() };
      atomicWrite(path.join(root, 'state', 'state.json'), JSON.stringify(state, null, 2) + '\n');
      return { ok: true, action: update ? 'update' : 'install', installed: true, release: id, previous: state.previous, clients: state.bound_clients, node, cli_version: CLI_VERSION, health: { ok: true }, test_mode: testMode };
    } catch (error) {
      const restoreErrors = [];
      if (!before) {
        try { await controller.stop(agent); }
        catch (stopError) { throw new Error(`Install failed: ${error.message}; service stop failed: ${stopError.message}. Staged files were preserved for recovery.`); }
      }
      for (const patch of patches.reverse()) {
        try { restorePatch(patch); } catch (restoreError) { restoreErrors.push(restoreError.message); }
      }
      try {
        replaceSymlink(path.join(root, 'app', 'current'), priorCurrent);
        replaceSymlink(path.join(root, 'app', 'previous'), priorPrevious);
        if (priorPlist === null) fs.rmSync(agent, { force: true }); else atomicWrite(agent, priorPlist);
      } catch (restoreError) { restoreErrors.push(restoreError.message); }
      if (before) {
        try { await controller.reload(agent); }
        catch (restoreError) { restoreErrors.push(`previous service restart: ${restoreError.message}`); }
      }
      if (restoreErrors.length) throw new Error(`Install failed: ${error.message}; rollback incomplete: ${restoreErrors.join('; ')}`);
      if (newRelease) fs.rmSync(newRelease, { recursive: true, force: true });
      if (!cliExisted) fs.rmSync(path.join(root, 'runtime', 'lark-cli', CLI_VERSION), { recursive: true, force: true });
      if (!rootExisted) fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async function rollback() {
    const state = readState(root);
    if (!state) throw new Error('Component is not installed.');
    const current = symlinkValue(path.join(root, 'app', 'current'));
    const previous = symlinkValue(path.join(root, 'app', 'previous'));
    if (!previous) throw new Error('No previous known-good release.');
    const target = path.join(root, 'app', previous);
    if (!fs.existsSync(target)) throw new Error('Previous release is missing.');
    validateRelease(target, node);
    try {
      replaceSymlink(path.join(root, 'app', 'current'), previous);
      replaceSymlink(path.join(root, 'app', 'previous'), current);
      await controller.reload(agent);
      const ready = await health();
      if (!ready.ok) throw new Error('Rolled-back service is unhealthy.');
      state.release = releaseIdFromLink(previous);
      state.previous = releaseIdFromLink(current);
      state.updated_at = new Date().toISOString();
      atomicWrite(path.join(root, 'state', 'state.json'), JSON.stringify(state, null, 2) + '\n');
      return { ok: true, action: 'rollback', release: state.release, previous: state.previous, test_mode: testMode };
    } catch (error) {
      replaceSymlink(path.join(root, 'app', 'current'), current);
      replaceSymlink(path.join(root, 'app', 'previous'), previous);
      try { await controller.reload(agent); } catch {}
      throw error;
    }
  }

  async function uninstall({ clients = [] } = {}) {
    const state = readState(root);
    if (!state) return { ok: true, action: 'uninstall', installed: false, changed: false };
    const selected = clients.length ? [...new Set(clients)] : [...state.bound_clients];
    if (selected.some((client) => !['cursor', 'codex'].includes(client))) throw new Error('Unsupported client.');
    const patches = selected.map((client) => patchClient(home, client, state.port, path.join(root, 'state', 'backups'), true));
    if (clients.length) {
      state.bound_clients = state.bound_clients.filter((client) => !selected.includes(client));
      state.updated_at = new Date().toISOString();
      atomicWrite(path.join(root, 'state', 'state.json'), JSON.stringify(state, null, 2) + '\n');
      return { ok: true, action: 'uninstall', installed: true, unbound_clients: selected, remaining_clients: state.bound_clients, test_mode: testMode };
    }
    try { await controller.stop(agent); }
    catch (error) { for (const patch of patches.reverse()) restorePatch(patch); throw error; }
    fs.rmSync(agent, { force: true });
    for (const dir of ['app', 'runtime', 'state', 'config', 'logs']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    try { fs.rmdirSync(root); } catch { /* Unknown component-root files are preserved. */ }
    return { ok: true, action: 'uninstall', installed: false, removed_clients: selected, credentials_preserved: true, test_mode: testMode };
  }

  async function doctor() {
    const state = readState(root);
    const installed = Boolean(state);
    const cli = path.join(root, 'runtime', 'lark-cli', CLI_VERSION, 'lark-cli');
    let cliInfo = { installed: fs.existsSync(cli), version: null, integrity: false };
    if (cliInfo.installed) {
      try { cliInfo.version = CLI_VERSION; cliInfo.integrity = verifyCli(cli, home) === state?.cli_binary_sha256; }
      catch { cliInfo.integrity = false; }
    }
    const service = controller.status();
    const readiness = installed ? await health() : { ok: false };
    let auth = { available: false, token_status: 'unavailable', refresh_capable: false, long_lived_ready: false };
    if (installed && cliInfo.integrity) {
      try {
        const { OfficialLarkCliRunner, SharedLarkCliUserIdentity } = require('../shared-lark-cli-user.js');
        auth = await new SharedLarkCliUserIdentity({ runner: new OfficialLarkCliRunner({ executable: cli }) }).status();
      } catch { /* No credential or CLI config: report unavailable without reading secret material. */ }
    }
    const { profile } = require('../capabilities/profiles.js');
    return { ok: installed && cliInfo.integrity && readiness.ok, action: 'doctor', installed, release: state?.release || null, previous: state?.previous || null, service, health: { ok: Boolean(readiness.ok), runtime_version: readiness.runtime_version || null }, port: state?.port || port, cli: cliInfo, clients: clientBindings(home, state?.port || port), capability_registry: { count: 108, stable_semantic_tools: profile().stableSemanticTools.length }, auth, test_mode: testMode };
  }

  return { home, root, agent, port, testMode, install, rollback, uninstall, doctor };
}

module.exports = { LABEL, COMPONENT, BUNDLE, digestBundle, nodePreflight, plist, createManager, httpHealth, waitHealth };
