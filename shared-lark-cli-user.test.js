'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  REFRESH_PROVIDER,
  REQUIRED_SCOPES,
  SHEETS_READ_SCOPES,
  BUSINESS_FULL_USER_SCOPES,
  REQUIRED_BUSINESS_SCOPES,
  OPTIONAL_TIER2_SCOPES,
  SharedLarkCliUserIdentity,
  OfficialLarkCliRunner,
  statusFromCli,
} = require('./shared-lark-cli-user.js');

function payload({ status = 'ready', tokenStatus = 'ready', expiresAt = '2026-09-02T10:00:00+08:00', refreshExpiresAt = '2026-10-02T10:00:00+08:00', scopes = REQUIRED_SCOPES } = {}) {
  return { ok: true, identities: { user: { status, available: status === 'ready' || status === 'needs_refresh', tokenStatus, expiresAt, refreshExpiresAt, scope: scopes.join(' ') } } };
}

class FakeRunner {
  constructor(sequence = [payload()]) { this.sequence = sequence; this.calls = []; this.resumed = []; }
  async run(args) {
    this.calls.push(args);
    if (args[0] === 'auth' && args[1] === 'status') return this.sequence.shift() || payload();
    return { ok: true, identity: 'user', data: { items: [] }, meta: { count: 0 } };
  }
  async beginDeviceFlow() { return { verification_url: 'https://passport.feishu.cn/device', device_code: 'never-expose-this' }; }
  resumeDeviceFlow(deviceCode) { this.resumed.push(deviceCode); return new Promise(() => {}); }
}


test('official CLI subprocess receives only an allowlisted environment', () => {
  const marker = 'FAKE_APP_SECRET_FOR_TEST_ONLY';
  process.env[marker] = 'fake-secret-value';
  try { assert.equal(Object.prototype.hasOwnProperty.call(new OfficialLarkCliRunner().environment(), marker), false); }
  finally { delete process.env[marker]; }
});

test('official CLI status exposes only safe long-lived metadata', () => {
  const state = statusFromCli(payload());
  assert.equal(state.token_status, 'valid');
  assert.equal(state.refresh_capable, true);
  assert.equal(state.long_lived_ready, true);
  assert.equal(state.refresh_provider, REFRESH_PROVIDER);
  assert.deepEqual(state.scopes, REQUIRED_SCOPES);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'access_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'refresh_token'), false);
});

test('equal access and refresh expiry fails closed because it can be the official no-refresh-token fallback', () => {
  const expiry = '2026-09-02T10:00:00+08:00';
  const state = statusFromCli(payload({ expiresAt: expiry, refreshExpiresAt: expiry }));
  assert.equal(state.refresh_capable, false);
  assert.equal(state.long_lived_ready, false);
});

test('a refresh expiry later than access expiry is long-lived when required scopes are present', () => {
  const state = statusFromCli(payload({
    expiresAt: '2026-09-02T10:00:00+08:00',
    refreshExpiresAt: '2026-09-09T10:00:00+08:00',
  }));
  assert.equal(state.refresh_capable, true);
  assert.equal(state.long_lived_ready, true);
});

