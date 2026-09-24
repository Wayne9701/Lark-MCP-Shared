'use strict';

function resolveIdentity(capability, requestedIdentity) {
  const preferred = capability.preferredIdentity;
  const requested = requestedIdentity || preferred;
  if (!capability.identity.includes(requested)) throw new Error(`${capability.id}: identity ${requested} is not supported`);
  if (requested !== preferred) throw new Error(`${capability.id}: non-preferred identity requires an explicit separately registered capability`);
  return requested;
}

function assertNoPrivilegeFallback(error) {
  if (!error) return;
  error.tenant_fallback_attempted = false;
  error.bot_fallback_attempted = false;
}

module.exports = { resolveIdentity, assertNoPrivilegeFallback };
