'use strict';

const CLI_VERSION = '1.0.95';
const PROFILE = 'business-full';

function capability(id, domain, backendTool, operation, confirmationTier, requiredScopes, options = {}) {
  return Object.freeze({
    id,
    domain,
    title: options.title || id,
    description: options.description || `${backendTool} via the pinned official Lark CLI`,
    backend: options.backend || 'official_cli_shortcut',
    backendTool,
    operation,
    confirmationTier,
    identity: options.identity || ['user', 'bot'],
    preferredIdentity: options.preferredIdentity || 'user',
    requiredScopes: Object.freeze([...requiredScopes]),
    reversible: options.reversible || (operation === 'read' ? 'yes' : 'partial'),
    supportsPrecondition: Boolean(options.supportsPrecondition),
    postVerify: options.postVerify || (operation === 'read' ? 'none' : 'read_back'),
    profile: Object.freeze(options.profile || [PROFILE]),
    publicSemantic: Boolean(options.publicSemantic),
    semanticTool: options.semanticTool || null,
    availability: options.availability || 'available',
    version: options.version || { cli: CLI_VERSION },
  });
}

const r = [];
const add = (...args) => r.push(capability(...args));

// Sheets: required scope declarations are copied from official lark-cli v1.0.95
// shortcut metadata. Read and write scopes intentionally remain distinct.
add('sheets.workbook.info', 'sheets', 'sheets +workbook-info', 'read', 0, ['sheets:spreadsheet:read'], { publicSemantic: true, semanticTool: 'sheets_user_workbook_info' });
add('sheets.cells.get', 'sheets', 'sheets +cells-get', 'read', 0, ['sheets:spreadsheet:read'], { publicSemantic: true, semanticTool: 'sheets_user_cells_get' });
add('sheets.csv.get', 'sheets', 'sheets +csv-get', 'read', 0, ['sheets:spreadsheet:read'], { publicSemantic: true, semanticTool: 'sheets_user_csv_get' });
add('sheets.table.get', 'sheets', 'sheets +table-get', 'read', 0, ['sheets:spreadsheet:read'], { publicSemantic: true, semanticTool: 'sheets_user_table_get' });
add('sheets.sheet.info', 'sheets', 'sheets +sheet-info', 'read', 0, ['sheets:spreadsheet:read']);
add('sheets.revision.get', 'sheets', 'sheets +revision-get', 'read', 0, ['sheets:spreadsheet:read']);
add('sheets.changeset.get', 'sheets', 'sheets +changeset-get', 'read', 0, ['sheets:spreadsheet:read']);
add('sheets.dropdown.get', 'sheets', 'sheets +dropdown-get', 'read', 0, ['sheets:spreadsheet:read']);
add('sheets.history.list', 'sheets', 'sheets +history-list', 'read', 0, ['sheets:spreadsheet:read']);
add('sheets.sheet.create', 'sheets', 'sheets +sheet-create', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_sheet_create', supportsPrecondition: true, postVerify: 'workbook_info' });
add('sheets.sheet.copy', 'sheets', 'sheets +sheet-copy', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_sheet_copy', supportsPrecondition: true, postVerify: 'workbook_info' });
add('sheets.sheet.rename', 'sheets', 'sheets +sheet-rename', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_sheet_rename', supportsPrecondition: true, postVerify: 'workbook_info' });
add('sheets.cells.set', 'sheets', 'sheets +cells-set', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_cells_set', supportsPrecondition: true, postVerify: 'read_range' });
add('sheets.cells.batch_set', 'sheets', 'sheets +cells-set', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_batch_update', supportsPrecondition: true, postVerify: 'read_ranges' });
add('sheets.dimension.insert', 'sheets', 'sheets +dim-insert', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_dim_insert', supportsPrecondition: true, postVerify: 'sheet_info' });
add('sheets.cells.style_set', 'sheets', 'sheets +cells-set-style', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_style_set', supportsPrecondition: true, postVerify: 'read_style' });
add('sheets.freeze.set', 'sheets', 'sheets +dim-freeze', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_freeze_set', supportsPrecondition: true, postVerify: 'sheet_info' });
add('sheets.validation.set', 'sheets', 'sheets +dropdown-set', 'write', 1, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_validation_set', supportsPrecondition: true, postVerify: 'read_validation' });
add('sheets.table.put', 'sheets', 'sheets +table-put', 'write', 1, ['sheets:spreadsheet:read', 'sheets:spreadsheet:write_only'], { supportsPrecondition: true, postVerify: 'table_get' });
for (const [id, tool] of [
  ['sheets.range.copy', '+range-copy'], ['sheets.range.move', '+range-move'], ['sheets.range.fill', '+range-fill'],
  ['sheets.range.sort', '+range-sort'], ['sheets.rows.resize', '+rows-resize'], ['sheets.columns.resize', '+cols-resize'],
  ['sheets.cells.merge', '+cells-merge'], ['sheets.cells.unmerge', '+cells-unmerge'], ['sheets.sheet.move', '+sheet-move'],
  ['sheets.sheet.hide', '+sheet-hide'], ['sheets.sheet.unhide', '+sheet-unhide'],
]) add(id, 'sheets', `sheets ${tool}`, 'write', 1, ['sheets:spreadsheet:write_only'], { supportsPrecondition: true });
add('sheets.workbook.create', 'sheets', 'sheets +workbook-create', 'write', 1, ['sheets:spreadsheet:create', 'sheets:spreadsheet:write_only'], { postVerify: 'workbook_info' });
add('sheets.workbook.import', 'sheets', 'sheets +workbook-import', 'write', 1, ['docs:document.media:upload', 'docs:document:import'], { postVerify: 'workbook_info' });
add('sheets.cells.clear', 'sheets', 'sheets +cells-clear', 'destructive', 2, ['sheets:spreadsheet:write_only'], { publicSemantic: true, semanticTool: 'sheets_user_cells_clear', supportsPrecondition: true, reversible: 'partial', postVerify: 'read_range' });
add('sheets.dimension.delete', 'sheets', 'sheets +dim-delete', 'destructive', 2, ['sheets:spreadsheet:write_only'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'sheet_info' });
add('sheets.sheet.delete', 'sheets', 'sheets +sheet-delete', 'destructive', 2, ['sheets:spreadsheet:write_only'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'workbook_info' });
add('sheets.history.revert', 'sheets', 'sheets +history-revert', 'destructive', 2, ['sheets:spreadsheet:write_only'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'revision' });

// Docs.
add('docs.document.read', 'docs', 'docs +fetch', 'read', 0, ['docx:document:readonly'], { publicSemantic: true, semanticTool: 'docs_user_read' });
add('docs.history.list', 'docs', 'docs +history-list', 'read', 0, ['docx:document:readonly']);
add('docs.document.create', 'docs', 'docs +create', 'write', 1, ['docx:document:create'], { publicSemantic: true, semanticTool: 'docs_user_create', postVerify: 'docs_fetch' });
add('docs.document.update', 'docs', 'docs +update', 'write', 1, ['docx:document:write_only', 'docx:document:readonly'], { publicSemantic: true, semanticTool: 'docs_user_update', supportsPrecondition: true, postVerify: 'docs_fetch' });
add('docs.media.insert', 'docs', 'docs +media-insert', 'write', 1, ['docs:document.media:upload', 'docx:document:write_only', 'docx:document:readonly'], { postVerify: 'docs_fetch' });
add('docs.history.revert', 'docs', 'docs +history-revert', 'destructive', 2, ['docx:document:write_only', 'docx:document:readonly'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'docs_fetch' });

// Base. Structural deletes and permission/role changes are intentionally Tier 2.
for (const [id, tool, scopes] of [
  ['base.table.get', '+table-get', ['base:table:read', 'base:field:read', 'base:view:read']],
  ['base.table.list', '+table-list', ['base:table:read']], ['base.field.get', '+field-get', ['base:field:read']],
  ['base.field.list', '+field-list', ['base:field:read']], ['base.view.get', '+view-get', ['base:view:read']],
  ['base.view.list', '+view-list', ['base:view:read']], ['base.record.get', '+record-get', ['base:record:read']],
  ['base.record.list', '+record-list', ['base:record:read']], ['base.record.search', '+record-search', ['base:record:read']],
  ['base.role.list', '+role-list', ['base:role:read']],
]) add(id, 'base', `base ${tool}`, 'read', 0, scopes, { publicSemantic: id.startsWith('base.record.'), semanticTool: id.startsWith('base.record.') ? `base_user_${id.split('.').slice(1).join('_')}` : null });
add('base.record.create', 'base', 'base +record-upsert', 'write', 1, ['base:record:create', 'base:record:update'], { publicSemantic: true, semanticTool: 'base_user_record_create', postVerify: 'record_get' });
add('base.record.update', 'base', 'base +record-upsert', 'write', 1, ['base:record:create', 'base:record:update'], { publicSemantic: true, semanticTool: 'base_user_record_update', supportsPrecondition: true, postVerify: 'record_get' });
add('base.record.batch_create', 'base', 'base +record-batch-create', 'write', 1, ['base:record:create'], { postVerify: 'record_get' });
add('base.record.batch_update', 'base', 'base +record-batch-update', 'write', 1, ['base:record:update'], { publicSemantic: true, semanticTool: 'base_user_record_batch_update', supportsPrecondition: true, postVerify: 'record_get' });
for (const [id, tool, scopes] of [
  ['base.table.create', '+table-create', ['base:table:create', 'base:field:read', 'base:field:create', 'base:field:update', 'base:view:write_only']],
  ['base.table.copy', '+table-copy', ['base:table:create']], ['base.table.update', '+table-update', ['base:table:update']],
  ['base.field.create', '+field-create', ['base:field:create']], ['base.view.create', '+view-create', ['base:view:write_only']],
  ['base.view.rename', '+view-rename', ['base:view:write_only']],
]) add(id, 'base', `base ${tool}`, 'write', 1, scopes, { supportsPrecondition: !id.endsWith('.create'), postVerify: 'metadata_read' });
for (const [id, tool, scopes, op] of [
  ['base.record.delete', '+record-delete', ['base:record:delete'], 'destructive'], ['base.table.delete', '+table-delete', ['base:table:delete'], 'destructive'],
  ['base.field.update', '+field-update', ['base:field:update'], 'destructive'], ['base.field.delete', '+field-delete', ['base:field:delete'], 'destructive'],
  ['base.view.delete', '+view-delete', ['base:view:write_only'], 'destructive'], ['base.role.create', '+role-create', ['base:role:create'], 'permission'],
  ['base.role.update', '+role-update', ['base:role:update'], 'permission'], ['base.role.delete', '+role-delete', ['base:role:delete'], 'permission'],
]) add(id, 'base', `base ${tool}`, op, 2, scopes, { supportsPrecondition: true, reversible: 'partial', postVerify: 'metadata_read' });

// Drive and permissions.
add('drive.search', 'drive', 'drive +search', 'read', 0, ['search:docs:read'], { publicSemantic: true, semanticTool: 'drive_user_search' });
add('drive.inspect', 'drive', 'drive +inspect', 'read', 0, ['drive:drive.metadata:readonly'], { publicSemantic: true, semanticTool: 'drive_user_inspect' });
add('drive.comments.list', 'drive', 'drive +list-comments', 'read', 0, ['docs:document.comment:read']);
add('drive.version.history', 'drive', 'drive +version-history', 'read', 0, ['drive:file:download']);
add('drive.file.download', 'drive', 'drive +download', 'read', 0, ['drive:file:download']);
add('drive.document.export', 'drive', 'drive +export', 'read', 0, ['docs:document.content:read', 'docs:document:export', 'docx:document:readonly', 'drive:drive.metadata:readonly']);
add('drive.file.copy', 'drive', 'drive +copy', 'write', 1, ['docs:document:copy'], { publicSemantic: true, semanticTool: 'drive_user_copy', postVerify: 'drive_inspect' });
add('drive.file.move', 'drive', 'drive +move', 'write', 1, ['space:document:move'], { publicSemantic: true, semanticTool: 'drive_user_move', supportsPrecondition: true, postVerify: 'drive_inspect' });
add('drive.file.rename', 'drive', 'drive +update-title', 'write', 1, ['drive:file:upload', 'drive:drive.metadata:readonly'], { publicSemantic: true, semanticTool: 'drive_user_rename', supportsPrecondition: true, postVerify: 'drive_inspect' });
add('drive.file.upload', 'drive', 'drive +upload', 'write', 1, ['drive:file:upload', 'drive:drive.metadata:readonly'], { postVerify: 'drive_inspect' });
add('drive.document.import', 'drive', 'drive +import', 'write', 1, ['docs:document.media:upload', 'docs:document:import'], { postVerify: 'drive_inspect' });
add('drive.folder.create', 'drive', 'drive +create-folder', 'write', 1, ['space:folder:create'], { postVerify: 'drive_inspect' });
add('drive.comment.add', 'drive', 'drive +add-comment', 'write', 1, ['drive:drive.metadata:readonly', 'docx:document:readonly', 'docs:document.comment:create', 'docs:document.comment:write_only'], { postVerify: 'comments_list' });
add('drive.version.revert', 'drive', 'drive +version-revert', 'destructive', 2, ['drive:file:upload'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'version_history' });
add('drive.file.delete', 'drive', 'drive +delete', 'destructive', 2, ['space:document:delete', 'drive:drive.metadata:readonly'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'drive_inspect' });
add('permissions.settings.get', 'permissions', 'drive +permission-get-setting', 'read', 0, ['docs:permission.setting:read']);
add('permissions.members.list', 'permissions', 'drive +member-list', 'read', 0, ['docs:permission.member:retrieve']);
add('permissions.member.add', 'permissions', 'drive +member-add', 'permission', 2, ['docs:permission.member:create'], { supportsPrecondition: true, reversible: 'yes', postVerify: 'permission_members' });
add('permissions.member.remove', 'permissions', 'drive +member-remove', 'permission', 2, ['docs:permission.member:delete'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'permission_members' });
add('permissions.public.patch', 'permissions', 'drive permission.public patch', 'permission', 2, ['docs:permission.setting:write_only'], { backend: 'official_cli_api', supportsPrecondition: true, reversible: 'partial', postVerify: 'permission_settings' });
add('permissions.owner.transfer', 'permissions', 'drive permission.members transfer_owner', 'permission', 2, ['docs:permission.member:transfer'], { backend: 'official_cli_api', supportsPrecondition: true, reversible: 'no', postVerify: 'permission_members' });

// Wiki.
add('wiki.space.list', 'wiki', 'wiki +space-list', 'read', 0, ['wiki:space:retrieve']);
add('wiki.node.get', 'wiki', 'wiki +node-get', 'read', 0, ['wiki:node:retrieve'], { publicSemantic: true, semanticTool: 'wiki_user_node_get' });
add('wiki.node.list', 'wiki', 'wiki +node-list', 'read', 0, ['wiki:node:retrieve'], { publicSemantic: true, semanticTool: 'wiki_user_node_list' });
add('wiki.member.list', 'wiki', 'wiki +member-list', 'read', 0, ['wiki:member:retrieve']);
add('wiki.node.create', 'wiki', 'wiki +node-create', 'write', 1, ['wiki:node:create', 'wiki:node:read', 'wiki:space:read'], { publicSemantic: true, semanticTool: 'wiki_user_node_create', postVerify: 'wiki_node_get' });
add('wiki.node.move', 'wiki', 'wiki +move', 'write', 1, ['wiki:node:move', 'wiki:node:read', 'wiki:space:read'], { publicSemantic: true, semanticTool: 'wiki_user_node_move', supportsPrecondition: true, postVerify: 'wiki_node_get' });
add('wiki.node.rename', 'wiki', 'drive +update-title', 'write', 1, ['drive:file:upload'], { publicSemantic: true, semanticTool: 'wiki_user_node_rename', supportsPrecondition: true, postVerify: 'wiki_node_get' });
add('wiki.node.copy', 'wiki', 'wiki +node-copy', 'destructive', 2, ['wiki:node:copy'], { reversible: 'yes', postVerify: 'wiki_node_get' });
add('wiki.node.delete', 'wiki', 'wiki +node-delete', 'destructive', 2, ['wiki:node:create', 'wiki:node:retrieve'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'wiki_node_get' });
add('wiki.member.add', 'wiki', 'wiki +member-add', 'permission', 2, ['wiki:member:create'], { supportsPrecondition: true, reversible: 'yes', postVerify: 'wiki_member_list' });
add('wiki.member.remove', 'wiki', 'wiki +member-remove', 'permission', 2, ['wiki:member:update'], { supportsPrecondition: true, reversible: 'partial', postVerify: 'wiki_member_list' });

// IM read compatibility and Tier-2 outbound messaging.
for (const [id, tool, semanticTool] of [
  ['im.chat.list', 'im +chat-list', 'im_user_chat_list'], ['im.chat.messages.list', 'im +chat-messages-list', 'im_user_chat_messages_list'],
  ['im.messages.search', 'im +messages-search', 'im_user_messages_search'], ['im.thread.messages.list', 'im +threads-messages-list', 'im_user_thread_messages_list'],
]) add(id, 'im', tool, 'read', 0, ['im:chat:read', 'im:message:readonly', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user', 'search:message'], { identity: ['user'], publicSemantic: true, semanticTool });
add('im.message.send', 'im', 'im +messages-send', 'external_send', 2, ['im:message.send_as_user', 'im:message'], { identity: ['user'], publicSemantic: true, semanticTool: 'im_user_message_send', reversible: 'no', postVerify: 'message_receipt' });
add('im.message.reply', 'im', 'im +messages-reply', 'external_send', 2, ['im:message.send_as_user', 'im:message'], { identity: ['user'], publicSemantic: true, semanticTool: 'im_user_message_reply', reversible: 'no', postVerify: 'message_receipt' });

const CAPABILITIES = Object.freeze(r);
const BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

function getCapability(id) { return BY_ID.get(id) || null; }
function listCapabilities({ domain, operation, profile = PROFILE, publicSemantic } = {}) {
  return CAPABILITIES.filter((item) => (!domain || item.domain === domain)
    && (!operation || item.operation === operation)
    && (!profile || item.profile.includes(profile))
    && (publicSemantic === undefined || item.publicSemantic === publicSemantic));
}
function businessFullScopes(identity = 'user') {
  return [...new Set(listCapabilities().filter((item) => item.identity.includes(identity)).flatMap((item) => item.requiredScopes))].sort();
}

module.exports = { CLI_VERSION, PROFILE, CAPABILITIES, getCapability, listCapabilities, businessFullScopes };
