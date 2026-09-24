'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManager, digestBundle } = require('../installer/core.js');
const { cursorPatch, codexPatch } = require('../installer/client-config.js');
const { parse } = require('../installer/cli.js');

const source = path.resolve(__dirname, '..');
function fixture(label = 'alternate home with spaces') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const counts = { reload: 0, stop: 0 };
  const controller = {
    async reload() { counts.reload += 1; },
    async stop() { counts.stop += 1; },
    status() { return { registered: counts.reload > counts.stop }; },
  };
  const acquireCli = async (root) => {
    const dir = path.join(root, 'runtime', 'lark-cli', '1.0.95');
    fs.mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, 'lark-cli');
    if (!fs.existsSync(binary)) {
      fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "lark-cli version 1.0.95"; else echo \'{"ok":true,"identities":{"user":{"status":"missing","scope":""}}}\'; fi\n', { mode: 0o700 });
      fs.chmodSync(binary, 0o700);
    }
    return { path: binary, version: '1.0.95', binary_sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') };
  };
  const installDependencies = (stage) => fs.symlinkSync(path.join(source, 'node_modules'), path.join(stage, 'node_modules'));
  const manager = (extra = {}) => createManager({ home, source, port: 35333, testMode: true, acquireCli, installDependencies, serviceController: controller, healthCheck: async () => ({ ok: true, service: 'lark-mcp-shared', runtime_version: '1.0.0' }), ...extra });
  return { home, counts, controller, manager, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}


test('every installer action accepts a machine-readable JSON contract', () => {
  for (const action of ['install', 'update', 'doctor', 'rollback', 'uninstall']) assert.equal(parse([action, '--json']).json, true);
  assert.deepEqual(parse(['install', '--client', 'cursor', '--client', 'codex', '--json']).clients, ['cursor', 'codex']);
  assert.throws(() => parse(['update', '--client', 'cursor']), /valid only/);
});