test('valid access with the complete business-full scope set does not start End User Consent again', async () => {
  const scopes = BUSINESS_FULL_USER_SCOPES;
  const runner = new FakeRunner([payload({ scopes }), payload({ scopes })]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  const start = await identity.authorizationStart();
  assert.equal(start.status, 'not_required');
  assert.equal(runner.resumed.length, 0);
});


test('optional Tier 2 IM-send scope is reported but never requested automatically', async () => {
  const scopes = REQUIRED_BUSINESS_SCOPES;
  const runner = new FakeRunner([payload({ scopes }), payload({ scopes })]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  const state = await identity.status();
  assert.equal(state.profiles.business_full.ready, true);
  assert.deepEqual(state.profiles.business_full.optional_missing_scopes, OPTIONAL_TIER2_SCOPES);
  const start = await identity.authorizationStart();
  assert.equal(start.status, 'not_required');
  assert.equal(runner.resumed.length, 0);
});

test('valid IM access missing Sheets read scope starts one combined End User Consent flow', async () => {
  const runner = new FakeRunner([payload()]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  const start = await identity.authorizationStart();
  assert.equal(start.status, 'USER_ACTION_REQUIRED');
  assert.equal(runner.resumed.length, 1);
  assert.equal(JSON.stringify(start).includes('device_code'), false);
});

test('needs_refresh is accepted and the official CLI performs the request', async () => {
  const runner = new FakeRunner([payload({ status: 'needs_refresh', tokenStatus: 'needs_refresh' }), payload()]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  await identity.chatList({ page_size: 25, sort: 'active_time' });
  assert.deepEqual(runner.calls.at(-1), ['im', '+chat-list', '--as', 'user', '--types', 'p2p,group', '--page-size', '25', '--sort', 'active_time', '--format', 'json']);
});

test('a restarted Shared MCP sees the same refreshed official credential state', async () => {
  const runner = new FakeRunner([payload({ status: 'needs_refresh', tokenStatus: 'needs_refresh' }), payload()]);
  const first = new SharedLarkCliUserIdentity({ runner });
  await first.chatMessages({ chat_id: 'oc_fixture', page_size: 50, order: 'asc' });
  const restarted = new SharedLarkCliUserIdentity({ runner });
  const afterRestart = await restarted.status();
  assert.equal(afterRestart.long_lived_ready, true);
});

test('only a missing/invalid official credential starts one in-memory Device Authorization continuation', async () => {
  const runner = new FakeRunner([payload({ status: 'missing', tokenStatus: '' }), payload({ status: 'missing', tokenStatus: '' })]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  const first = await identity.authorizationStart();
  const second = await identity.authorizationStart();
  assert.equal(first.status, 'USER_ACTION_REQUIRED');
  assert.equal(second.status, 'USER_ACTION_REQUIRED');
  assert.equal(runner.resumed.length, 1);
  assert.equal(JSON.stringify(first).includes('device_code'), false);
});

test('missing scope or terminal refresh loss returns reauth-required', async () => {
  const runner = new FakeRunner([payload({ scopes: REQUIRED_SCOPES.slice(0, -1) }), payload({ status: 'missing', tokenStatus: '' })]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  await assert.rejects(identity.messagesSearch({ query: 'fixture' }), (error) => error.code === 'USER_SCOPE_REQUIRED');
});

test('IM wrappers retain semantic inputs and use only official read-only CLI commands', async () => {
  const runner = new FakeRunner([payload(), payload(), payload(), payload()]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  await identity.chatMessages({ user_id: 'ou_fixture', start: '2026-08-26T00:00:00+08:00', end: '2026-09-01T23:59:59+08:00', order: 'asc', page_all: true, page_limit: 3 });
  await identity.messagesSearch({ query: 'fixture', chat_type: 'p2p' });
  await identity.threadMessages({ thread: 'omt_fixture', order: 'asc' });
  assert.ok(runner.calls.some((args) => args.includes('+chat-messages-list') && args.includes('--user-id') && args.includes('--no-reactions')));
  assert.ok(runner.calls.some((args) => args.includes('+messages-search') && args.includes('--no-reactions')));
  assert.ok(runner.calls.some((args) => args.includes('+threads-messages-list') && args.includes('--no-reactions')));
});

test('Sheets wrappers use only official read shortcuts under the user identity', async () => {
  const scopes = [...REQUIRED_SCOPES, ...SHEETS_READ_SCOPES];
  const runner = new FakeRunner([payload({ scopes }), payload({ scopes }), payload({ scopes }), payload({ scopes })]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  await identity.sheetsWorkbookInfo({ spreadsheet_token: 'sht_fixture' });
  await identity.sheetsCellsGet({ url: 'https://example.feishu.cn/sheets/fixture', sheet_name: 'Revenue', range: 'A1:F10', include: ['value', 'formula'], max_chars: 25000 });
  await identity.sheetsCsvGet({ spreadsheet_token: 'sht_fixture', sheet_id: 'sheet_1', range: 'A1:C30', skip_hidden: true });
  await identity.sheetsTableGet({ spreadsheet_token: 'sht_fixture', sheet_name: 'Revenue', range: 'A1:H50', no_header: true });
  assert.ok(runner.calls.some((args) => args.includes('+workbook-info') && args.includes('--as') && args.includes('user')));
  assert.ok(runner.calls.some((args) => args.includes('+cells-get') && args.includes('--range') && args.includes('A1:F10') && args.includes('--include') && args.includes('value,formula')));
  assert.ok(runner.calls.some((args) => args.includes('+csv-get') && args.includes('--skip-hidden')));
  assert.ok(runner.calls.some((args) => args.includes('+table-get') && args.includes('--no-header')));
  assert.equal(runner.calls.some((args) => args.some((arg) => /put|write|replace|clear/i.test(arg))), false);
});

test('Sheets wrappers fail closed when spreadsheet read scope is absent', async () => {
  const runner = new FakeRunner([payload()]);
  const identity = new SharedLarkCliUserIdentity({ runner });
  await assert.rejects(
    identity.sheetsWorkbookInfo({ spreadsheet_token: 'sht_fixture' }),
    (error) => error.code === 'USER_SCOPE_REQUIRED' && error.missing_scopes.includes('sheets:spreadsheet:read'),
  );
});

test('old OIDC v1 and upstream MCP auth/runtime are absent from CLI-native server', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, 'shared-lark-cli-user.js'), 'utf8');
  assert.doesNotMatch(`${server}\n${helper}`, /authen\/v1\/oidc\/refresh_access_token|LarkOIDC2OAuthServerProvider|SharedOAuthUserIdentity/);
  assert.doesNotMatch(server, /\/auth\/user\/(start|status|verify-im)/);
  assert.doesNotMatch(server, /initOAPIMcpServer|LarkAuthHandlerLocal|authStore|CODEX_CONFIG_PATH|appSecret/);
  assert.match(helper, /\+chat-list/);
  assert.match(helper, /\+chat-messages-list/);
  assert.match(helper, /\+messages-search/);
  assert.match(helper, /\+threads-messages-list/);
});
