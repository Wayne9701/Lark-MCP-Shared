# Lark MCP Shared

A macOS localhost MCP service that exposes a stable set of Lark/Feishu business tools to Cursor, Codex, and other Streamable HTTP MCP clients. Localink can discover its read tools through its existing external MCP bridge; that bridge keeps its own read-only policy.

## Public contract

Both `http://127.0.0.1:33332/mcp` and `http://127.0.0.1:33332/mcp/cursor` expose the same 48 tools: 39 stable semantic tools plus nine auth/capability registry tools. The registry describes 108 capabilities. Tier 0 reads, Tier 1 writes with precondition and read-back, and the explicit Tier 2 high-impact surface retain their policy checks. User identity never silently falls back to tenant or bot identity. An uncertain write is never retried automatically.

Earlier private deployments also exposed raw upstream OpenAPI MCP tools. Those raw tools are **not** part of this portable public contract; their names and counts are not promised here. The CLI-native service has no runtime dependency on the upstream MCP server, Codex configuration, an app secret, or the upstream OAuth store.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22 or newer, with npm available
- Internet access during first installation and updates for npm dependencies and the pinned official CLI archive
- A Lark/Feishu developer application configured through the official CLI for user authorization

## Install

Clone the repository and run one of:

```sh
node installer/cli.js install --client cursor --json
node installer/cli.js install --client codex --json
node installer/cli.js install --client cursor --client codex --json
node installer/cli.js install --json
```

The last command installs the service without binding a client. A missing client configuration is created only when that client is explicitly selected. Existing configs are backed up and patched only at the `lark-mcp-shared` entry. The service runs from an immutable release under `~/Library/Application Support/Lark-MCP-Shared/app/`, not from the clone. Its LaunchAgent uses the Node executable that ran the installer. The official `lark-cli` v1.0.95 binary is downloaded for the machine architecture from the [official release](https://github.com/larksuite/cli/releases/tag/v1.0.95), checked against a pinned SHA-256, and installed under component-owned runtime storage.

The installer does not sign in or copy any credential. On each machine, configure the official CLI interactively and authorize the end user:

```sh
"$HOME/Library/Application Support/Lark-MCP-Shared/runtime/lark-cli/1.0.95/lark-cli" config init
"$HOME/Library/Application Support/Lark-MCP-Shared/runtime/lark-cli/1.0.95/lark-cli" auth status --json
```

Use the MCP `lark_user_auth_start` tool to request the required business scopes after CLI configuration; `lark_user_auth_status` reports safe readiness metadata. The start tool exposes a device authorization URL. A device code stays inside the service and official CLI process. Access and refresh tokens and the app secret are never returned by this MCP. `im:message.send_as_user` is an optional Tier 2 permission; its absence does not block the core read and verified write contract.

## Maintain

```sh
node installer/cli.js doctor --json
node installer/cli.js update --json
node installer/cli.js rollback --json
node installer/cli.js uninstall --client cursor --json
node installer/cli.js uninstall --json
```

`update` stages and validates a new release, then activates it. `rollback` switches to the previous installed release without downloading anything. `uninstall --client` unbinds only the selected client; bare `uninstall` removes component-owned service files and managed client entries. It leaves official CLI Keychain credentials untouched. Use the official CLI's separate logout command if credential removal is intended.

## Security and development

The service binds to localhost. Client configuration backups stay on the user's machine with restrictive file permissions. Public source and tests contain only synthetic fixtures. Tests use temporary homes and ports, a fake CLI for auth/business operations, and no live Lark writes. `npm run test:isolated-install` additionally downloads or verifies the pinned official CLI archive, installs into a temporary home, and starts a foreground test server without calling real auth.

```sh
npm ci --ignore-scripts
npm test
npm run scan
npm run test:isolated-install
```

See [SECURITY.md](SECURITY.md) for reporting and credential handling.
