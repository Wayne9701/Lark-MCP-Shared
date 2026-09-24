#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { createManager } = require('./core.js');

function parse(argv) {
  const [action, ...rest] = argv;
  if (!['install', 'update', 'doctor', 'rollback', 'uninstall'].includes(action)) throw new Error('Expected install, update, doctor, rollback, or uninstall.');
  const result = { action, clients: [], json: false, testMode: false, port: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--client') result.clients.push(rest[++i]);
    else if (arg === '--json') result.json = true;
    else if (arg === '--test-mode') result.testMode = true;
    else if (arg === '--port') result.port = Number(rest[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.clients.some((client) => !['cursor', 'codex'].includes(client))) throw new Error('Client must be cursor or codex.');
  if (result.clients.length && !['install', 'uninstall'].includes(action)) throw new Error('--client is valid only for install/uninstall.');
  if (result.testMode && process.env.LARK_MCP_TEST_MODE !== '1') throw new Error('Test mode requires LARK_MCP_TEST_MODE=1.');
  if (result.port && !result.testMode) throw new Error('Port override is test-only.');
  if (result.testMode && !result.port) throw new Error('Test mode requires --port.');
  return result;
}
async function main(argv = process.argv.slice(2)) {
  const args = parse(argv);
  const manager = createManager({ home: os.homedir(), testMode: args.testMode, port: args.port || 33332 });
  let result;
  if (args.action === 'install') result = await manager.install({ clients: args.clients });
  else if (args.action === 'update') result = await manager.install({ update: true });
  else if (args.action === 'doctor') result = await manager.doctor();
  else if (args.action === 'rollback') result = await manager.rollback();
  else result = await manager.uninstall({ clients: args.clients });
  if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stdout.write(`${args.action}: ${result.ok ? 'ok' : 'needs attention'}\n${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}
if (require.main === module) main().catch((error) => {
  const json = process.argv.includes('--json');
  if (json) process.stdout.write(JSON.stringify({ ok: false, code: 'LARK_COMPONENT_OPERATION_FAILED', message: error.message }) + '\n');
  else process.stderr.write(`lark-mcp-shared: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { parse, main };
