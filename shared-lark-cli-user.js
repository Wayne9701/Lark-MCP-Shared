'use strict';

// The official lark-cli is the sole owner of End User Consent credentials.
// This adapter never reads, exports, logs, or stores access/refresh/device tokens.
const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { businessFullScopes, CLI_VERSION } = require('./capabilities/registry.js');
const { redactSecrets } = require('./verification/post-write.js');

const REFRESH_PROVIDER = 'official_lark_cli_end_user_consent_v2';
const REQUIRED_SCOPES = [
  'im:chat:read',
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'search:message',
];
const SHEETS_READ_SCOPES = ['sheets:spreadsheet:read'];
const BUSINESS_FULL_USER_SCOPES = businessFullScopes('user');
const OPTIONAL_TIER2_SCOPES = ['im:message.send_as_user'];
const REQUIRED_BUSINESS_SCOPES = BUSINESS_FULL_USER_SCOPES.filter((scope) => !OPTIONAL_TIER2_SCOPES.includes(scope));

function asArray(scope) {
  return typeof scope === 'string' ? scope.split(/[\s,]+/).filter(Boolean) : [];
}

function isStrictlyLater(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}

function statusFromCli(payload, requiredScopes = REQUIRED_SCOPES) {
  const root = payload && payload.data && payload.data.identities ? payload.data : payload;
  const user = root && root.identities && root.identities.user || {};
  const scopes = asArray(user.scope);
  const tokenStatus = user.tokenStatus === 'ready' ? 'valid'
    : user.tokenStatus === 'needs_refresh' ? 'needs_refresh'
      : user.status === 'ready' ? 'valid'
        : user.status === 'needs_refresh' ? 'needs_refresh'
          : user.status === 'verify_failed' ? 'invalid' : 'missing';
  // The official CLI falls back to refreshExpiresIn=tokenExpiresIn when the
  // token response omits refresh_token. Equal expiry must fail closed.
  const refreshCapable = (tokenStatus === 'valid' || tokenStatus === 'needs_refresh')
    && isStrictlyLater(user.refreshExpiresAt, user.expiresAt);
  const missingRequiredScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  const requiredScopesPresent = missingRequiredScopes.length === 0;
  return {
    available: Boolean(user.available),
    token_status: tokenStatus,
    expires_at: user.expiresAt || null,
    refresh_expires_at: user.refreshExpiresAt || null,
    refresh_capable: refreshCapable,
    long_lived_ready: Boolean(refreshCapable && requiredScopesPresent),
    refresh_provider: REFRESH_PROVIDER,
    scopes,
    required_scopes_present: requiredScopesPresent,
    missing_required_scopes: missingRequiredScopes,
  };
}

function cliError(result) {
  const error = new Error('Official Lark CLI user-identity request failed.');
  error.code = 'USER_AUTH_REQUIRED';
  error.auth_state = result && result.auth;
  error.cli_status = result && result.status;
  return error;
}

function scopeError(state, requiredScopes) {
  const missing = requiredScopes.filter((scope) => !state.scopes.includes(scope));
  const error = new Error(`Official Lark CLI user identity is missing required scope(s): ${missing.join(', ')}`);
  error.code = 'USER_SCOPE_REQUIRED';
  error.auth_state = state;
  error.missing_scopes = missing;
  return error;
}

class OfficialLarkCliRunner {
  constructor({ executable = process.env.LARK_CLI_PATH || path.join(path.dirname(process.execPath), 'lark-cli'), execFileImpl = execFile, spawnImpl = spawn } = {}) {
    this.executable = executable;
    this.execFileImpl = execFileImpl;
    this.spawnImpl = spawnImpl;
  }

  environment() {
    const nodeBin = path.dirname(process.execPath);
    const inheritedPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    const allowed = ['LANG', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
    const environment = {
      HOME: process.env.HOME || os.homedir(),
      PATH: `${nodeBin}:${inheritedPath}`,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    };
    for (const key of allowed) if (process.env[key]) environment[key] = process.env[key];
    for (const [key, value] of Object.entries(process.env)) if (key.startsWith('LC_') && value) environment[key] = value;
    return environment;
  }

  run(args) {
    return new Promise((resolve, reject) => {
      this.execFileImpl(this.executable, args, { env: this.environment(), encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        let parsed;
        try { parsed = JSON.parse(stdout || stderr || '{}'); } catch { parsed = null; }
        if (error || !parsed || parsed.ok === false) {
          const wrapped = new Error('Official Lark CLI command failed.');
          wrapped.cli = parsed;
          wrapped.cause = error;
          wrapped.code = parsed && parsed.error && parsed.error.subtype === 'missing_scope' ? 'USER_SCOPE_REQUIRED' : 'USER_CLI_REQUEST_FAILED';
          wrapped.missing_scopes = parsed && parsed.error && parsed.error.missing_scopes;
          reject(wrapped);
          return;
        }
        resolve(parsed);
      });
    });
  }

  version() {
    return new Promise((resolve, reject) => {
      this.execFileImpl(this.executable, ['--version'], { env: this.environment(), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(error);
        const match = `${stdout || ''}\n${stderr || ''}`.match(/lark-cli version\s+([^\s]+)/);
        if (!match) return reject(new Error('Unable to parse official Lark CLI version.'));
        resolve(match[1]);
      });
    });
  }

  async beginDeviceFlow(scopes) {
    const payload = await this.run(['auth', 'login', '--scope', scopes.join(' '), '--no-wait', '--json']);
    const data = payload.data || payload;
    if (!data.verification_url || !data.device_code) throw new Error('Official End User Consent did not return a resumable Device Authorization flow.');
    return { verification_url: data.verification_url, device_code: data.device_code };
  }

  resumeDeviceFlow(deviceCode) {
    const child = this.spawnImpl(this.executable, ['auth', 'login', '--device-code', deviceCode, '--json'], {
      env: this.environment(), stdio: ['ignore', 'ignore', 'ignore'],
    });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error('Official End User Consent was not completed.'));
        resolve();
      });
    });
  }
}

