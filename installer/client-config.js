'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'lark-mcp-shared';
const CODEX_HEADER = '[mcp_servers."lark-mcp-shared"]';
function endpoint(port, client) { return `http://127.0.0.1:${port}${client === 'cursor' ? '/mcp/cursor' : '/mcp'}`; }
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600); }
  finally { fs.rmSync(temp, { force: true }); }
}
function cursorPatch(text, port, remove = false) {
  const config = text ? JSON.parse(text) : {};
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Cursor MCP config must be a JSON object.');
  if (remove && config.mcpServers === undefined) return text;
  if (config.mcpServers === undefined) config.mcpServers = {};
  if (!config.mcpServers || Array.isArray(config.mcpServers) || typeof config.mcpServers !== 'object') throw new Error('Cursor mcpServers must be an object.');
  const expected = endpoint(port, 'cursor');
  const existing = config.mcpServers[NAME];
  if (remove) {
    if (!existing || existing.url !== expected) return text;
    delete config.mcpServers[NAME];
  } else {
    config.mcpServers[NAME] = { url: expected };
  }
  return JSON.stringify(config, null, 2) + '\n';
}
function sectionRange(lines) {
  const start = lines.findIndex((line) => line.trim() === CODEX_HEADER);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[+[^\]]+\]+\s*(?:#.*)?$/.test(lines[end])) end += 1;
  return { start, end };
}
function codexPatch(text, port, remove = false) {
  const lines = text ? text.split('\n') : [];
  const bounds = sectionRange(lines);
  const expected = endpoint(port, 'codex');
  if (remove) {
    if (!bounds) return text;
    const body = lines.slice(bounds.start, bounds.end).join('\n');
    if (!new RegExp(`^\\s*url\\s*=\\s*"${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*$`, 'm').test(body)) return text;
    lines.splice(bounds.start, bounds.end - bounds.start);
    return lines.join('\n');
  }
  if (bounds) lines.splice(bounds.start, bounds.end - bounds.start);
  const base = lines.join('\n').trimEnd();
  return `${base}${base ? '\n\n' : ''}${CODEX_HEADER}\nurl = "${expected}"\n`;
}
function configPath(home, client) {
  if (client === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  if (client === 'codex') return path.join(home, '.codex', 'config.toml');
  throw new Error(`Unknown client: ${client}`);
}
function backupFile(file, backupRoot, client) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(backupRoot, `${client}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bak`);
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  return backup;
}
function patchClient(home, client, port, backupRoot, remove = false) {
  const file = configPath(home, client);
  const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (remove && prior === null) return { client, changed: false, file, backup: null };
  const next = client === 'cursor' ? cursorPatch(prior, port, remove) : codexPatch(prior, port, remove);
  if (next === prior) return { client, changed: false, file, backup: null };
  const backup = backupFile(file, backupRoot, client);
  atomicWrite(file, next);
  return { client, changed: true, file, backup, prior, written_sha256: crypto.createHash('sha256').update(next).digest('hex') };
}
function restorePatch(patch) {
  if (!patch || !patch.changed) return;
  if (!fs.existsSync(patch.file)) return;
  const current = crypto.createHash('sha256').update(fs.readFileSync(patch.file)).digest('hex');
  if (current !== patch.written_sha256) throw new Error(`Refusing to overwrite a subsequently modified ${patch.client} config.`);
  if (patch.prior === null) fs.rmSync(patch.file);
  else atomicWrite(patch.file, patch.prior);
}

module.exports = { NAME, CODEX_HEADER, endpoint, atomicWrite, cursorPatch, codexPatch, configPath, patchClient, restorePatch };
