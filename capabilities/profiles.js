'use strict';

const { CAPABILITIES, PROFILE, listCapabilities } = require('./registry.js');
const { validatePolicy } = require('../policy/confirmation.js');

const REQUIRED_FIELDS = [
  'id', 'domain', 'title', 'description', 'backend', 'backendTool', 'operation',
  'confirmationTier', 'identity', 'preferredIdentity', 'requiredScopes', 'reversible',
  'supportsPrecondition', 'postVerify', 'profile', 'publicSemantic', 'availability', 'version',
];

function validateRegistry(capabilities = CAPABILITIES) {
  const seen = new Set();
  for (const capability of capabilities) {
    for (const field of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(capability, field)) throw new Error(`${capability.id || '<unknown>'}: missing ${field}`);
    }
    if (!capability.id || seen.has(capability.id)) throw new Error(`duplicate or empty capability id: ${capability.id}`);
    seen.add(capability.id);
    if (!Array.isArray(capability.identity) || !capability.identity.length) throw new Error(`${capability.id}: identity must be non-empty`);
    if (!capability.identity.includes(capability.preferredIdentity)) throw new Error(`${capability.id}: preferredIdentity is unsupported`);
    if (!Array.isArray(capability.requiredScopes) || capability.requiredScopes.some((scope) => typeof scope !== 'string' || !scope)) throw new Error(`${capability.id}: requiredScopes invalid`);
    if (!Array.isArray(capability.profile) || !capability.profile.includes(PROFILE)) throw new Error(`${capability.id}: business-full profile missing`);
    if (!['yes', 'partial', 'no'].includes(capability.reversible)) throw new Error(`${capability.id}: reversible invalid`);
    if (capability.operation !== 'read' && (!capability.identity.length || !capability.requiredScopes.length || capability.postVerify === 'none')) {
      throw new Error(`${capability.id}: write capability lacks identity/scope/verification metadata`);
    }
    if (capability.operation === 'read' && capability.requiredScopes.some((scope) => /write|create|delete|update|send_as/i.test(scope))) {
      throw new Error(`${capability.id}: read capability requires a write scope`);
    }
    validatePolicy(capability);
  }
  return { capabilityCount: capabilities.length, capabilityIds: [...seen].sort() };
}

function profile(name = PROFILE) {
  if (name !== PROFILE) throw new Error(`Unknown profile: ${name}`);
  const capabilities = listCapabilities({ profile: name });
  return {
    name,
    capabilityIds: capabilities.map((item) => item.id).sort(),
    stableSemanticTools: capabilities.filter((item) => item.publicSemantic).map((item) => item.semanticTool).filter(Boolean).sort(),
    upstreamTools: capabilities.filter((item) => item.backend === 'upstream_mcp').map((item) => item.backendTool).sort(),
  };
}

function assertProfileParity(clientProfiles) {
  const expected = profile().stableSemanticTools;
  for (const [client, tools] of Object.entries(clientProfiles)) {
    const actual = [...new Set(tools)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${client}: stable semantic profile mismatch`);
  }
  return true;
}

module.exports = { REQUIRED_FIELDS, validateRegistry, profile, assertProfileParity };
