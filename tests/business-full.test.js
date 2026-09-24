'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CAPABILITIES, getCapability, businessFullScopes, CLI_VERSION } = require('../capabilities/registry.js');
const { validateRegistry, profile, assertProfileParity } = require('../capabilities/profiles.js');
const { expectedTier, annotationsFor } = require('../policy/confirmation.js');
const { resolveIdentity } = require('../policy/identity-routing.js');
const { commandArgs, invokeCapability, validateArgv } = require('../semantic/capability-invoker.js');
const { redactSecrets } = require('../verification/post-write.js');

class FakeIdentity {
  constructor() { this.calls = []; }
  async runUser(args, scopes) {
    this.calls.push({ args, scopes });
    return { ok: true, data: { call: this.calls.length, access_token: 'must-not-leak' } };
  }
}

test('business-full registry is complete, unique and pinned', () => {
  const result = validateRegistry();
  const scopes = businessFullScopes('user');
  assert.equal(result.capabilityCount, 108);
  assert.equal(CLI_VERSION, '1.0.95');
  assert.ok(scopes.length >= 40);
  assert.equal(scopes.includes('docs:permission.setting:write'), false);
  assert.equal(scopes.includes('docs:permission.setting:write_only'), true);
  assert.equal(scopes.includes('im:message.send_as_user'), true);
  assert.ok(profile().stableSemanticTools.length >= 35);
});

test('operation class deterministically controls risk tier and annotations', () => {
  for (const capability of CAPABILITIES) {
    assert.equal(capability.confirmationTier, expectedTier(capability.operation));
    const annotations = annotationsFor(capability);
    assert.equal(annotations.readOnlyHint, capability.confirmationTier === 0);
    assert.equal(annotations.destructiveHint, capability.confirmationTier === 2);
  }
});

test('identity routing is fail-closed and never escalates from user to bot', () => {
  const capability = getCapability('sheets.cells.set');
  assert.equal(resolveIdentity(capability), 'user');
  assert.throws(() => resolveIdentity(capability, 'bot'), /non-preferred identity/);
  assert.throws(() => resolveIdentity(getCapability('im.message.send'), 'bot'), /not supported/);
});

test('generic argv cannot override identity, output, confirmation or local file boundary', () => {
  for (const argv of [['--as', 'bot'], ['--yes'], ['--format=json'], ['@secret'], ['/tmp/file'], ['../file']]) {
    assert.throws(() => validateArgv(argv));
  }
  const args = commandArgs(getCapability('sheets.cells.get'), ['--spreadsheet-token', 'fixture', '--sheet-id', 'one', '--range', 'A1:B2'], false);
  assert.deepEqual(args.slice(-4), ['--as', 'user', '--format', 'json']);
});

test('read, Tier-1 write and Tier-2 high-impact routes enforce channel and read-back', async () => {
  const identity = new FakeIdentity();
  await invokeCapability(identity, 'sheets.cells.get', ['--spreadsheet-token', 'fixture', '--sheet-id', 'one', '--range', 'A1'], { channel: 'read' });
  const receipt = await invokeCapability(identity, 'sheets.cells.set', ['--spreadsheet-token', 'fixture', '--sheet-id', 'one', '--range', 'A1', '--cells', '[[{"value":"x"}]]'], {
    channel: 'write',
    precondition: { capability_id: 'sheets.revision.get', argv: ['--spreadsheet-token', 'fixture'] },
    verify: { capability_id: 'sheets.cells.get', argv: ['--spreadsheet-token', 'fixture', '--sheet-id', 'one', '--range', 'A1'] },
  });
  assert.equal(receipt.confirmation_tier, 1);
  assert.equal(receipt.mutation.data.access_token, '[REDACTED]');
  assert.equal(identity.calls.length, 4);
  assert.equal(identity.calls.some(({ args }) => args.includes('--yes')), false);
  await assert.rejects(invokeCapability(identity, 'sheets.cells.clear', ['--spreadsheet-token', 'fixture'], {
    channel: 'write',
    precondition: { capability_id: 'sheets.revision.get', argv: ['--spreadsheet-token', 'fixture'] },
    verify: { capability_id: 'sheets.cells.get', argv: ['--spreadsheet-token', 'fixture', '--sheet-id', 'one', '--range', 'A1'] },
  }), /high_impact/);
});

test('both clients expose the same stable semantic profile', () => {
  const stable = profile().stableSemanticTools;
  assert.equal(assertProfileParity({ codex: stable, cursor: stable }), true);
});

test('secret-shaped fields are redacted recursively', () => {
  assert.deepEqual(redactSecrets({ access_token: 'a', nested: { refreshToken: 'b', safe: 1 }, values: [{ device_code: 'c' }] }), {
    access_token: '[REDACTED]', nested: { refreshToken: '[REDACTED]', safe: 1 }, values: [{ device_code: '[REDACTED]' }],
  });
});

test('server derives custom tool counts and has no hard-coded legacy totals', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /businessProfile\.stableSemanticTools/);
  assert.match(source, /CAPABILITIES\.length/);
  assert.match(source, /registerBusinessTools/);
  assert.doesNotMatch(source, /USER_CUSTOM_TOOL_COUNT\s*=\s*10/);
});
