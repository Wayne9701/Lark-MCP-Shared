'use strict';

const SECRET_KEY = /(access[_-]?token|refresh[_-]?token|app[_-]?secret|device[_-]?code|authorization[_-]?code)/i;

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSecrets(child);
  }
  return result;
}

function safeMutationReceipt(capability, baseline, mutation, verification) {
  return {
    ok: true,
    identity: capability.preferredIdentity,
    capability_id: capability.id,
    operation: capability.operation,
    confirmation_tier: capability.confirmationTier,
    baseline: redactSecrets(baseline),
    mutation: redactSecrets(mutation),
    verification: redactSecrets(verification),
    retry_policy: 'never_auto_retry_after_uncertain_mutation',
  };
}

module.exports = { SECRET_KEY, redactSecrets, safeMutationReceipt };
