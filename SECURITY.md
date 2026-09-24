# Security

Please report a security issue privately through GitHub's vulnerability reporting for this repository. Do not put tokens, app secrets, private keys, user data, or reproduction logs containing them in a public issue.

The official Lark CLI owns End User Consent credentials on each machine. This component invokes its documented command interface and returns only non-sensitive auth status. The installer verifies the pinned official CLI archive digest, keeps runtime files under component-owned Application Support, and changes only its own Cursor/Codex MCP entries. It does not remove Keychain credentials on uninstall.

The MCP binds to `127.0.0.1`. Treat anyone with local access to that endpoint as able to invoke tools allowed by the authorized user and the component's confirmation policy. Tier 2 actions use a separate high-impact surface and require explicit user confirmation by the client.
