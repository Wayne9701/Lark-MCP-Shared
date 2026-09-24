#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createManager } = require('../installer/core.js');
const { installCli } = require('../installer/dependencies.js');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitReady(port) {
  for (let i = 0; i < 30; i += 1) {
    try { const result = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); if (result.ok) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated installed server did not become healthy.');
}
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lark standalone home with spaces-'));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  process.env.LARK_MCP_TEST_MODE = '1';
  let child;
  try {
    const port = await freePort();
    const archiveFile = process.env.LARK_TEST_OFFICIAL_ARCHIVE;
    const manager = createManager({ home, port, testMode: true, acquireCli: (root) => installCli(root, home, archiveFile ? { archiveFile } : {}) });
    const installed = await manager.install({ clients: ['cursor'] });
    const installedServer = path.join(manager.root, 'app', 'current', 'server.js');
    assert.ok(fs.existsSync(installedServer));
    assert.equal(fs.realpathSync(installedServer).startsWith(fs.realpathSync(manager.root) + path.sep), true);
    const plist = fs.readFileSync(manager.agent, 'utf8');
    assert.ok(plist.includes(fs.realpathSync(process.execPath)));
    assert.ok(plist.includes(path.join(manager.root, 'app', 'current', 'server.js')));
    assert.equal(plist.includes(__dirname), false);
    const fakeCli = path.join(home, 'fake-cli-for-runtime-only');
    fs.writeFileSync(fakeCli, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "lark-cli version 1.0.95"; else echo \'{"ok":true,"identities":{"user":{"status":"missing","scope":""}}}\'; fi\n', { mode: 0o700 });
    child = spawn(process.execPath, [installedServer], { env: { ...process.env, HOME: home, LARK_CLI_PATH: fakeCli, LARK_MCP_SHARED_PORT: String(port) }, stdio: 'ignore' });
    const health = await waitReady(port);
    assert.equal(health.capability_registry.capability_count, 108);
    assert.equal(health.public_contract.tool_count, 48);
    const client = new Client({ name: 'fresh-installed-smoke', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/cursor`)));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 48);
    await client.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    child = null;
    await manager.uninstall();
    console.log(JSON.stringify({ ok: true, release: installed.release, official_cli_version: installed.cli_version, tool_count: tools.length, installed_runtime_without_checkout: true, port_isolated: port !== 33332 }));
  } finally {
    if (child) child.kill('SIGKILL');
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    delete process.env.LARK_MCP_TEST_MODE;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
