/**
 * The app2email tool catalogue: the same curated set the hosted server (https://api.app2email.com/mcp) exposes.
 * Each tool maps one agent intent onto one REST call of the app2email WhatsApp API v1.
 *
 * Conventions
 *  - annotations as the hosted server's (ApiV1McpTools.cs AgentNormalizeAnnotations): a read carries readOnlyHint, every other tool
 *    (a send, a change, a cancel, a removal) carries destructiveHint, so a client asks before running it; sends also carry openWorldHint
 *    (they reach a person's phone). https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-annotations
 *  - every result is returned both as text (for the model) and as structuredContent (the API answer, for programs).
 *  - a failed call is an isError result with the API's code, message and how_to_fix (never a thrown protocol error),
 *    so the model can repair the request (the API often returns an example_request for template mistakes).
 */
import { callApi, type Query, type RestConfig } from './rest.js';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  format?: string;
  examples?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run: (cfg: RestConfig, args: Record<string, unknown>) => Promise<unknown>;
}

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
const bool = (v: unknown): boolean | undefined => (v === undefined || v === null ? undefined : v === true || v === 'true' || v === 1);
const digits = (v: unknown): string | undefined => str(v)?.replace(/[^0-9.A-Za-z]/g, '');
const enc = encodeURIComponent;

function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out as T;
}

const PHONE_DESC = "The contact's WhatsApp number: country code first, digits only (eg 61412345678), or their business-scoped user id when WhatsApp gave one instead of a number.";
const CURSOR = { type: 'string', description: 'next_cursor from the previous answer, to get the next page.' } as const;
const LIMIT = { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'How many (1 to 200).' } as const;

const RO: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SEND: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// the calendar / payment tools (2026-11-13), the hosted server's texts (ApiV1McpTools.cs)
const LOCAL_DATE = 'A day in the business time zone, YYYY-MM-DD.';
const LOCAL_TIME = 'Local time in the business time zone, yyyy-MM-ddTHH:mm (a slot id of get_booking_availability / find_next_booking_slots).';
const STAFF_ID = "A staff member's id (list_booking_services shows them per service).";
const BOOKING_ID = "The booking's id (a number) or its reference (BK-XXXXXX), as list_bookings shows it.";
const IDEMPOTENCY = 'Optional. Any unique string (eg your order id). The same key sent again within 24 hours returns the first answer instead of sending twice. Use it for every real send.';
const idem = (a: Args): Record<string, string> | undefined => (str(a.idempotency_key) ? { 'Idempotency-Key': String(a.idempotency_key) } : undefined);

const SEND_PREFIX = 'Sends a real WhatsApp message to a person and counts against the plan: confirm the recipient and the content with the user unless they already told you to send. ';