test('Cursor-only, Codex-only, both and neither install independently in non-user HOME', async () => {
  for (const clients of [['cursor'], ['codex'], ['cursor', 'codex'], []]) {
    const f = fixture();
    try {
      const result = await f.manager().install({ clients });
      assert.deepEqual(result.clients, [...clients].sort());
      assert.equal(fs.existsSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app', 'current', 'server.js')), true);
      assert.equal(fs.existsSync(path.join(f.home, '.cursor', 'mcp.json')), clients.includes('cursor'));
      assert.equal(fs.existsSync(path.join(f.home, '.codex', 'config.toml')), clients.includes('codex'));
      assert.equal((await f.manager().doctor()).ok, true);
    } finally { f.cleanup(); }
  }
});

test('client patches preserve unrelated MCP entries and do not require legacy configuration', () => {
  const cursor = cursorPatch('{"mcpServers":{"other":{"url":"http://example.invalid"}},"globalShortcut":true}', 35333);
  assert.equal(JSON.parse(cursor).mcpServers.other.url, 'http://example.invalid');
  assert.equal(JSON.parse(cursor).mcpServers['lark-mcp-shared'].url, 'http://127.0.0.1:35333/mcp/cursor');
  const codex = codexPatch('[mcp_servers."other"]\nurl = "http://example.invalid"\n', 35333);
  assert.match(codex, /\[mcp_servers\."other"\]/);
  assert.match(codex, /\[mcp_servers\."lark-mcp-shared"\]/);
  assert.equal(codexPatch(codex, 35333), codex);
  assert.match(codexPatch(codex, 35333, true), /\[mcp_servers\."other"\]/);
  assert.doesNotMatch(codexPatch(codex, 35333, true), /lark-mcp-shared/);
});

test('repeated install is idempotent and update then rollback use immutable releases without network', async () => {
  const f = fixture();
  try {
    const first = await f.manager({ releaseIdOverride: '1.0.0-a' }).install({ clients: ['cursor'] });
    const again = await f.manager({ releaseIdOverride: '1.0.0-a' }).install({ clients: ['cursor'] });
    assert.equal(first.release, again.release);
    assert.equal(f.counts.reload, 1);
    const updated = await f.manager({ releaseIdOverride: '1.0.0-b' }).install({ update: true });
    assert.equal(updated.previous, '1.0.0-a');
    assert.equal(fs.existsSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app', 'releases', '1.0.0-a')), true);
    const rolled = await f.manager().rollback();
    assert.equal(rolled.release, '1.0.0-a');
    assert.equal(rolled.previous, '1.0.0-b');
  } finally { f.cleanup(); }
});

test('uninstall removes only managed entries and leaves unrelated changes', async () => {
  const f = fixture();
  try {
    await f.manager().install({ clients: ['cursor', 'codex'] });
    const cursorFile = path.join(f.home, '.cursor', 'mcp.json');
    const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    cursor.mcpServers.later = { url: 'http://example.invalid/later' };
    fs.writeFileSync(cursorFile, JSON.stringify(cursor));
    await f.manager().uninstall({ clients: ['cursor'] });
    const afterUnbind = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    assert.equal(afterUnbind.mcpServers['lark-mcp-shared'], undefined);
    assert.ok(afterUnbind.mcpServers.later);
    await f.manager().uninstall();
    assert.ok(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).mcpServers.later);
    assert.equal(fs.readFileSync(path.join(f.home, '.codex', 'config.toml'), 'utf8').includes('lark-mcp-shared'), false);
    assert.equal(fs.existsSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app')), false);
  } finally { f.cleanup(); }
});

test('failed activation restores prior links, plist and client configuration', async () => {
  const f = fixture();
  try {
    const first = await f.manager({ releaseIdOverride: '1.0.0-a' }).install({ clients: ['cursor'] });
    const cursorFile = path.join(f.home, '.cursor', 'mcp.json');
    const beforeCursor = fs.readFileSync(cursorFile);
    let failedOnce = false;
    const badController = { ...f.controller, async reload() { if (!failedOnce) { failedOnce = true; throw new Error('simulated activation failure'); } f.counts.reload += 1; } };
    await assert.rejects(f.manager({ releaseIdOverride: '1.0.0-b', serviceController: badController }).install({ update: true }), /simulated activation failure/);
    assert.equal(fs.readlinkSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app', 'current')), `releases/${first.release}`);
    assert.deepEqual(fs.readFileSync(cursorFile), beforeCursor);
    assert.equal(fs.existsSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app', 'releases', '1.0.0-b')), false);
  } finally { f.cleanup(); }
});


test('failed fresh activation stops the test service before deleting its plist and staged files', async () => {
  const f = fixture();
  try {
    let agentWasPresentAtStop = false;
    const controller = {
      async reload() { throw new Error('simulated first activation failure'); },
      async stop(agent) { agentWasPresentAtStop = fs.existsSync(agent); },
      status() { return { registered: false }; },
    };
    await assert.rejects(f.manager({ serviceController: controller }).install({ clients: ['cursor'] }), /simulated first activation failure/);
    assert.equal(agentWasPresentAtStop, true);
    assert.equal(fs.existsSync(path.join(f.home, '.cursor', 'mcp.json')), false);
    assert.equal(fs.existsSync(path.join(f.home, 'Library', 'Application Support', 'Lark-MCP-Shared', 'app')), false);
  } finally { f.cleanup(); }
});

test('dynamic Node path, clean source bundle and no Production paths/secrets', () => {
  const f = fixture();
  try {
    assert.equal(digestBundle(source).length, 64);
    const manager = f.manager();
    assert.equal(manager.root.startsWith(f.home), true);
    const files = ['server.js', 'user-semantic-tools.js', 'shared-lark-cli-user.js', 'installer/core.js', 'installer/dependencies.js'];
    for (const file of files) {
      const text = fs.readFileSync(path.join(source, file), 'utf8');
      assert.equal((/\/Users\/[A-Za-z0-9._-]+/).test(text), false);
    }
  } finally { f.cleanup(); }
});