class SharedLarkCliUserIdentity {
  constructor({ runner = new OfficialLarkCliRunner() } = {}) {
    this.runner = runner;
    this.pendingAuthorization = null;
  }

  async status() {
    const payload = await this.runner.run(['auth', 'status', '--json']);
    const state = statusFromCli(payload, REQUIRED_SCOPES);
    const missingBusinessFull = REQUIRED_BUSINESS_SCOPES.filter((scope) => !state.scopes.includes(scope));
    const optionalMissing = OPTIONAL_TIER2_SCOPES.filter((scope) => !state.scopes.includes(scope));
    let cliVersion = null;
    try { cliVersion = this.runner.version ? await this.runner.version() : CLI_VERSION; } catch { cliVersion = null; }
    return {
      ...state,
      cli_version: cliVersion,
      cli_version_expected: CLI_VERSION,
      cli_version_pinned: cliVersion === CLI_VERSION,
      profiles: {
        im_read_compatibility: { required_scopes: REQUIRED_SCOPES, missing_scopes: REQUIRED_SCOPES.filter((scope) => !state.scopes.includes(scope)) },
        sheets_read_compatibility: { required_scopes: SHEETS_READ_SCOPES, missing_scopes: SHEETS_READ_SCOPES.filter((scope) => !state.scopes.includes(scope)) },
        business_full: { required_scopes: REQUIRED_BUSINESS_SCOPES, missing_scopes: missingBusinessFull, optional_missing_scopes: optionalMissing, ready: state.refresh_capable && missingBusinessFull.length === 0 },
      },
    };
  }

  async authorizationStart() {
    const state = await this.status();
    if (!state.cli_version_pinned) throw new Error('Official Lark CLI version is not pinned to 1.0.95.');
    const canonicalScopes = REQUIRED_BUSINESS_SCOPES;
    const canonicalScopesPresent = canonicalScopes.every((scope) => state.scopes.includes(scope));
    if ((state.token_status === 'valid' || state.token_status === 'needs_refresh') && state.refresh_capable && canonicalScopesPresent) {
      return { status: 'not_required', auth: state };
    }
    if (this.pendingAuthorization) return { status: 'USER_ACTION_REQUIRED', authorization_url: this.pendingAuthorization.url, auth: state };
    const flow = await this.runner.beginDeviceFlow(canonicalScopes);
    // device_code remains only in this process's closure until the official CLI completes.
    this.pendingAuthorization = { url: flow.verification_url };
    this.runner.resumeDeviceFlow(flow.device_code).then(() => {
      this.pendingAuthorization = null;
    }).catch(() => {
      this.pendingAuthorization = null;
    });
    return { status: 'USER_ACTION_REQUIRED', authorization_url: flow.verification_url, auth: state };
  }

  async runUser(args, requiredScopes = []) {
    const state = await this.status();
    if (!state.cli_version_pinned) throw new Error('Official Lark CLI version is not pinned to 1.0.95.');
    if (state.token_status !== 'valid' && state.token_status !== 'needs_refresh') throw cliError({ auth: state });
    if (requiredScopes.length && !requiredScopes.every((scope) => state.scopes.includes(scope))) throw scopeError(state, requiredScopes);
    try {
      return redactSecrets(await this.runner.run(args));
    } catch (error) {
      const after = await this.status().catch(() => state);
      if (error && error.code === 'USER_SCOPE_REQUIRED') {
        const missing = error.missing_scopes || error.cli && error.cli.error && error.cli.error.missing_scopes || [];
        const scoped = scopeError(after, missing.length ? missing : requiredScopes);
        scoped.cli_status = redactSecrets(error.cli);
        throw scoped;
      }
      throw cliError({ auth: after, status: redactSecrets(error && error.cli) });
    }
  }

  runIm(args) {
    return this.runUser(args, REQUIRED_SCOPES);
  }

