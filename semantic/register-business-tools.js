'use strict';

const { getCapability, listCapabilities } = require('../capabilities/registry.js');
const { annotationsFor } = require('../policy/confirmation.js');
const { invokeCapability, commandArgs } = require('./capability-invoker.js');
const { safeMutationReceipt } = require('../verification/post-write.js');

function ok(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function failed(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    ok: false,
    code: error && error.code || 'LARK_BUSINESS_CAPABILITY_FAILED',
    message: error && error.message || String(error),
    missing_scopes: error && error.missing_scopes,
    auth_state: error && error.auth_state,
    mutation_state: error && error.mutation_state,
    tenant_fallback_attempted: false,
    bot_fallback_attempted: false,
  }) }] };
}

function register(mcpServer, name, capability, inputSchema, handler, description) {
  mcpServer.registerTool(name, {
    title: capability ? capability.title : name,
    description: description || capability && capability.description,
    inputSchema,
    annotations: capability ? annotationsFor(capability) : name.endsWith('_auth_start')
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: capability ? {
      'lark/capabilityId': capability.id,
      'lark/confirmationTier': capability.confirmationTier,
      'lark/identity': capability.preferredIdentity,
      'lark/requiredScopes': capability.requiredScopes,
      'lark/postVerify': capability.postVerify,
    } : undefined,
  }, async (params) => {
    try { return ok(await handler(params || {})); } catch (error) { return failed(error); }
  });
}

function locatorArgs(params) {
  if (Boolean(params.spreadsheet_token) === Boolean(params.url)) throw new Error('Provide exactly one of spreadsheet_token or url.');
  return params.spreadsheet_token ? ['--spreadsheet-token', params.spreadsheet_token] : ['--url', params.url];
}

function sheetArgs(params, optional = false) {
  if (params.sheet_id && params.sheet_name) throw new Error('Provide at most one of sheet_id or sheet_name.');
  if (!optional && !params.sheet_id && !params.sheet_name) throw new Error('Provide exactly one of sheet_id or sheet_name.');
  if (params.sheet_id) return ['--sheet-id', params.sheet_id];
  if (params.sheet_name) return ['--sheet-name', params.sheet_name];
  return [];
}

function flagArgs(object, mapping = {}) {
  const args = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    const spec = mapping[key] || {};
    const flag = `--${spec.name || key.replaceAll('_', '-')}`;
    if (value === false) { if (spec.falseValue) args.push(`${flag}=false`); continue; }
    if (value === true) { args.push(flag); continue; }
    if (Array.isArray(value) && spec.repeat) { for (const item of value) args.push(flag, String(item)); continue; }
    args.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return args;
}

function readSpec(capability_id, argv) { return { capability_id, argv }; }

