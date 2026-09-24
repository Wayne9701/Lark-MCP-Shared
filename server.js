#!/usr/bin/env node
'use strict';

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { SharedLarkCliUserIdentity } = require('./shared-lark-cli-user.js');
const { registerUserImTools } = require('./user-semantic-tools.js');
const { registerBusinessTools } = require('./semantic/register-business-tools.js');
const { CAPABILITIES } = require('./capabilities/registry.js');
const { profile, validateRegistry } = require('./capabilities/profiles.js');

const SERVICE = 'lark-mcp-shared';
const CONTRACT_VERSION = '1.0.0';
const INFRASTRUCTURE_TOOLS = [
  'im_user_auth_status', 'im_user_auth_start',
  'lark_user_auth_status', 'lark_user_auth_start',
  'lark_capability_list', 'lark_capability_get', 'lark_capability_read',
  'lark_capability_write', 'lark_capability_high_impact',
];
const businessProfile = profile();
validateRegistry();

function createSemanticServer(identity = new SharedLarkCliUserIdentity()) {
  const server = new McpServer({ name: SERVICE, version: CONTRACT_VERSION });
  const names = [];
  const tracked = {
    registerTool(name, ...args) {
      names.push(name);
      return server.registerTool(name, ...args);
    },
    tool(name, ...args) {
      names.push(name);
      return server.tool(name, ...args);
    },
  };
  registerUserImTools(tracked, identity);
  registerBusinessTools(tracked, identity, z);
  const expected = [...new Set([...businessProfile.stableSemanticTools, ...INFRASTRUCTURE_TOOLS])].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
    throw new Error('Stable semantic tool contract mismatch.');
  }
  return { server, names: expected };
}

function parseListenConfig(env = process.env) {
  const host = env.LARK_MCP_SHARED_HOST || '127.0.0.1';
  const port = Number(env.LARK_MCP_SHARED_PORT || '33332');
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Only localhost binding is supported.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid service port.');
  return { host, port };
}

function createHttpApp({ identity = new SharedLarkCliUserIdentity() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const requestCounts = { codex: 0, cursor: 0 };
  const contract = createSemanticServer(identity);
  contract.server.close();

  app.get('/health', async (_req, res) => {
    let auth;
    try { auth = await identity.status(); }
    catch { auth = { available: false, token_status: 'unavailable', refresh_capable: false, long_lived_ready: false }; }
    res.json({
      ok: true,
      service: SERVICE,
      pid: process.pid,
      runtime_version: CONTRACT_VERSION,
      capability_registry: { profile: businessProfile.name, capability_count: CAPABILITIES.length, stable_semantic_tool_count: businessProfile.stableSemanticTools.length },
      public_contract: { tool_count: contract.names.length, tools: contract.names, raw_upstream_tools: false },
      endpoints: { codex: '/mcp', cursor: '/mcp/cursor' },
      requests: requestCounts,
      user_identity: auth,
    });
  });

  const handleMcp = (client) => async (req, res) => {
    let server;
    let transport;
    try {
      ({ server } = createSemanticServer(identity));
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      let closed = false;
      res.on('close', () => {
        if (closed) return;
        closed = true;
        try { transport.close(); } catch {}
        try { server.close(); } catch {}
      });
      await server.connect(transport);
      requestCounts[client] += 1;
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: req.body && req.body.id || null });
      try { transport && transport.close(); } catch {}
      try { server && server.close(); } catch {}
    }
  };
  app.post('/mcp', handleMcp('codex'));
  app.post('/mcp/cursor', handleMcp('cursor'));
  for (const endpoint of ['/mcp', '/mcp/cursor']) {
    for (const method of ['get', 'delete']) app[method](endpoint, (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  }
  return app;
}

function start(env = process.env) {
  const { host, port } = parseListenConfig(env);
  const app = createHttpApp();
  const listener = app.listen(port, host, () => {
    process.stdout.write(`[${SERVICE}] ready http://${host}:${port}/mcp runtime=${CONTRACT_VERSION} pid=${process.pid}\n`);
  });
  listener.on('error', () => { process.stderr.write(`[${SERVICE}] listener failed\n`); process.exitCode = 1; });
  const shutdown = () => listener.close(() => { process.exitCode = 0; });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return listener;
}

if (require.main === module) start();
module.exports = { SERVICE, CONTRACT_VERSION, INFRASTRUCTURE_TOOLS, createSemanticServer, createHttpApp, parseListenConfig, start };
