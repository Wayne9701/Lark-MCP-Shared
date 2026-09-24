'use strict';

const { z } = require('zod');
const { redactSecrets } = require('./verification/post-write.js');
const safeJson = (value) => JSON.stringify(redactSecrets(value));
function registerUserTool(mcpServer, name, description, inputSchema, handler) {
  const startsAuthorization = name.endsWith('_auth_start');
  return mcpServer.registerTool(name, {
    title: name, description, inputSchema,
    annotations: startsAuthorization
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, handler);
}

function toolSuccess(body) {
  return { content: [{ type: 'text', text: safeJson({ ok: true, identity: 'user', data: body.data || {}, meta: { code: body.code || 0 } }) }] };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: safeJson({
      ok: false,
      code: error && error.code ? error.code : 'USER_IM_REQUEST_FAILED',
      message: error && error.message ? error.message : String(error),
      auth_state: error && error.auth_state ? error.auth_state : undefined,
      http_status: error && error.http_status ? error.http_status : undefined,
      api_code: error && error.api_code ? error.api_code : undefined,
      api_message: error && error.api_message ? error.api_message : undefined,
      cli_status: error && error.cli_status ? error.cli_status : undefined,
      missing_scopes: error && error.missing_scopes ? error.missing_scopes : undefined,
      tenant_fallback_attempted: false,
      bot_fallback_attempted: false,
    }) }],
  };
}