function registerBusinessTools(mcpServer, sharedUserIdentity, z) {
  const argvSchema = z.array(z.string().max(200000)).max(200);
  const verificationSchema = z.object({ capability_id: z.string().min(1), argv: argvSchema });

  register(mcpServer, 'lark_capability_list', null, {
    domain: z.enum(['docs', 'sheets', 'base', 'drive', 'wiki', 'im', 'permissions']).optional(),
    operation: z.enum(['read', 'write', 'destructive', 'external_send', 'permission']).optional(),
  }, async (params) => ({ ok: true, profile: 'business-full', capabilities: listCapabilities(params) }), 'List the deterministic business-full registry. Read-only; never contacts Lark.');
  register(mcpServer, 'lark_capability_get', null, { capability_id: z.string().min(1) }, async ({ capability_id }) => {
    const capability = getCapability(capability_id);
    if (!capability) throw new Error(`Unknown capability: ${capability_id}`);
    return { ok: true, capability };
  }, 'Read one business-full capability policy record. Read-only; never contacts Lark.');
  register(mcpServer, 'lark_capability_read', null, { capability_id: z.string().min(1), argv: argvSchema },
    async ({ capability_id, argv }) => invokeCapability(sharedUserIdentity, capability_id, argv, { channel: 'read' }),
    'Invoke a registry read capability under the pinned official CLI user identity. It cannot invoke writes or change identity.');

  const writeInput = {
    capability_id: z.string().min(1), argv: argvSchema,
    precondition: verificationSchema.optional(), verify: verificationSchema,
  };
  mcpServer.registerTool('lark_capability_write', {
    title: 'Invoke bounded Lark business write',
    description: 'Tier 1 only. Requires a registered read-back verifier and a precondition when the capability supports it. Never falls back from user to tenant/bot.',
    inputSchema: writeInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { 'lark/confirmationTier': 1, 'lark/identity': 'user', 'lark/postVerify': 'required' },
  }, async (params) => { try { return ok(await invokeCapability(sharedUserIdentity, params.capability_id, params.argv, { channel: 'write', precondition: params.precondition, verify: params.verify })); } catch (error) { return failed(error); } });
  mcpServer.registerTool('lark_capability_high_impact', {
    title: 'Invoke confirmed high-impact Lark capability',
    description: 'Tier 2 destructive, external-send, or permission action. The MCP client must obtain explicit user confirmation before invoking this destructiveHint surface. Read-back is mandatory and no uncertain mutation is retried.',
    inputSchema: writeInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { 'lark/confirmationTier': 2, 'lark/identity': 'user', 'lark/postVerify': 'required' },
  }, async (params) => { try { return ok(await invokeCapability(sharedUserIdentity, params.capability_id, params.argv, { channel: 'high_impact', precondition: params.precondition, verify: params.verify })); } catch (error) { return failed(error); } });

  // General auth names. Existing im_user_* names remain registered by server.js.
  register(mcpServer, 'lark_user_auth_status', null, {}, async () => ({ auth: await sharedUserIdentity.status() }), 'Read non-sensitive official CLI user credential and business-full scope status. Never returns token material.');
  register(mcpServer, 'lark_user_auth_start', null, {}, async () => sharedUserIdentity.authorizationStart(), 'Start one official End User Consent flow only when the business-full profile is missing scopes. The device code never leaves Shared MCP.');

  const spreadsheet = { spreadsheet_token: z.string().min(1).optional(), url: z.string().url().optional() };
  const sheet = { sheet_id: z.string().min(1).optional(), sheet_name: z.string().min(1).optional() };
  const spreadsheetOnlyArgs = (argv) => {
    const index = argv.findIndex((value) => value === '--spreadsheet-token' || value === '--url');
    if (index < 0 || !argv[index + 1]) throw new Error('Spreadsheet locator is missing.');
    return argv.slice(index, index + 2);
  };
  const sheetWrite = async (id, argv, verifyId, verifyArgv) => invokeCapability(sharedUserIdentity, id, argv, {
    channel: getCapability(id).confirmationTier === 2 ? 'high_impact' : 'write',
    precondition: readSpec('sheets.revision.get', spreadsheetOnlyArgs(argv)),
    verify: readSpec(verifyId, verifyArgv),
  });

  register(mcpServer, 'sheets_user_sheet_create', getCapability('sheets.sheet.create'), { ...spreadsheet, title: z.string().min(1).max(200), index: z.number().int().min(0).optional(), row_count: z.number().int().min(1).max(50000).optional(), col_count: z.number().int().min(1).max(200).optional() }, async (p) => {
    const loc = locatorArgs(p); const argv = [...loc, ...flagArgs({ title: p.title, index: p.index, row_count: p.row_count, col_count: p.col_count })];
    return sheetWrite('sheets.sheet.create', argv, 'sheets.workbook.info', loc);
  });
  register(mcpServer, 'sheets_user_sheet_copy', getCapability('sheets.sheet.copy'), { ...spreadsheet, ...sheet, title: z.string().min(1).max(200).optional(), index: z.number().int().min(0).optional() }, async (p) => {
    const loc = locatorArgs(p); const argv = [...loc, ...sheetArgs(p), ...flagArgs({ title: p.title, index: p.index })];
    return sheetWrite('sheets.sheet.copy', argv, 'sheets.workbook.info', loc);
  });
  register(mcpServer, 'sheets_user_sheet_rename', getCapability('sheets.sheet.rename'), { ...spreadsheet, ...sheet, title: z.string().min(1).max(200) }, async (p) => {
    const loc = locatorArgs(p); const argv = [...loc, ...sheetArgs(p), '--title', p.title];
    return sheetWrite('sheets.sheet.rename', argv, 'sheets.workbook.info', loc);
  });
  register(mcpServer, 'sheets_user_cells_set', getCapability('sheets.cells.set'), { ...spreadsheet, ...sheet, range: z.string().min(1).max(256), cells: z.array(z.array(z.record(z.string(), z.any()))).min(1), allow_overwrite: z.boolean().optional() }, async (p) => {
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--range', p.range, '--cells', JSON.stringify(p.cells)];
    if (p.allow_overwrite === false) argv.push('--allow-overwrite=false');
    return sheetWrite('sheets.cells.set', argv, 'sheets.cells.get', [...loc, ...sel, '--range', p.range, '--include', 'value,formula,style,data_validation']);
  });
  register(mcpServer, 'sheets_user_batch_update', getCapability('sheets.cells.batch_set'), { ...spreadsheet, writes: z.array(z.object({ sheet_id: z.string().optional(), sheet_name: z.string().optional(), range: z.string().min(1), cells: z.array(z.array(z.record(z.string(), z.any()))).min(1) })).min(1).max(100) }, async (p) => {
    const loc = locatorArgs(p); const cap = getCapability('sheets.cells.batch_set');
    const baseline = await sharedUserIdentity.runUser(commandArgs(getCapability('sheets.revision.get'), loc, false), getCapability('sheets.revision.get').requiredScopes);
    const mutation = await sharedUserIdentity.runUser(commandArgs(cap, [...loc, '--writes', JSON.stringify(p.writes)], false), cap.requiredScopes);
    const verification = [];
    for (const write of p.writes) {
      if (Boolean(write.sheet_id) === Boolean(write.sheet_name)) throw new Error('Each write must contain exactly one sheet_id or sheet_name.');
      const verifyArgs = [...loc, ...(write.sheet_id ? ['--sheet-id', write.sheet_id] : ['--sheet-name', write.sheet_name]), '--range', write.range, '--include', 'value,formula,style,data_validation'];
      verification.push(await sharedUserIdentity.runUser(commandArgs(getCapability('sheets.cells.get'), verifyArgs, false), getCapability('sheets.cells.get').requiredScopes));
    }
    return safeMutationReceipt(cap, baseline, mutation, verification);
  });
  register(mcpServer, 'sheets_user_dim_insert', getCapability('sheets.dimension.insert'), { ...spreadsheet, ...sheet, position: z.union([z.string().min(1), z.number().int().min(1)]), count: z.number().int().min(1).max(1000), inherit_style: z.enum(['before', 'after']).optional() }, async (p) => {
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--position', String(p.position), '--count', String(p.count), ...flagArgs({ inherit_style: p.inherit_style })];
    return sheetWrite('sheets.dimension.insert', argv, 'sheets.sheet.info', [...loc, ...sel]);
  });
  register(mcpServer, 'sheets_user_style_set', getCapability('sheets.cells.style_set'), { ...spreadsheet, ...sheet, range: z.string().min(1), style: z.record(z.string(), z.any()) }, async (p) => {
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--range', p.range, ...flagArgs(p.style, { border_styles: { name: 'border-styles' } })];
    return sheetWrite('sheets.cells.style_set', argv, 'sheets.cells.get', [...loc, ...sel, '--range', p.range, '--include', 'style']);
  });
  register(mcpServer, 'sheets_user_freeze_set', getCapability('sheets.freeze.set'), { ...spreadsheet, ...sheet, rows: z.number().int().min(0).max(1000), cols: z.number().int().min(0).max(1000) }, async (p) => {
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--rows', String(p.rows), '--cols', String(p.cols)];
    return sheetWrite('sheets.freeze.set', argv, 'sheets.sheet.info', [...loc, ...sel]);
  });
  register(mcpServer, 'sheets_user_validation_set', getCapability('sheets.validation.set'), { ...spreadsheet, ...sheet, range: z.string().min(1), options: z.array(z.string()).min(1).optional(), source_range: z.string().min(1).optional(), multiple: z.boolean().optional(), highlight: z.boolean().optional(), colors: z.array(z.string()).optional() }, async (p) => {
    if (Boolean(p.options) === Boolean(p.source_range)) throw new Error('Provide exactly one of options or source_range.');
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--range', p.range];
    if (p.options) argv.push('--options', JSON.stringify(p.options)); else argv.push('--source-range', p.source_range);
    if (p.multiple) argv.push('--multiple'); if (p.highlight === false) argv.push('--highlight=false'); if (p.colors) argv.push('--colors', JSON.stringify(p.colors));
    return sheetWrite('sheets.validation.set', argv, 'sheets.cells.get', [...loc, ...sel, '--range', p.range, '--include', 'data_validation']);
  });
  register(mcpServer, 'sheets_user_cells_clear', getCapability('sheets.cells.clear'), { ...spreadsheet, ...sheet, range: z.string().min(1).max(256), scope: z.enum(['content', 'formats', 'all']).optional() }, async (p) => {
    const loc = locatorArgs(p); const sel = sheetArgs(p); const argv = [...loc, ...sel, '--range', p.range, '--scope', p.scope || 'content'];
    return sheetWrite('sheets.cells.clear', argv, 'sheets.cells.get', [...loc, ...sel, '--range', p.range, '--include', 'value,formula,style']);
  });

  register(mcpServer, 'docs_user_read', getCapability('docs.document.read'), { doc: z.string().min(1), doc_format: z.enum(['xml', 'markdown', 'im-markdown']).optional(), detail: z.enum(['simple', 'with-ids', 'full']).optional() }, async (p) => invokeCapability(sharedUserIdentity, 'docs.document.read', flagArgs(p), { channel: 'read' }));
  register(mcpServer, 'docs_user_create', getCapability('docs.document.create'), { title: z.string().min(1), content: z.string().optional(), doc_format: z.enum(['xml', 'markdown']).optional(), parent_token: z.string().optional(), parent_position: z.string().optional() }, async (p) => {
    const argv = flagArgs(p); return invokeCapability(sharedUserIdentity, 'docs.document.create', argv, { channel: 'write', verify: readSpec('drive.search', ['--query', p.title, '--doc-types', 'docx', '--page-size', '20']) });
  });
  register(mcpServer, 'docs_user_update', getCapability('docs.document.update'), { doc: z.string().min(1), command: z.enum(['str_replace', 'block_delete', 'block_insert_after', 'block_copy_insert_after', 'block_replace', 'block_move_after', 'overwrite', 'append']), content: z.string().optional(), pattern: z.string().optional(), block_id: z.string().optional(), revision_id: z.number().int().optional(), doc_format: z.enum(['xml', 'markdown']).optional() }, async (p) => {
    const argv = flagArgs(p); return invokeCapability(sharedUserIdentity, 'docs.document.update', argv, { channel: 'write', precondition: readSpec('docs.document.read', ['--doc', p.doc, '--detail', 'with-ids']), verify: readSpec('docs.document.read', ['--doc', p.doc, '--detail', 'with-ids']) });
  });

  const baseLoc = { base_token: z.string().min(1), table_id: z.string().min(1) };
  for (const [name, id] of [['base_user_record_get', 'base.record.get'], ['base_user_record_list', 'base.record.list'], ['base_user_record_search', 'base.record.search']]) {
    register(mcpServer, name, getCapability(id), { ...baseLoc, record_id: z.array(z.string()).optional(), keyword: z.string().optional(), search_field: z.array(z.string()).optional(), limit: z.number().int().min(1).max(200).optional() }, async (p) => invokeCapability(sharedUserIdentity, id, flagArgs(p, { record_id: { repeat: true }, search_field: { repeat: true } }), { channel: 'read' }));
  }
  register(mcpServer, 'base_user_record_create', getCapability('base.record.create'), { ...baseLoc, fields: z.record(z.string(), z.any()) }, async (p) => invokeCapability(sharedUserIdentity, 'base.record.create', ['--base-token', p.base_token, '--table-id', p.table_id, '--json', JSON.stringify(p.fields)], { channel: 'write', verify: readSpec('base.record.list', ['--base-token', p.base_token, '--table-id', p.table_id, '--limit', '10']) }));
  register(mcpServer, 'base_user_record_update', getCapability('base.record.update'), { ...baseLoc, record_id: z.string().min(1), fields: z.record(z.string(), z.any()) }, async (p) => invokeCapability(sharedUserIdentity, 'base.record.update', ['--base-token', p.base_token, '--table-id', p.table_id, '--record-id', p.record_id, '--json', JSON.stringify(p.fields)], { channel: 'write', precondition: readSpec('base.record.get', ['--base-token', p.base_token, '--table-id', p.table_id, '--record-id', p.record_id]), verify: readSpec('base.record.get', ['--base-token', p.base_token, '--table-id', p.table_id, '--record-id', p.record_id]) }));
  register(mcpServer, 'base_user_record_batch_update', getCapability('base.record.batch_update'), { ...baseLoc, update_records: z.record(z.string(), z.record(z.string(), z.any())) }, async (p) => invokeCapability(sharedUserIdentity, 'base.record.batch_update', ['--base-token', p.base_token, '--table-id', p.table_id, '--json', JSON.stringify({ update_records: p.update_records })], { channel: 'write', precondition: readSpec('base.record.get', ['--base-token', p.base_token, '--table-id', p.table_id, ...Object.keys(p.update_records).flatMap((id) => ['--record-id', id])]), verify: readSpec('base.record.get', ['--base-token', p.base_token, '--table-id', p.table_id, ...Object.keys(p.update_records).flatMap((id) => ['--record-id', id])]) }));

  register(mcpServer, 'drive_user_search', getCapability('drive.search'), { query: z.string().max(30).optional(), doc_types: z.string().optional(), page_size: z.number().int().min(1).max(20).optional(), page_token: z.string().optional(), sort: z.string().optional() }, async (p) => invokeCapability(sharedUserIdentity, 'drive.search', flagArgs(p), { channel: 'read' }));
  register(mcpServer, 'drive_user_inspect', getCapability('drive.inspect'), { url: z.string().min(1), type: z.string().optional() }, async (p) => invokeCapability(sharedUserIdentity, 'drive.inspect', flagArgs(p), { channel: 'read' }));
  register(mcpServer, 'drive_user_copy', getCapability('drive.file.copy'), { url: z.string().optional(), token: z.string().optional(), type: z.string().optional(), folder_token: z.string().min(1), name: z.string().optional() }, async (p) => invokeCapability(sharedUserIdentity, 'drive.file.copy', flagArgs(p), { channel: 'write', verify: readSpec('drive.search', ['--query', p.name || '', '--page-size', '20']) }));
  register(mcpServer, 'drive_user_move', getCapability('drive.file.move'), { file_token: z.string().min(1), folder_token: z.string().min(1), type: z.string().min(1) }, async (p) => invokeCapability(sharedUserIdentity, 'drive.file.move', flagArgs(p), { channel: 'write', precondition: readSpec('drive.inspect', ['--url', p.file_token, '--type', p.type]), verify: readSpec('drive.inspect', ['--url', p.file_token, '--type', p.type]) }));
  register(mcpServer, 'drive_user_rename', getCapability('drive.file.rename'), { url: z.string().optional(), token: z.string().optional(), type: z.string().optional(), title: z.string().min(1) }, async (p) => {
    const target = p.url || p.token; const read = ['--url', target, ...(p.type ? ['--type', p.type] : [])];
    return invokeCapability(sharedUserIdentity, 'drive.file.rename', flagArgs(p), { channel: 'write', precondition: readSpec('drive.inspect', read), verify: readSpec('drive.inspect', read) });
  });

  for (const [name, id] of [['wiki_user_node_get', 'wiki.node.get'], ['wiki_user_node_list', 'wiki.node.list']]) register(mcpServer, name, getCapability(id), z.record(z.string(), z.any()), async (p) => invokeCapability(sharedUserIdentity, id, flagArgs(p), { channel: 'read' }));
  register(mcpServer, 'wiki_user_node_create', getCapability('wiki.node.create'), z.record(z.string(), z.any()), async (p) => invokeCapability(sharedUserIdentity, 'wiki.node.create', flagArgs(p), { channel: 'write', verify: readSpec('wiki.node.list', ['--space-id', p.space_id, ...(p.parent_node_token ? ['--parent-node-token', p.parent_node_token] : [])]) }));
  register(mcpServer, 'wiki_user_node_move', getCapability('wiki.node.move'), z.record(z.string(), z.any()), async (p) => invokeCapability(sharedUserIdentity, 'wiki.node.move', flagArgs(p), { channel: 'write', precondition: readSpec('wiki.node.get', ['--node-token', p.node_token]), verify: readSpec('wiki.node.get', ['--node-token', p.node_token]) }));
  register(mcpServer, 'wiki_user_node_rename', getCapability('wiki.node.rename'), { url: z.string().min(1), title: z.string().min(1) }, async (p) => invokeCapability(sharedUserIdentity, 'wiki.node.rename', ['--url', p.url, '--title', p.title], { channel: 'write', precondition: readSpec('wiki.node.get', ['--node-token', p.url]), verify: readSpec('wiki.node.get', ['--node-token', p.url]) }));

  const messageSchema = { text: z.string().optional(), markdown: z.string().optional(), content: z.string().optional(), idempotency_key: z.string().min(1).max(50) };
  register(mcpServer, 'im_user_message_send', getCapability('im.message.send'), { ...messageSchema, chat_id: z.string().optional(), user_id: z.string().optional() }, async (p) => invokeCapability(sharedUserIdentity, 'im.message.send', flagArgs(p), { channel: 'high_impact', verify: readSpec('im.chat.messages.list', [...(p.chat_id ? ['--chat-id', p.chat_id] : ['--user-id', p.user_id]), '--page-size', '5', '--order', 'desc', '--no-reactions']) }));
  register(mcpServer, 'im_user_message_reply', getCapability('im.message.reply'), { ...messageSchema, message_id: z.string().min(1), reply_in_thread: z.boolean().optional() }, async (p) => invokeCapability(sharedUserIdentity, 'im.message.reply', flagArgs(p), { channel: 'high_impact', verify: readSpec('im.thread.messages.list', ['--thread', p.message_id, '--page-size', '10', '--order', 'desc', '--no-reactions']) }));
}

module.exports = { registerBusinessTools, flagArgs, locatorArgs, sheetArgs, failed };
