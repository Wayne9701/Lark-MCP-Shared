#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'coverage', '.runtime']);
const names = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in public tree: ${path.relative(root, file)}`);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) names.push(file);
  }
}
walk(root);
const hostname = os.hostname().split('.')[0];
const rules = [
  ['absolute user path', /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/],
  ['private home path', /\/private\/var\/folders\/[A-Za-z0-9/_-]+/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential assignment', /(?:access[_-]?token|refresh[_-]?token|app[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9._-]{20,}["']/i],
  ['internal acceptance report', new RegExp(`${['LARK', 'MCP', 'BUSINESS', 'FULL'].join('_')}_(?:EXTERNAL_)?ACCEPTANCE_CLOSEOUT|${['LARK', 'MCP', '00E', 'BINDING', 'AND', 'TIER1', 'REPORT'].join('_')}`)],
  ['personal workspace', /AI_OS\/(?:报告和经营|实验室|Memory)|Documents\/Codex\/Memory|Documents\/Codex\/Knowledge/],
];
const failures = [];
for (const file of names) {
  const relative = path.relative(root, file);
  const content = fs.readFileSync(file);
  if (content.includes(0)) { failures.push({ file: relative, rule: 'binary file' }); continue; }
  const value = content.toString('utf8');
  for (const [label, re] of rules) if (re.test(value)) failures.push({ file: relative, rule: label });
  if (hostname.length >= 6 && value.includes(hostname)) failures.push({ file: relative, rule: 'local hostname' });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies || {}).some((name) => name === '@larksuiteoapi/lark-mcp')) failures.push({ file: 'package.json', rule: 'upstream runtime dependency' });
for (const file of ['server.js', 'user-semantic-tools.js']) {
  const value = fs.readFileSync(path.join(root, file), 'utf8');
  if (/authStore|LarkAuthHandlerLocal|initOAPIMcpServer|CODEX_CONFIG_PATH|appSecret/.test(value)) failures.push({ file, rule: 'legacy runtime auth dependency' });
}
console.log(JSON.stringify({ ok: failures.length === 0, scanned_files: names.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