function registerUserImTools(mcpServer, sharedUserIdentity) {
  registerUserTool(mcpServer,
    'im_user_auth_status',
    'Read-only status for the Shared MCP End User Consent IM identity. It reports official lark-cli/Keychain metadata only: expiry, scopes, and whether automatic refresh is ready.',
    {},
    async () => ({ content: [{ type: 'text', text: safeJson({ auth: await sharedUserIdentity.status() }) }] }),
  );

  registerUserTool(mcpServer,
    'im_user_auth_start',
    'Start official Lark End User Consent Device Authorization only when no valid/refreshable canonical user credential exists. A valid identity returns not_required. The device code never leaves Shared MCP.',
    {},
    async () => {
      try {
        const flow = await sharedUserIdentity.authorizationStart();
        return { content: [{ type: 'text', text: safeJson(flow) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'USER_AUTH_START_FAILED', message: error && error.message ? error.message : String(error) }) }] };
      }
    },
  );

  registerUserTool(mcpServer,
    'im_user_chat_list',
    'Preferred user-identity chat listing for the authorized end user. Lists joined group and P2P chats through the Shared MCP user IM adapter. Read-only.',
    {
      page_all: z.boolean().optional(),
      page_limit: z.number().int().min(1).max(100).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
      page_token: z.string().optional(),
      sort: z.enum(['create_time', 'active_time']).optional(),
      exclude_muted: z.boolean().optional(),
    },
    async (params) => {
      try {
        const body = await sharedUserIdentity.chatList(params);
        return toolSuccess(body);
      } catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'im_user_chat_messages_list',
    'Preferred user-identity history reader for chats visible to the authorized end user. Use this instead of tenant im_v1_message_list when reading private/group chat history. Supports full pagination. Read-only.',
    {
      chat_id: z.string().optional(),
      user_id: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      order: z.enum(['asc', 'desc']).optional(),
      page_all: z.boolean().optional(),
      page_limit: z.number().int().min(1).max(1000).optional(),
      page_size: z.number().int().min(1).max(50).optional(),
      page_token: z.string().optional(),
    },
    async (params) => {
      if (Boolean(params.chat_id) === Boolean(params.user_id)) {
        return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide exactly one of chat_id or user_id.' }) }] };
      }
      try {
        const body = await sharedUserIdentity.chatMessages(params);
        return toolSuccess(body);
      } catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'im_user_messages_search',
    'Search messages across chats using the authorized end-user identity. Supports keyword, sender, chat, chat type and time filters. Prefer this Shared MCP tool for user-visible cross-chat message search. Read-only.',
    {
      query: z.string().optional(),
      sender: z.string().optional(),
      chat_id: z.string().optional(),
      chat_type: z.enum(['group', 'p2p']).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      page_all: z.boolean().optional(),
      page_limit: z.number().int().min(1).max(40).optional(),
      page_size: z.number().int().min(1).max(50).optional(),
      page_token: z.string().optional(),
    },
    async (params) => {
      if (!params.query && !params.sender && !params.chat_id && !params.chat_type && !params.start && !params.end) {
        return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide at least one search filter.' }) }] };
      }
      try {
        const body = await sharedUserIdentity.messagesSearch(params);
        return toolSuccess(body);
      } catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'im_user_thread_messages_list',
    'Read all replies in a message thread using the authorized end-user identity. Accepts om_ or omt_ thread/message id and supports pagination. Read-only.',
    {
      thread: z.string().min(1),
      order: z.enum(['asc', 'desc']).optional(),
      page_all: z.boolean().optional(),
      page_limit: z.number().int().min(1).max(1000).optional(),
      page_size: z.number().int().min(1).max(50).optional(),
      page_token: z.string().optional(),
    },
    async (params) => {
      try {
        const body = await sharedUserIdentity.threadMessages(params);
        return toolSuccess(body);
      } catch (error) { return toolError(error); }
    },
  );

  const validateSpreadsheetLocator = (params) => Boolean(params.spreadsheet_token) !== Boolean(params.url);
  const validateSheetLocator = (params) => Boolean(params.sheet_id) !== Boolean(params.sheet_name);

  registerUserTool(mcpServer,
    'sheets_user_workbook_info',
    'Read-only workbook metadata through the official Lark CLI under the authorized end-user identity. Returns sheet ids, titles, dimensions, freeze and hidden state.',
    {
      spreadsheet_token: z.string().min(1).optional(),
      url: z.string().url().optional(),
    },
    async (params) => {
      if (!validateSpreadsheetLocator(params)) return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide exactly one of spreadsheet_token or url.' }) }] };
      try { return toolSuccess(await sharedUserIdentity.sheetsWorkbookInfo(params)); }
      catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'sheets_user_cells_get',
    'Read one bounded A1 range with values/formulas and optional metadata through the official Lark CLI under the authorized end-user identity. Read-only.',
    {
      spreadsheet_token: z.string().min(1).optional(),
      url: z.string().url().optional(),
      sheet_id: z.string().min(1).optional(),
      sheet_name: z.string().min(1).optional(),
      range: z.string().min(1).max(256),
      include: z.array(z.enum(['value', 'formula', 'style', 'comment', 'data_validation', 'conditional_format', 'truncation'])).max(7).optional(),
      skip_hidden: z.boolean().optional(),
      max_chars: z.number().int().min(1000).max(500000).optional(),
    },
    async (params) => {
      if (!validateSpreadsheetLocator(params) || !validateSheetLocator(params)) return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide exactly one spreadsheet locator and exactly one sheet locator.' }) }] };
      try { return toolSuccess(await sharedUserIdentity.sheetsCellsGet(params)); }
      catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'sheets_user_csv_get',
    'Read a bounded sheet range as CSV text through the official Lark CLI under the authorized end-user identity. Read-only.',
    {
      spreadsheet_token: z.string().min(1).optional(),
      url: z.string().url().optional(),
      sheet_id: z.string().min(1).optional(),
      sheet_name: z.string().min(1).optional(),
      range: z.string().min(1).max(256).optional(),
      skip_hidden: z.boolean().optional(),
      max_chars: z.number().int().min(1000).max(500000).optional(),
    },
    async (params) => {
      if (!validateSpreadsheetLocator(params) || !validateSheetLocator(params)) return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide exactly one spreadsheet locator and exactly one sheet locator.' }) }] };
      try { return toolSuccess(await sharedUserIdentity.sheetsCsvGet(params)); }
      catch (error) { return toolError(error); }
    },
  );

  registerUserTool(mcpServer,
    'sheets_user_table_get',
    'Read spreadsheet data as the typed table protocol through the official Lark CLI under the authorized end-user identity. Read-only.',
    {
      spreadsheet_token: z.string().min(1).optional(),
      url: z.string().url().optional(),
      sheet_id: z.string().min(1).optional(),
      sheet_name: z.string().min(1).optional(),
      range: z.string().min(1).max(256).optional(),
      no_header: z.boolean().optional(),
      max_chars: z.number().int().min(1000).max(500000).optional(),
    },
    async (params) => {
      if (!validateSpreadsheetLocator(params)) return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide exactly one of spreadsheet_token or url.' }) }] };
      if (params.sheet_id && params.sheet_name) return { isError: true, content: [{ type: 'text', text: safeJson({ ok: false, code: 'INVALID_ARGUMENT', message: 'Provide at most one of sheet_id or sheet_name.' }) }] };
      try { return toolSuccess(await sharedUserIdentity.sheetsTableGet(params)); }
      catch (error) { return toolError(error); }
    },
  );
}

module.exports = { registerUserImTools };
