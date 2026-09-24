'use strict';

const { getCapability } = require('../capabilities/registry.js');
const { channelFor } = require('../policy/confirmation.js');
const { resolveIdentity, assertNoPrivilegeFallback } = require('../policy/identity-routing.js');
const { redactSecrets, safeMutationReceipt } = require('../verification/post-write.js');

const BLOCKED_FLAGS = new Set(['--as', '--format', '--json', '--yes', '--device-code', '--scope', '--domain', '--recommend']);

function validateArgv(argv, allowedBlockedFlags = new Set()) {
  if (!Array.isArray(argv) || argv.length > 200) throw new Error('argv must be an array of at most 200 strings');
  for (const value of argv) {
    if (typeof value !== 'string' || value.length > 200000 || /[\0\r\n]/.test(value)) throw new Error('argv contains an invalid value');
    const flag = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (BLOCKED_FLAGS.has(flag) && !allowedBlockedFlags.has(flag)) throw new Error(`caller-controlled ${flag} is forbidden`);
    if (value === '-' || value.startsWith('@') || value.startsWith('/') || value.split('/').includes('..')) {
      throw new Error('stdin, @file, absolute paths, and parent traversal are not accepted by Shared MCP capability invoke');
    }
  }
  return argv;
}

function commandArgs(capability, argv, highImpactApproved) {
  const command = capability.backendTool.split(/\s+/).filter(Boolean);
  const internallyRequired = capability.domain === 'base' ? new Set(['--json']) : new Set();
  const args = [...command, ...validateArgv(argv, internallyRequired), '--as', resolveIdentity(capability), '--format', 'json'];
  if (capability.confirmationTier === 2) {
    if (!highImpactApproved) throw new Error(`${capability.id}: Tier 2 invocation requires the high-impact MCP surface`);
    args.push('--yes');
  }
  return args;
}

async function executeRead(sharedUserIdentity, capability, argv) {
  if (!capability || capability.operation !== 'read') throw new Error('read verification must use a registered read capability');
  try {
    return redactSecrets(await sharedUserIdentity.runUser(commandArgs(capability, argv, false), capability.requiredScopes));
  } catch (error) {
    assertNoPrivilegeFallback(error);
    throw error;
  }
}

function readSpec(spec, label) {
  if (!spec || typeof spec !== 'object' || !spec.capability_id || !Array.isArray(spec.argv)) {
    throw new Error(`${label} requires capability_id and argv`);
  }
  const capability = getCapability(spec.capability_id);
  if (!capability || capability.operation !== 'read') throw new Error(`${label} must reference a registered read capability`);
  return { capability, argv: spec.argv };
}

async function invokeCapability(sharedUserIdentity, id, argv, options = {}) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  const channel = channelFor(capability);
  if (channel !== options.channel) throw new Error(`${id}: use the ${channel} invocation surface`);
  if (channel === 'read') return executeRead(sharedUserIdentity, capability, argv);

  let baseline = { status: 'not_supported' };
  if (capability.supportsPrecondition) {
    const precondition = readSpec(options.precondition, 'precondition');
    baseline = await executeRead(sharedUserIdentity, precondition.capability, precondition.argv);
  }
  const verificationSpec = readSpec(options.verify, 'post-verify');
  let mutation;
  try {
    mutation = await sharedUserIdentity.runUser(
      commandArgs(capability, argv, channel === 'high_impact'),
      capability.requiredScopes,
    );
  } catch (error) {
    assertNoPrivilegeFallback(error);
    error.mutation_state = 'uncertain_or_failed_read_back_required_before_retry';
    throw error;
  }
  const verification = await executeRead(sharedUserIdentity, verificationSpec.capability, verificationSpec.argv);
  return safeMutationReceipt(capability, baseline, mutation, verification);
}

module.exports = { BLOCKED_FLAGS, validateArgv, commandArgs, invokeCapability };