export const TOOLS: ToolDefinition[] = [
  {
    name: 'check_key',
    title: 'Check the API key',
    description: 'Checks the API key and shows the number, the plan, the key scopes and the limits (GET /me). Call it first when something fails with 401 or 403.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...RO, title: 'Check the API key' },
    run: (cfg) => callApi(cfg, { method: 'GET', path: '/me' }),
  },
  {
    name: 'list_templates',
    title: 'List templates',
    description:
      'Lists the approved WhatsApp templates of this number with the values each one needs and a complete example_request. Use it before send_template. Only APPROVED templates can be sent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...RO, title: 'List templates' },
    run: (cfg) => callApi(cfg, { method: 'GET', path: '/templates' }),
  },
  {
    name: 'get_template',
    title: 'Get a template',
    description: 'One template by name: its status (APPROVED, PENDING, REJECTED, PAUSED), rejection reason, quality, languages and the values it needs.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The template name, eg order_update.' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Get a template' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: `/templates/${enc(String(a.name))}` }),
  },
  {
    name: 'send_template',
    title: 'Send a template message',
    description:
      SEND_PREFIX +
      'Sends an approved template to one number, to several numbers (comma separated or an array), or to a segment. Use this to start a conversation or when the 24 hour reply window is closed. ' +
      'Give the template values as WhatsApp Cloud API components (body text parameters, header media, button values). Set dry_run true to check everything without sending. ' +
      'On a value mistake the error carries an example_request to copy from. Large lists: set background true and follow the broadcast with get_broadcast.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          description: 'One number, or several separated by commas, or an array of numbers. ' + PHONE_DESC,
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        segment: { type: 'string', description: 'Instead of to: the id or name of a saved contact segment to send to.' },
        template_name: { type: 'string', description: 'Name of an APPROVED template (see list_templates).' },
        language: { type: 'string', default: 'en', description: 'Template language code, eg en, en_US, de.' },
        components: {
          type: 'array',
          description:
            'Template values, WhatsApp Cloud API format: [{"type":"body","parameters":[{"type":"text","text":"John"}]}, {"type":"header","parameters":[{"type":"image","image":{"link":"https://..."}}]}, {"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"abc"}]}]. Named placeholders use parameter_name. Leave out for templates without values.',
          items: { type: 'object', additionalProperties: true },
        },
        recipients: {
          type: 'array',
          description: 'Instead of to: one entry per number with its own values: [{"to":"61412345678","components":[...]}]. Shared components still apply.',
          items: { type: 'object', additionalProperties: true },
        },
        campaign_name: { type: 'string', description: 'Name shown in the Activity Log for a list send.' },
        send_at: { type: 'string', format: 'date-time', description: 'Schedule: ISO 8601 with a time zone, 1 minute to 29 days ahead.' },
        reply_to: { type: 'string', description: 'A wamid. of a message from the contact, to quote it.' },
        background: { type: 'boolean', default: false, description: 'true: answer at once and send after (big lists).' },
        dry_run: { type: 'boolean', default: false, description: 'true: check everything and send nothing.' },
        idempotency_key: { type: 'string', description: 'A unique value per message (eg order-1234-shipped) so a retry never sends twice.' },
      },
      required: ['template_name'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Send a template message' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/messages',
        headers: a.idempotency_key ? { 'Idempotency-Key': String(a.idempotency_key) } : undefined,
        body: clean({
          type: 'template',
          to: a.to,
          segment: str(a.segment),
          template: clean({
            name: String(a.template_name),
            language: { code: str(a.language) ?? 'en' },
            components: Array.isArray(a.components) && a.components.length > 0 ? a.components : undefined,
          }),
          recipients: Array.isArray(a.recipients) && a.recipients.length > 0 ? a.recipients : undefined,
          campaign_name: str(a.campaign_name),
          send_at: str(a.send_at),
          reply_to: str(a.reply_to),
          background: bool(a.background) || undefined,
          dry_run: bool(a.dry_run) || undefined,
        }),
      }),
  },
  {
    name: 'send_text',
    title: 'Send a text reply',
    description:
      SEND_PREFIX +
      'Sends a free-form text message to ONE contact. Only works within 24 hours of the contact\'s last message to this number (check window_open with get_conversation); otherwise the API answers 422 outside_24h_window and you must send_template instead.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: PHONE_DESC },
        text: { type: 'string', description: 'The message, up to 4096 characters.' },
        reply_to: { type: 'string', description: 'A wamid. of one of the contact\'s messages, to quote it.' },
        preview_url: { type: 'boolean', default: false, description: 'true: show a preview of a link in the text.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Send a text reply' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/messages',
        body: clean({ type: 'text', to: digits(a.to), text: { body: String(a.text), preview_url: bool(a.preview_url) ?? false }, reply_to: str(a.reply_to) }),
      }),
  },
  {
    name: 'send_media',
    title: 'Send an image, video or document',
    description:
      SEND_PREFIX +
      'Sends a free-form image, video or document (with an optional caption) to ONE contact within the 24 hour window. Give exactly one of link (public URL), data (base64) or media_id (from an earlier upload). Images 5 MB, videos 16 MB, documents 100 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: PHONE_DESC },
        type: { type: 'string', enum: ['image', 'video', 'document'] },
        link: { type: 'string', format: 'uri', description: 'Public http(s) URL of the file.' },
        data: { type: 'string', description: 'The file as base64 (a data: prefix is accepted).' },
        media_id: { type: 'string', description: 'A WhatsApp media id already uploaded for this number.' },
        filename: { type: 'string', description: 'Shown to the recipient for documents; needed with data.' },
        caption: { type: 'string', description: 'Text under the media, up to 1024 characters.' },
        reply_to: { type: 'string', description: 'A wamid. of one of the contact\'s messages, to quote it.' },
      },
      required: ['to', 'type'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Send an image, video or document' },
    run: (cfg, a) => {
      const type = String(a.type);
      return callApi(cfg, {
        method: 'POST',
        path: '/messages',
        body: clean({
          type,
          to: digits(a.to),
          [type]: clean({ link: str(a.link), data: str(a.data), id: str(a.media_id), filename: str(a.filename), caption: str(a.caption) }),
          reply_to: str(a.reply_to),
        }),
      });
    },
  },
  {
    name: 'send_interactive',
    title: 'Send buttons or a list',
    description:
      SEND_PREFIX +
      'Sends an interactive message (reply buttons, a list menu, or a call-to-action URL button) to ONE contact within the 24 hour window. The interactive object follows the WhatsApp Cloud API: {"type":"button","body":{"text":"..."},"action":{"buttons":[{"type":"reply","reply":{"id":"yes","title":"Yes"}}]}} or type list with sections, or type cta_url. The contact\'s choice comes back as a normal inbound message (button_reply / list_reply).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: PHONE_DESC },
        interactive: { type: 'object', additionalProperties: true, description: 'The WhatsApp Cloud API interactive object (type button | list | cta_url).' },
        reply_to: { type: 'string', description: 'A wamid. of one of the contact\'s messages, to quote it.' },
      },
      required: ['to', 'interactive'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Send buttons or a list' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: '/messages', body: clean({ type: 'interactive', to: digits(a.to), interactive: a.interactive, reply_to: str(a.reply_to) }) }),
  },
  {
    name: 'get_message',
    title: 'Get a message status',
    description: 'The status of a sent message (accepted, sent, delivered, read, failed) with the times and any WhatsApp error, or the content of a received message, by its message id (wamid.).',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string', description: 'The message id, starts with wamid.' } }, required: ['message_id'], additionalProperties: false },
    annotations: { ...RO, title: 'Get a message status' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: `/messages/${enc(String(a.message_id))}` }),
  },
  {
    name: 'list_messages',
    title: 'List messages',
    description: 'Messages sent and received by this number, newest first, with filters. Pages with next_cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in', 'out'], description: 'in: received. out: sent. Left out: both.' },
        status: { type: 'string', enum: ['queued', 'accepted', 'sent', 'delivered', 'read', 'failed'], description: 'Sent messages only.' },
        to: { type: 'string', description: 'Only messages with this contact.' },
        since: { type: 'string', format: 'date-time', description: 'Only messages at or after this time (ISO 8601).' },
        until: { type: 'string', format: 'date-time', description: 'Only messages before this time (ISO 8601).' },
        broadcast: { type: 'string', description: 'Only the messages of this broadcast code.' },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'List messages' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/messages', query: queryOf(a, ['direction', 'status', 'to', 'since', 'until', 'broadcast', 'limit', 'cursor']) }),
  },
  {
    name: 'list_conversations',
    title: 'List conversations',
    description: 'The contacts this number has talked with, most recent activity first, each with window_open (whether a free-form reply is possible now) and the last message. Pages with next_cursor.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', format: 'date-time', description: 'Only conversations active at or after this time.' }, limit: LIMIT, cursor: CURSOR },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'List conversations' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/conversations', query: queryOf(a, ['since', 'limit', 'cursor']) }),
  },
  {
    name: 'list_events',
    title: 'Fetch events (no webhook needed)',
    description:
      'The number\'s events (message.received, message.status, contact.opted_out and the rest: the same JSON a webhook gets, with the same ids), fetched instead of pushed. Use it when you have no public address for a webhook. Pass the answer\'s cursor as after on the next call; leave after out for the oldest events still kept (72 hours), or "now" for new ones only. wait holds the answer until an event arrives. The first call switches the number\'s feed on; events before that are not kept.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'The cursor of the previous answer, unchanged, or "now". Left out: from the oldest event still kept.' },
        types: { type: 'string', description: 'Only these event types, comma separated, eg message.received,message.status. Left out: every event.' },
        from: { type: 'string', description: 'Only events of this contact (full number, digits, country code first).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many (1 to 100, default 50).' },
        wait: { type: 'integer', minimum: 0, maximum: 25, description: 'Seconds to wait for an event when there is none yet (0 to 25, default 0).' },
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Fetch events (no webhook needed)' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/events', query: queryOf(a, ['after', 'types', 'from', 'limit', 'wait']) }),
  },
  {
    name: 'wait_for_message',
    title: 'Wait for a contact\'s next message',
    description:
      'Waits (up to 25 seconds) for messages contacts sent to the number and returns them as message.received events: who wrote, the text, the message_id. An empty events list means nobody wrote in that time: call again with the same after. Always pass the answer\'s cursor as after on the next call, so no message is returned twice or missed. After a contact\'s message you can answer free-form for 24 hours (send_text).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Only this contact\'s messages (full number, digits, country code first). Left out: any contact.' },
        after: { type: 'string', description: 'The cursor of the previous answer, unchanged, or "now". Left out: from the oldest message still kept (72 hours).' },
        wait: { type: 'integer', minimum: 0, maximum: 25, description: 'Seconds to wait when there is no message yet (0 to 25, default 25).' },
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Wait for a contact\'s next message' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/events', query: { ...queryOf(a, ['from', 'after']), types: 'message.received', wait: num(a.wait) ?? 25 } }),
  },
  {
    name: 'get_conversation',
    title: 'Get a conversation',
    description:
      'One contact: the 24 hour window state (window_open, window_closes_at), who owns the conversation (agent, human, paused or default routing), the contact\'s name, and the latest messages in both directions. Read this before replying.',
    inputSchema: {
      type: 'object',
      properties: { contact: { type: 'string', description: PHONE_DESC }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: 'How many recent messages to include.' } },
      required: ['contact'],
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Get a conversation' },
    run: async (cfg, a) => {
      const contact = enc(String(digits(a.contact)));
      const [conversation, messages] = await Promise.all([
        callApi<Record<string, unknown>>(cfg, { method: 'GET', path: `/conversations/${contact}` }),
        callApi<Record<string, unknown>>(cfg, { method: 'GET', path: `/conversations/${contact}/messages`, query: { limit: num(a.limit) ?? 20 } }),
      ]);
      return { ...conversation, messages: messages.messages ?? [], next_cursor: messages.next_cursor ?? null };
    },
  },
  {
    name: 'get_conversation_messages',
    title: "One contact's messages",
    description: "One contact's messages in both directions, newest first, paged with cursor. window_open in the answer says whether a free-form reply can be sent now.",
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: PHONE_DESC },
        since: { type: 'string', format: 'date-time', description: 'Only messages at or after this time. ISO 8601.' },
        until: { type: 'string', format: 'date-time', description: 'Only messages before this time. ISO 8601.' },
        limit: LIMIT,
        cursor: CURSOR,
      },
      required: ['contact'],
      additionalProperties: false,
    },
    annotations: { ...RO, title: "One contact's messages" },
    run: (cfg, a) =>
      callApi(cfg, { method: 'GET', path: `/conversations/${enc(String(digits(a.contact)))}/messages`, query: queryOf(a, ['since', 'until', 'limit', 'cursor']) }),
  },
  {
    name: 'set_conversation_owner',
    title: 'Hand a conversation over',
    description:
      'Sets who owns a conversation: "human" hands it to a person (the auto reply and agent forwarding stop for this contact; the email bridge and dashboard take over), "agent" claims it for automation, "paused" stops every automatic send, "" restores the default routing. Give a reason and a short summary of the conversation so far: both are shown to the person taking over. until_minutes returns the conversation to the default routing after that time.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: PHONE_DESC },
        owner: { type: 'string', enum: ['human', 'agent', 'paused', ''], description: 'The new owner.' },
        reason: { type: 'string', description: 'Why, eg "customer asked for a person" or "refund over my limit".' },
        summary: { type: 'string', description: 'What was discussed and what is still open, for the person taking over.' },
        until_minutes: { type: 'integer', minimum: 1, description: 'Give the conversation back to the default routing after this many minutes.' },
      },
      required: ['contact', 'owner'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: 'Hand a conversation over' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'PUT',
        path: `/conversations/${enc(String(digits(a.contact)))}/owner`,
        body: clean({ owner: String(a.owner ?? ''), reason: str(a.reason), summary: str(a.summary), until_minutes: num(a.until_minutes) }),
      }),
  },
  {
    name: 'list_contacts',
    title: 'List contacts',
    description: 'Searches the contacts of this number (name, number, tags, custom fields, marketing consent). Pages with next_cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search text: part of a name or number.' },
        tag: { type: 'string', description: 'Only contacts with this tag.' },
        consent_marketing: { type: 'boolean', description: 'Only contacts with (true) or without (false) marketing consent.' },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'List contacts' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/contacts', query: queryOf(a, ['q', 'tag', 'consent_marketing', 'limit', 'cursor']) }),
  },
  {
    name: 'upsert_contact',
    title: 'Add or update a contact',
    description:
      'Creates or updates one contact by number (or business-scoped user id): name, tags, custom fields (used as template values in broadcasts), and marketing consent with its evidence (source, wording, date). Record consent only when the person actually gave it.',
    inputSchema: {
      type: 'object',
      properties: {
        identity: { type: 'string', description: PHONE_DESC },
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tags, eg ["vip","newsletter"].' },
        custom_fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'String values, eg {"order_id":"1234"}. Merged into the existing fields.' },
        source: { type: 'string', description: 'Where the contact came from, eg crm, web form, import.' },
        consent_marketing: { type: 'boolean', description: 'true when the person agreed to marketing messages.' },
        consent_source: { type: 'string', description: 'How consent was given, eg web form, signed form, whatsapp message.' },
        consent_text: { type: 'string', description: 'The wording the person agreed to.' },
        consent_evidence: { type: 'string', description: 'A URL, file name, IP address or message id that proves it.' },
        consent_at: { type: 'string', format: 'date-time', description: 'When consent was given (ISO 8601). Default now.' },
      },
      required: ['identity'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: 'Add or update a contact' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/contacts',
        body: clean({
          identity: digits(a.identity),
          name: str(a.name),
          tags: Array.isArray(a.tags) ? a.tags : undefined,
          custom_fields: a.custom_fields && typeof a.custom_fields === 'object' ? a.custom_fields : undefined,
          source: str(a.source) ?? 'api',
          consent_marketing: bool(a.consent_marketing),
          consent_source: str(a.consent_source),
          consent_text: str(a.consent_text),
          consent_evidence: str(a.consent_evidence),
          consent_at: str(a.consent_at),
        }),
      }),
  },
  {
    name: 'get_usage',
    title: 'Get usage and limits',
    description:
      'The plan, how many messages were used and are left this billing month (outgoing WhatsApp messages and outgoing emails count together), and with meta true the indicative Meta (WhatsApp) charges: free service messages used of the 1,000 per month, billable utility and marketing counts.',
    inputSchema: { type: 'object', properties: { meta: { type: 'boolean', default: false, description: 'true: also return the Meta cost estimate (GET /usage/meta).' } }, additionalProperties: false },
    annotations: { ...RO, title: 'Get usage and limits' },
    run: async (cfg, a) => {
      const usage = await callApi<Record<string, unknown>>(cfg, { method: 'GET', path: '/usage' });
      if (!bool(a.meta)) return usage;
      const meta = await callApi<Record<string, unknown>>(cfg, { method: 'GET', path: '/usage/meta' });
      return { ...usage, meta_pricing: meta.meta_pricing ?? meta };
    },
  },
  {
    name: 'list_broadcasts',
    title: 'List broadcasts',
    description: 'The latest broadcasts (list sends and scheduled sends) with their status and sent, delivered, read and failed counts.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    annotations: { ...RO, title: 'List broadcasts' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/broadcasts', query: queryOf(a, ['limit']) }),
  },
  {
    name: 'get_broadcast',
    title: 'Get a broadcast',
    description: 'A broadcast by its code: status (scheduled, sending, completed, cancelled), counts, and the result per number.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'The broadcast code from send_template or list_broadcasts.' } }, required: ['code'], additionalProperties: false },
    annotations: { ...RO, title: 'Get a broadcast' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: `/broadcasts/${enc(String(a.code))}` }),
  },
  {
    name: 'cancel_broadcast',
    title: 'Cancel a broadcast',
    description: 'Cancels a scheduled broadcast, or stops one that is sending (messages already sent are not recalled).',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'The broadcast code.' } }, required: ['code'], additionalProperties: false },
    annotations: { ...DESTRUCTIVE, title: 'Cancel a broadcast' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/broadcasts/${enc(String(a.code))}/cancel` }),
  },
  {
    name: 'list_donotcall',
    title: 'List the Do Not Call list',
    description: 'The numbers that must not get marketing templates (opted out, or added by the business), or checks one number.',
    inputSchema: { type: 'object', properties: { number: { type: 'string', description: 'Check this one number instead of listing.' } }, additionalProperties: false },
    annotations: { ...RO, title: 'List the Do Not Call list' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/donotcall', query: queryOf(a, ['number']) }),
  },
  {
    name: 'add_donotcall',
    title: 'Add to the Do Not Call list',
    description: 'Adds numbers to the Do Not Call list (up to 1000). Marketing templates to them are skipped from then on. Use it when a person asks not to be contacted.',
    inputSchema: {
      type: 'object',
      properties: {
        numbers: { type: 'array', items: { type: 'string' }, description: 'Numbers, country code first, digits only.' },
        note: { type: 'string', description: 'Why, eg "asked by email on 2 Nov".' },
      },
      required: ['numbers'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: 'Add to the Do Not Call list' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/donotcall',
        body: { numbers: (a.numbers as unknown[]).map((n) => (a.note ? { number: digits(n), note: String(a.note) } : digits(n))) },
      }),
  },
  {
    name: 'remove_donotcall',
    title: 'Remove from the Do Not Call list',
    description: 'Removes one number from the Do Not Call list. Only do this when the person asked to receive messages again.',
    inputSchema: { type: 'object', properties: { phone: { type: 'string', description: 'The number, digits only.' } }, required: ['phone'], additionalProperties: false },
    annotations: { ...DESTRUCTIVE, title: 'Remove from the Do Not Call list' },
    run: (cfg, a) => callApi(cfg, { method: 'DELETE', path: `/donotcall/${enc(String(digits(a.phone)))}` }),
  },
  {
    name: 'list_approvals',
    title: 'List sends waiting for approval',
    description: 'Sends that were held because the API key has an approval threshold (more recipients than allowed without a human OK). Each has an id, the request, who made it and when.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...RO, title: 'List sends waiting for approval' },
    run: (cfg) => callApi(cfg, { method: 'GET', path: '/approvals' }),
  },
  {
    name: 'approve_send',
    title: 'Approve or reject a held send',
    description: 'Approves (sends now) or rejects a held send by its approval id. Approving sends real messages to every recipient of the held request.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The approval id from list_approvals.' }, decision: { type: 'string', enum: ['approve', 'reject'] }, note: { type: 'string' } },
      required: ['id', 'decision'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Approve or reject a held send' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/approvals/${enc(String(a.id))}/${a.decision === 'reject' ? 'reject' : 'approve'}`, body: clean({ note: str(a.note) }) }),
  },
  // appointment bookings (2026-11-06, the hosted core set: ApiV1McpTools.cs; scope bookings:manage, the reads also messages:read) and list_flows (ApiV1Flows.cs)
  {
    name: 'list_bookings',
    title: 'The appointments',
    description:
      'The appointments booked on WhatsApp, from the dashboard or through the API, soonest start first. Pass from=today for the upcoming ones, status to filter, contact for one customer. Paged: pass next_cursor as cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Only appointments starting at or after this day (YYYY-MM-DD, business time zone) or ISO 8601 time.' },
        to: { type: 'string', description: 'Only appointments starting on or before this day, or before this ISO 8601 time.' },
        status: { type: 'string', enum: ['confirmed', 'cancelled', 'completed', 'no_show'], description: 'Only this status.' },
        contact: { type: 'string', description: PHONE_DESC },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'asc: soonest start first (default). desc: latest start first.' },
        limit: LIMIT,
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'The appointments' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/bookings', query: queryOf(a, ['from', 'to', 'status', 'contact', 'order', 'limit', 'cursor']) }),
  },
  {
    name: 'get_booking_availability',
    title: 'Free appointment slots',
    description:
      "The free slots per day for a service, as the customer would see them. Each slot's id (local time yyyy-MM-ddTHH:mm) is what create_booking takes as start. At most 32 days per call.",
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: "The service's id (get_booking_settings lists the services)." },
        from: { type: 'string', description: 'A day in the business time zone, YYYY-MM-DD. Default today.' },
        to: { type: 'string', description: 'A day in the business time zone, YYYY-MM-DD. Default from + 6 days.' },
        provider_id: { type: 'string', description: "Optional: one staff member's own availability (config.providers[].id). Leave out for anyone available." },
      },
      required: ['service_id'],
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Free appointment slots' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/bookings/availability', query: queryOf(a, ['service_id', 'from', 'to', 'provider_id']) }),
  },
  {
    name: 'create_booking',
    title: 'Book an appointment',
    description:
      'Books an appointment for a customer at a free slot. The customer gets the confirmation on WhatsApp (a text inside their 24 hour window, else the booking confirmation template) unless notify is false; the business gets an email and the booking.created event. ' +
      'Check the slot with get_booking_availability first and confirm the details with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: PHONE_DESC },
        service_id: { type: 'string', description: "The service's id." },
        start: { type: 'string', description: "The slot's id from get_booking_availability: local time in the business time zone, yyyy-MM-ddTHH:mm." },
        name: { type: 'string', description: "The customer's name." },
        email: { type: 'string', description: "Optional: the customer's email." },
        notes: { type: 'string', description: 'Optional: notes for the business.' },
        provider_id: { type: 'string', description: 'Optional: the staff member (config.providers[].id). Leave out for the first free one.' },
        notify: { type: 'boolean', default: true, description: 'false: do not send the customer the confirmation.' },
      },
      required: ['contact', 'service_id', 'start', 'name'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Book an appointment' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/bookings',
        body: clean({ contact: str(a.contact), service_id: str(a.service_id), start: str(a.start), name: str(a.name), email: str(a.email), notes: str(a.notes), provider_id: str(a.provider_id), notify: bool(a.notify) }),
      }),
  },
  {
    name: 'cancel_booking',
    title: 'Cancel an appointment',
    description: 'Cancels an appointment. The customer is told on WhatsApp unless notify is false; the calendar event is removed and booking.cancelled is sent. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The booking's id (a number) or its reference (BK-XXXXXX), as list_bookings shows it." },
        reason: { type: 'string', description: 'Optional: why, shown to the business.' },
        notify: { type: 'boolean', default: true, description: 'false: do not tell the customer.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { ...DESTRUCTIVE, openWorldHint: true, title: 'Cancel an appointment' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/bookings/${enc(String(a.id))}/cancel`, body: clean({ reason: str(a.reason), notify: bool(a.notify) }) }),
  },
  {
    name: 'set_booking_status',
    title: 'Mark an appointment completed or a no-show',
    description:
      'Marks an appointment completed, a no-show, or back to confirmed. Use it after the appointment time: the reports count completed visits and no-shows, and the follow-up message goes to completed ones.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The booking's id (a number) or its reference (BK-XXXXXX), as list_bookings shows it." },
        status: { type: 'string', enum: ['completed', 'no_show', 'confirmed'], description: 'completed: the customer came. no_show: they did not. confirmed: undo a mistake (within 7 days of the end).' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: 'Mark an appointment completed or a no-show' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/bookings/${enc(String(a.id))}/status`, body: { status: String(a.status) } }),
  },
  {
    name: 'get_booking_settings',
    title: 'The booking settings',
    description:
      'Whether Book-and-Pay is on, the services, hours, messages, calendar, staff, and the Flows with their status. Read it before create_booking (the service ids) and before update_booking_settings (the keys and their current values).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...RO, title: 'The booking settings' },
    run: (cfg) => callApi(cfg, { method: 'GET', path: '/settings/booking' }),
  },
  {
    name: 'update_booking_settings',
    title: 'Change the booking settings',
    description:
      'Switches Book-and-Pay on or off and changes the settings. config is partial: a section object (trigger, schedule, details, messages, calendar) is merged key by key into what is stored; a list (services, providers, schedule.overrides) or a single value replaces it. ' +
      'Every rule is checked (400 invalid_setting lists the problems); nothing is saved on a problem. Confirm changes with the user: they change what customers see.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true: Book-and-Pay on (the trigger words send the Flow, the utility templates are created at Meta). false: off.' },
        config: {
          type: 'object',
          additionalProperties: true,
          description:
            'The sections to change, in the shape get_booking_settings returns, eg {"services": [{"id": "cut", "name": "Haircut", "duration_min": 30, "enabled": true}], "schedule": {"timezone": "Australia/Sydney"}}.',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: 'Change the booking settings' },
    run: (cfg, a) => callApi(cfg, { method: 'PUT', path: '/settings/booking', body: clean({ enabled: bool(a.enabled), config: a.config }) }),
  },
  {
    name: 'get_booking_reports',
    title: 'Booking numbers for the last days',
    description:
      'The booking numbers of the last 7, 30 or 90 days: bookings by source, completed, cancelled, no-shows, CSAT, reminders, Flow conversion, top services, bookings per staff member, credits, nudges.',
    inputSchema: { type: 'object', properties: { days: { type: 'string', enum: ['7', '30', '90'], description: 'The range: the last 7, 30 (default) or 90 days.' } }, additionalProperties: false },
    annotations: { ...RO, title: 'Booking numbers for the last days' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/bookings/reports', query: queryOf(a, ['days']) }),
  },
  {
    name: 'list_flows',
    title: 'List WhatsApp Flows',
    description:
      "The WhatsApp Flows of the account. This number's Book-and-Pay Flows also have key and can_send: send_flow takes the key (can_send: it can be sent now).",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'How many (1 to 100).' }, cursor: CURSOR },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'List WhatsApp Flows' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/flows', query: queryOf(a, ['limit', 'cursor']) }),
  },
  {
    name: 'send_flow',
    title: 'Send a Flow (booking form) to a contact',
    description:
      SEND_PREFIX +
      "Sends a Flow to a contact: the booking form, or any other form of the number's Book-and-Pay section. A Flow is a free-form message: only within 24 hours of the contact's last message (422 outside_24h_window otherwise - send a template first). " +
      "The contact's answers come back as booking.created (a booking Flow) or flow.completed (a form Flow).",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: "The Flow's key, as list_flows shows it (the booking form is usually 'booking')." },
        contact: { type: 'string', description: PHONE_DESC },
        purpose: { type: 'string', enum: ['book', 'reschedule'], description: "book (default): a new booking. reschedule: move the contact's next appointment (a booking Flow only)." },
      },
      required: ['key', 'contact'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Send a Flow (booking form) to a contact' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/flows/${enc(String(a.key))}/send`, body: clean({ contact: str(a.contact), purpose: str(a.purpose) }) }),
  },
  // ---- the calendar, payments, customers, polls (2026-11-13: the hosted server's tools of 2026-11-11, ApiV1McpTools.cs; scope bookings:manage, reads also messages:read)
  {
    name: 'get_calendar',
    title: 'The business calendar',
    description:
      'Everything on the business calendar for a range of days: appointments, blocked time, busy time of the connected calendar and held times, with the opening hours per day and the staff. At most 62 days (default 7). Times are in the business time zone as well as UTC.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: LOCAL_DATE + ' Default today.' },
        to: { type: 'string', description: LOCAL_DATE + ' Included. Default from + 6 days; at most 62 days.' },
        provider_id: { type: 'string', description: "Optional: only this staff member's entries (and the business-wide ones)." },
        include: { type: 'string', description: 'Optional: comma list of bookings, blocks, busy, holds. Default all four.' },
        cancelled: { type: 'boolean', description: 'true: also the cancelled appointments. Default false.' },
      },
      additionalProperties: false,
    },
    annotations: { ...RO, openWorldHint: true, title: 'The business calendar' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/calendar', query: queryOf(a, ['from', 'to', 'provider_id', 'include', 'cancelled']) }),
  },
  {
    name: 'list_booking_services',
    title: 'Bookable services and their staff',
    description:
      'The services a customer can book, with their length, price and the staff members who do each one. Use the ids with find_next_booking_slots, hold_booking_slot and create_booking.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...RO, title: 'Bookable services and their staff' },
    run: (cfg) => callApi(cfg, { method: 'GET', path: '/bookings/services' }),
  },
  {
    name: 'find_next_booking_slots',
    title: 'The next free appointment times',
    description:
      "The next free start times for a service, across days, as the customer would see them. Looks at most 60 days ahead. Each slot's id is what create_booking, hold_booking_slot and reschedule_booking take as start.",
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: "The service's id (list_booking_services)." },
        provider_id: { type: 'string', description: 'Optional: ' + STAFF_ID + ' Leave out for anyone available.' },
        after: { type: 'string', description: 'Optional: only times after this, a day (YYYY-MM-DD) or an ISO 8601 time. Default now.' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: 'How many slots (1 to 20). Default 5.' },
      },
      required: ['service_id'],
      additionalProperties: false,
    },
    annotations: { ...RO, openWorldHint: true, title: 'The next free appointment times' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/bookings/next', query: queryOf(a, ['service_id', 'provider_id', 'after', 'count']) }),
  },
  {
    name: 'update_booking',
    title: "Change an appointment's details",
    description:
      "Change the details of an appointment: the customer's name or e-mail, the notes, the staff member. A staff member change checks that the time is free for the new one. The time itself is changed with reschedule_booking. The booking.updated event is sent.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: BOOKING_ID },
        name: { type: 'string', description: "The customer's name." },
        email: { type: 'string', description: "The customer's e-mail." },
        notes: { type: 'string', description: "The customer's note on the booking (the business's notes are add_booking_note)." },
        provider_id: { type: 'string', description: STAFF_ID + ' "any" = the first free one.' },
        answers: { type: 'object', description: 'Replaces the extra fields kept with the booking.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, title: "Change an appointment's details" },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'PATCH',
        path: `/bookings/${enc(String(a.id))}`,
        body: clean({ name: str(a.name), email: str(a.email), notes: str(a.notes), provider_id: str(a.provider_id), answers: a.answers }),
      }),
  },
  {
    name: 'reschedule_booking',
    title: 'Move an appointment to another time',
    description:
      'Move a confirmed appointment to another time. It keeps its id and reference. The customer is told on WhatsApp unless notify is false; booking.rescheduled is sent. 409 booking_slot_taken when the time is not free. Check the time with find_next_booking_slots first and confirm with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: BOOKING_ID },
        start: { type: 'string', description: 'The new start. ' + LOCAL_TIME },
        provider_id: { type: 'string', description: 'Optional: another staff member (' + STAFF_ID + ') or "any". Left out: the booking\'s own.' },
        notify: { type: 'boolean', description: 'false: do not tell the customer. Default true.' },
      },
      required: ['id', 'start'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Move an appointment to another time' },
    run: (cfg, a) =>
      callApi(cfg, { method: 'POST', path: `/bookings/${enc(String(a.id))}/reschedule`, body: clean({ start: str(a.start), provider_id: str(a.provider_id), notify: bool(a.notify) }) }),
  },
  {
    name: 'list_booking_notes',
    title: 'Internal notes of a customer or appointment',
    description:
      "The internal notes about a customer: those written on one appointment (pass booking_id; the customer's other notes come too, marked on_this_booking) or all of a customer's (pass contact). Notes are never shown to the customer.",
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: "An appointment's id or reference. Give this or contact." },
        contact: { type: 'string', description: PHONE_DESC + ' Give this or booking_id.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many (1 to 200), with contact.' },
        cursor: { type: 'string', description: 'The next_cursor of the previous answer, with contact.' },
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Internal notes of a customer or appointment' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'GET',
        path: str(a.booking_id) ? `/bookings/${enc(String(a.booking_id))}/notes` : '/bookings/notes',
        query: queryOf(a, ['contact', 'limit', 'cursor']),
      }),
  },
  {
    name: 'add_booking_note',
    title: 'Add an internal note',
    description:
      "Add an internal note to an appointment or to a customer. The note is signed with the API key's name and is never shown to the customer. booking.note.created is sent.",
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: "The appointment's id or reference the note is about. Give this or contact." },
        contact: { type: 'string', description: PHONE_DESC + ' Give this or booking_id.' },
        body: { type: 'string', description: 'The note, 1 to 4000 characters.' },
        pinned: { type: 'boolean', description: 'true: show it first. Default false.' },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      required: ['body'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: false, title: 'Add an internal note' },
    run: (cfg, a) =>
      str(a.booking_id)
        ? callApi(cfg, { method: 'POST', path: `/bookings/${enc(String(a.booking_id))}/notes`, body: clean({ body: str(a.body), pinned: bool(a.pinned) }), headers: idem(a) })
        : callApi(cfg, { method: 'POST', path: '/bookings/notes', body: clean({ contact: str(a.contact), body: str(a.body), pinned: bool(a.pinned) }), headers: idem(a) }),
  },
  {
    name: 'create_time_block',
    title: 'Block time in the calendar',
    description:
      'Block time so that no one can book it: time off, a break, a closed afternoon. For one staff member (provider_id) or the whole business. Give start and end, or date for a whole day. Existing appointments are not touched. calendar.block.created is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'The start. Local time in the business time zone yyyy-MM-ddTHH:mm, or ISO 8601 with an offset.' },
        end: { type: 'string', description: 'The end, same format. After start, at most 31 days later.' },
        date: { type: 'string', description: 'Instead of start and end: one whole day, YYYY-MM-DD.' },
        provider_id: { type: 'string', description: 'Optional: ' + STAFF_ID + ' Left out: the whole business.' },
        title: { type: 'string', description: 'Optional, up to 80 characters, eg Lunch or Holiday.' },
        notes: { type: 'string', description: 'Optional, up to 500 characters.' },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: false, title: 'Block time in the calendar' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/calendar/blocks',
        body: clean({ start: str(a.start), end: str(a.end), date: str(a.date), provider_id: str(a.provider_id), title: str(a.title), notes: str(a.notes) }),
        headers: idem(a),
      }),
  },
  {
    name: 'delete_time_block',
    title: 'Remove a blocked time',
    description: 'Remove a time block: the time can be booked again. calendar.block.deleted is sent. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: "The block's id (get_calendar lists the blocks)." } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { ...DESTRUCTIVE, title: 'Remove a blocked time' },
    run: (cfg, a) => callApi(cfg, { method: 'DELETE', path: `/calendar/blocks/${enc(String(a.id))}` }),
  },
  {
    name: 'create_booking_link',
    title: 'Make a booking link for a customer',
    description:
      'Make a link that opens the online booking page for a customer: to book, to move an appointment or to manage their appointments. Send the returned url to the customer yourself. Without contact it is a one-off link the customer confirms on WhatsApp. The online booking page must be switched on (the answer says when it is not).',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: PHONE_DESC + ' Needed for purpose reschedule or manage unless booking_id is given.' },
        name: { type: 'string', description: "Optional: the customer's name." },
        purpose: { type: 'string', enum: ['book', 'reschedule', 'manage'], description: 'book (default): pick a new time. reschedule: move booking_id. manage: see, move and cancel their appointments.' },
        booking_id: { type: 'string', description: "The appointment's id or reference, for reschedule / manage." },
        service_id: { type: 'string', description: 'Optional: preselect a service.' },
        provider_id: { type: 'string', description: 'Optional: preselect a staff member.' },
        single_use: { type: 'boolean', description: 'true: the link stops working after one booking.' },
        expires_in_hours: { type: 'integer', minimum: 1, maximum: 1440, description: "Optional: valid for this many hours (1 to 1440). Default: the business's setting." },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: false, title: 'Make a booking link for a customer' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/bookings/links',
        body: clean({
          contact: str(a.contact), name: str(a.name), purpose: str(a.purpose), booking_id: str(a.booking_id), service_id: str(a.service_id), provider_id: str(a.provider_id),
          single_use: bool(a.single_use), expires_in_hours: num(a.expires_in_hours),
        }),
        headers: idem(a),
      }),
  },
  {
    name: 'hold_booking_slot',
    title: 'Hold an appointment time for a few minutes',
    description:
      'Keep a free appointment time for a few minutes so no one else can book it while the customer decides. Answers a hold.reference. Book it with create_booking (pass hold) or it frees itself at hold.expires. 409 booking_slot_taken when the time is not free.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: "The service's id (list_booking_services)." },
        start: { type: 'string', description: 'The time. ' + LOCAL_TIME },
        provider_id: { type: 'string', description: 'Optional: ' + STAFF_ID + ' Left out: the first free one.' },
        contact: { type: 'string', description: PHONE_DESC + ' Optional.' },
        name: { type: 'string', description: "Optional: the customer's name." },
        minutes: { type: 'integer', minimum: 1, maximum: 30, description: 'How long to keep it (1 to 30). Default 10.' },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      required: ['service_id', 'start'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: false, title: 'Hold an appointment time for a few minutes' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/bookings/holds',
        body: clean({ service_id: str(a.service_id), start: str(a.start), provider_id: str(a.provider_id), contact: str(a.contact), name: str(a.name), minutes: num(a.minutes) }),
        headers: idem(a),
      }),
  },
  {
    name: 'get_customer_profile',
    title: "A customer's profile",
    description:
      'Everything about one customer: contact details and tags, upcoming and past appointments, internal notes and reminders, packages with sessions left, payments, visits, no-shows, total paid and the last messages. Use it before talking to or booking for a returning customer.',
    inputSchema: { type: 'object', properties: { contact: { type: 'string', description: PHONE_DESC } }, required: ['contact'], additionalProperties: false },
    annotations: { ...RO, title: "A customer's profile" },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: `/bookings/customers/${enc(String(a.contact))}` }),
  },
  {
    name: 'list_payments',
    title: 'Payments taken for appointments',
    description:
      'The payments of the business: for appointments, package purchases and one-off payment requests, newest first, with their status (open, paid, refunded, expired ...). Paged: pass next_cursor as cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        booking: { type: 'string', description: "Only this appointment's payments (its id or BK-XXXXXX reference)." },
        contact: { type: 'string', description: PHONE_DESC + " Only this customer's payments." },
        status: { type: 'string', description: 'Only this status, eg paid, refunded, pending.' },
        kind: { type: 'string', enum: ['booking', 'request', 'package'], description: 'Only this kind.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many (1 to 200).' },
        cursor: CURSOR,
      },
      additionalProperties: false,
    },
    annotations: { ...RO, title: 'Payments taken for appointments' },
    run: (cfg, a) => callApi(cfg, { method: 'GET', path: '/payments', query: queryOf(a, ['booking', 'contact', 'status', 'kind', 'limit', 'cursor']) }),
  },
  {
    name: 'request_payment',
    title: 'Ask a customer to pay',
    description:
      "Make a payment request: a pay link for an amount, optionally for one appointment. With send true and the customer inside their 24 hour window they get it on WhatsApp with a Pay button; otherwise give them the returned url yourself. Needs Stripe or PayPal connected (409 payments_not_connected). Confirm the amount with the user first.",
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: PHONE_DESC },
        amount: { type: 'number', description: "The amount in the business's payment currency, eg 40 or 12.50." },
        description: { type: 'string', description: 'What it is for, shown to the customer.' },
        booking_id: { type: 'string', description: 'Optional: the appointment it is for (id or BK-XXXXXX).' },
        name: { type: 'string', description: "Optional: the customer's name." },
        send: { type: 'boolean', description: 'true: also send the link on WhatsApp (inside the 24 hour window).' },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      required: ['contact', 'amount', 'description'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Ask a customer to pay' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/payments/links',
        body: clean({ contact: str(a.contact), amount: num(a.amount), description: str(a.description), booking_id: str(a.booking_id), name: str(a.name), send: bool(a.send) }),
        headers: idem(a),
      }),
  },
  {
    name: 'refund_payment',
    title: 'Refund a payment',
    description:
      "Refund a paid payment, in full or a part, through the business's own payment provider. This moves real money back to the customer and cannot be undone. 409 refund_not_possible when it is not paid or too little is left. Always confirm with the user first.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The payment's id (list_payments)." },
        amount: { type: 'number', description: "Optional: a part of the money, in the payment's currency. Left out: everything that is left." },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { ...SEND, title: 'Refund a payment' },
    run: (cfg, a) => callApi(cfg, { method: 'POST', path: `/payments/${enc(String(a.id))}/refund`, body: clean({ amount: num(a.amount) }), headers: idem(a) }),
  },
  {
    name: 'create_meeting_poll',
    title: 'Make a meeting poll',
    description:
      "Offer 2 to 10 possible times and let people vote on them on a web page. The times are not held. Share the returned url. Pick the winner later with the poll's book call. Each time must be free now.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "The poll's title, up to 120 characters." },
        options: { type: 'array', items: { type: 'string', description: LOCAL_TIME }, description: '2 to 10 different start times.' },
        service_id: { type: 'string', description: 'Optional: a service (its length is used). Give this or duration_min.' },
        duration_min: { type: 'integer', minimum: 5, maximum: 480, description: 'The length in minutes (5 to 480) when there is no service.' },
        provider_id: { type: 'string', description: 'Optional: ' + STAFF_ID },
        contact: { type: 'string', description: PHONE_DESC + ' Optional: the main customer; booking the poll makes an appointment for them.' },
        name: { type: 'string', description: "Optional: the main customer's name." },
        description: { type: 'string', description: 'Optional, up to 1000 characters.' },
        closes_at: { type: 'string', description: 'Optional: when voting ends, ISO 8601.' },
        idempotency_key: { type: 'string', description: IDEMPOTENCY },
      },
      required: ['title', 'options'],
      additionalProperties: false,
    },
    annotations: { ...WRITE, idempotentHint: false, title: 'Make a meeting poll' },
    run: (cfg, a) =>
      callApi(cfg, {
        method: 'POST',
        path: '/bookings/polls',
        body: clean({
          title: str(a.title), options: Array.isArray(a.options) ? a.options.map(String) : undefined, service_id: str(a.service_id), duration_min: num(a.duration_min),
          provider_id: str(a.provider_id), contact: str(a.contact), name: str(a.name), description: str(a.description), closes_at: str(a.closes_at),
        }),
        headers: idem(a),
      }),
  },
  {
    name: 'erase_customer_data',
    title: "Erase a customer's booking data",
    description:
      "Erase a customer's booking data on their request (privacy): their future appointments are cancelled without a message, every appointment is anonymised, and their notes, links, holds and poll votes are deleted. This cannot be undone. The contact record and the conversation stay. Only do it when the customer or the business owner has asked for it, and confirm with the user first.",
    inputSchema: { type: 'object', properties: { contact: { type: 'string', description: PHONE_DESC } }, required: ['contact'], additionalProperties: false },
    annotations: { ...DESTRUCTIVE, title: "Erase a customer's booking data" },
    run: (cfg, a) => callApi(cfg, { method: 'DELETE', path: `/bookings/customers/${enc(String(a.contact))}` }),
  },
];

function queryOf(a: Args, keys: string[]): Query {
  const q: Query = {};
  for (const k of keys) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    q[k] = typeof v === 'boolean' || typeof v === 'number' ? v : String(v);
  }
  return q;
}

export const TOOLS_BY_NAME: Map<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));

/** What the MCP client shows in tools/list: everything except the handler. */
export function listTools(): Array<Omit<ToolDefinition, 'run'>> {
  return TOOLS.map(({ run: _run, ...rest }) => rest);
}
