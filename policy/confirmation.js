'use strict';

const OPERATIONS = new Set(['read', 'write', 'destructive', 'external_send', 'permission']);

function expectedTier(operation) {
  if (operation === 'read') return 0;
  if (operation === 'write') return 1;
  if (operation === 'destructive' || operation === 'external_send' || operation === 'permission') return 2;
  throw new Error(`Unsupported operation: ${operation}`);
}

function validatePolicy(capability) {
  if (!OPERATIONS.has(capability.operation)) throw new Error(`${capability.id}: invalid operation`);
  const expected = expectedTier(capability.operation);
  if (capability.confirmationTier !== expected) {
    throw new Error(`${capability.id}: ${capability.operation} must be Tier ${expected}`);
  }
  if (capability.confirmationTier === 3) throw new Error(`${capability.id}: Tier 3 cannot be registered`);
  return true;
}

function channelFor(capability) {
  validatePolicy(capability);
  if (capability.confirmationTier === 0) return 'read';
  if (capability.confirmationTier === 1) return 'write';
  return 'high_impact';
}

function annotationsFor(capability) {
  validatePolicy(capability);
  return {
    readOnlyHint: capability.confirmationTier === 0,
    destructiveHint: capability.confirmationTier === 2,
    idempotentHint: capability.operation === 'read',
    openWorldHint: capability.operation === 'external_send' || capability.operation === 'permission',
  };
}

module.exports = { OPERATIONS, expectedTier, validatePolicy, channelFor, annotationsFor };