  sheetsWorkbookInfo(params = {}) {
    const args = ['sheets', '+workbook-info', '--as', 'user', '--format', 'json'];
    if (params.spreadsheet_token) args.push('--spreadsheet-token', params.spreadsheet_token); else args.push('--url', params.url);
    return this.runUser(args, SHEETS_READ_SCOPES);
  }

  sheetsCellsGet(params = {}) {
    const args = ['sheets', '+cells-get', '--as', 'user', '--format', 'json', '--range', params.range];
    if (params.spreadsheet_token) args.push('--spreadsheet-token', params.spreadsheet_token); else args.push('--url', params.url);
    if (params.sheet_id) args.push('--sheet-id', params.sheet_id); else args.push('--sheet-name', params.sheet_name);
    if (Array.isArray(params.include) && params.include.length) args.push('--include', params.include.join(','));
    if (params.skip_hidden) args.push('--skip-hidden');
    if (params.max_chars) args.push('--max-chars', String(params.max_chars));
    return this.runUser(args, SHEETS_READ_SCOPES);
  }

  sheetsCsvGet(params = {}) {
    const args = ['sheets', '+csv-get', '--as', 'user', '--format', 'json'];
    if (params.spreadsheet_token) args.push('--spreadsheet-token', params.spreadsheet_token); else args.push('--url', params.url);
    if (params.sheet_id) args.push('--sheet-id', params.sheet_id); else args.push('--sheet-name', params.sheet_name);
    if (params.range) args.push('--range', params.range);
    if (params.skip_hidden) args.push('--skip-hidden');
    if (params.max_chars) args.push('--max-chars', String(params.max_chars));
    return this.runUser(args, SHEETS_READ_SCOPES);
  }

  sheetsTableGet(params = {}) {
    const args = ['sheets', '+table-get', '--as', 'user', '--format', 'json'];
    if (params.spreadsheet_token) args.push('--spreadsheet-token', params.spreadsheet_token); else args.push('--url', params.url);
    if (params.sheet_id) args.push('--sheet-id', params.sheet_id);
    if (params.sheet_name) args.push('--sheet-name', params.sheet_name);
    if (params.range) args.push('--range', params.range);
    if (params.no_header) args.push('--no-header');
    if (params.max_chars) args.push('--max-chars', String(params.max_chars));
    return this.runUser(args, SHEETS_READ_SCOPES);
  }

  chatList(params = {}) {
    const args = ['im', '+chat-list', '--as', 'user', '--types', 'p2p,group', '--page-size', String(params.page_size || 20), '--sort', params.sort || 'create_time', '--format', 'json'];
    if (params.page_token) args.push('--page-token', params.page_token);
    if (params.page_all) args.push('--page-all', '--page-limit', String(params.page_limit || 10));
    if (params.exclude_muted) args.push('--exclude-muted');
    return this.runIm(args);
  }

  chatMessages(params = {}) {
    const args = ['im', '+chat-messages-list', '--as', 'user', '--page-size', String(params.page_size || 50), '--order', params.order || 'desc', '--no-reactions', '--format', 'json'];
    if (params.chat_id) args.push('--chat-id', params.chat_id); else args.push('--user-id', params.user_id);
    if (params.start) args.push('--start', params.start);
    if (params.end) args.push('--end', params.end);
    if (params.page_token) args.push('--page-token', params.page_token);
    if (params.page_all) args.push('--page-all', '--page-limit', String(params.page_limit || 10));
    return this.runIm(args);
  }

  messagesSearch(params = {}) {
    const args = ['im', '+messages-search', '--as', 'user', '--page-size', String(params.page_size || 20), '--no-reactions', '--format', 'json'];
    if (params.query) args.push('--query', params.query);
    if (params.sender) args.push('--sender', params.sender);
    if (params.chat_id) args.push('--chat-id', params.chat_id);
    if (params.chat_type) args.push('--chat-type', params.chat_type);
    if (params.start) args.push('--start', params.start);
    if (params.end) args.push('--end', params.end);
    if (params.page_token) args.push('--page-token', params.page_token);
    if (params.page_all) args.push('--page-all', '--page-limit', String(params.page_limit || 20));
    return this.runIm(args);
  }

  threadMessages(params = {}) {
    const args = ['im', '+threads-messages-list', '--as', 'user', '--thread', params.thread, '--page-size', String(params.page_size || 50), '--order', params.order || 'desc', '--no-reactions', '--format', 'json'];
    if (params.page_token) args.push('--page-token', params.page_token);
    if (params.page_all) args.push('--page-all', '--page-limit', String(params.page_limit || 10));
    return this.runIm(args);
  }
}

module.exports = { REFRESH_PROVIDER, REQUIRED_SCOPES, SHEETS_READ_SCOPES, BUSINESS_FULL_USER_SCOPES, REQUIRED_BUSINESS_SCOPES, OPTIONAL_TIER2_SCOPES, statusFromCli, isStrictlyLater, OfficialLarkCliRunner, SharedLarkCliUserIdentity };
