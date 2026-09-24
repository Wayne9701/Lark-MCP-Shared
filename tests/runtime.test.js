'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createHttpApp, createSemanticServer } = require('../server.js');
const { profile, validateRegistry } = require('../capabilities/profiles.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stable-contract.json'), 'utf8'));
const fakeIdentity = {
  async status() { return { available: false, token_status: 'missing', scopes: [], refresh_capable: false, long_lived_ready: false }; },
  async runUser(args) { return { ok: true, data: { argv: args, access_token: 'fake-only-secret' } }; },
};

async function listen(app) {
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  return listener;
}

test('CLI-native runtime has exact 48-tool public contract on both Streamable HTTP endpoints', async () => {
  const app = createHttpApp({ identity: fakeIdentity });
  const listener = await listen(app);
  try {
    const port = listener.address().port;
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.capability_registry.capability_count, 108);
    assert.equal(health.capability_registry.stable_semantic_tool_count, 39);
    assert.equal(health.public_contract.raw_upstream_tools, false);
    for (const endpoint of ['/mcp', '/mcp/cursor']) {
      const client = new Client({ name: 'isolated-contract-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${endpoint}`)));
      try {
        const { tools } = await client.listTools();
        const actual = tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
        assert.deepEqual(actual, golden.map(({ name, inputSchema }) => ({ name, inputSchema })));
        const readTools = tools.filter((item) => item.annotations?.readOnlyHint === true && item.annotations?.destructiveHint !== true);
        assert.ok(readTools.length >= 20);
        assert.equal(tools.find((item) => item.name === 'lark_user_auth_start').annotations.readOnlyHint, false);
        assert.equal(tools.find((item) => item.name === 'im_user_auth_start').annotations.readOnlyHint, false);
        assert.equal(tools.find((item) => item.name === 'lark_capability_high_impact').annotations.destructiveHint, true);
        const result = await client.callTool({ name: 'lark_capability_read', arguments: { capability_id: 'sheets.cells.get', argv: ['--spreadsheet-token', 'fake', '--sheet-id', 'a', '--range', 'A1'] } });
        assert.equal(result.isError, undefined);
        assert.equal(JSON.stringify(result).includes('fake-only-secret'), false);
      } finally { await client.close(); }
    }
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test('registry, semantic names and runtime source keep the CLI-native boundary', async () => {
  assert.equal(validateRegistry().capabilityCount, 108);
  assert.equal(profile().stableSemanticTools.length, 39);
  const { server, names } = createSemanticServer(fakeIdentity);
  assert.equal(names.length, 48);
  await server.close();
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /CODEX_CONFIG_PATH|appSecret|authStore|LarkAuthHandlerLocal|initOAPIMcpServer|lark-mcp\/dist/);
});
