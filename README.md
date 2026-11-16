# @app2email/mcp

[MCP](https://modelcontextprotocol.io) server for the [app2email](https://www.app2email.com) WhatsApp API. It lets an AI agent (Claude, ChatGPT, Cursor, OpenClaw, Windsurf, Codex, any MCP client) send WhatsApp Business template messages and replies, read conversations, hand a conversation to a person, manage contacts and the Do Not Call list, through your own WhatsApp number registered on app2email.

Zero dependencies. Node 18 or newer. Talks to `https://api.app2email.com/v1/{number}/...` with your API key.

Two ways to use it:

| | Hosted (recommended) | Local (this package) |
| --- | --- | --- |
| Transport | Streamable HTTP at `https://api.app2email.com/mcp` | stdio, a process on your machine |
| Auth | `Authorization: Bearer YOUR_API_KEY` (the key identifies the number) | `APP2EMAIL_API_KEY` + `APP2EMAIL_NUMBER` in the environment |
| Protocol | 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 |
| Tools | every tool of the API (https://www.app2email.com/docs/api/mcp) | the core set below |

This package is **not on npm yet**: build it from this folder (`npm install && npm run build`) and start `dist/index.js` with node. Hosted setup for each client: https://www.app2email.com/docs/api/mcp

## What you need

1. A WhatsApp Business number registered on app2email with a paid plan (Standard or Professional).
2. An API key: https://www.app2email.com/dashboard/apikey. Create a key **for the agent** with only the scopes it needs (`messages:read` and `messages:send` for most agents; `contacts:manage` for contact work; `dnc:manage` to manage opt-outs). A **sandbox** key simulates sends without reaching anyone and without counting against your plan: use one while you build.
3. The number itself, digits only with the country code (the number you send *from*), eg `4976659348270`.

Keep the key on your machine or server. Never paste it into a chat.

## Install (local build)

```sh
npm install && npm run build        # in this folder; dist/index.js is the server
```

### Claude Desktop, Cursor, Windsurf

`claude_desktop_config.json` (Settings > Developer > Edit Config), `.cursor/mcp.json` or `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "app2email": {
      "command": "node",
      "args": ["/path/to/sdk/mcp/dist/index.js"],
      "env": { "APP2EMAIL_API_KEY": "YOUR_API_KEY", "APP2EMAIL_NUMBER": "4976659348270" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add app2email --env APP2EMAIL_API_KEY=YOUR_API_KEY --env APP2EMAIL_NUMBER=4976659348270 -- node /path/to/sdk/mcp/dist/index.js
```

Hosted instead:

```sh
claude mcp add --transport http app2email https://api.app2email.com/mcp --header "Authorization: Bearer YOUR_API_KEY"
```

### OpenClaw

```json5
{
  mcp: {
    servers: {
      app2email: { url: "https://api.app2email.com/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${APP2EMAIL_API_KEY}" } },
    },
  },
}
```

OpenClaw users who want WhatsApp as a **channel** (the agent answers WhatsApp messages as they arrive) should install the channel plugin `@app2email/openclaw-whatsapp` instead; this MCP server is for an agent that *acts* on WhatsApp when asked.

### Other clients

A client that starts a stdio server: command `node`, args `/path/to/sdk/mcp/dist/index.js`, environment `APP2EMAIL_API_KEY`, `APP2EMAIL_NUMBER`. A client that takes a URL: `https://api.app2email.com/mcp` with the `Authorization: Bearer` header.

## Tools

| Tool | Does | Hints |
| --- | --- | --- |
| `check_key` | Checks the key: number, plan, scopes, limits | read-only |
| `list_templates`, `get_template` | Approved templates and the values each needs, with an example request | read-only |
| `send_template` | Sends an approved template to one number, a list, or a segment; `dry_run` checks without sending; `send_at` schedules | destructive |
| `send_text`, `send_media`, `send_interactive` | Free-form text, image/video/document, buttons or list to one contact inside the 24 hour window | destructive |
| `get_message`, `list_messages` | Delivery status of sent messages, received messages | read-only |
| `list_events`, `wait_for_message` | The number's events fetched instead of pushed (no webhook address needed); waiting for a contact's next message | read-only |
| `list_conversations`, `get_conversation`, `get_conversation_messages` | Contacts, whether the reply window is open, who owns the conversation, one contact's messages | read-only |
| `set_conversation_owner` | Hands a conversation to a person (`human`), claims it (`agent`), pauses it, or restores default routing; with reason and summary | destructive |
| `list_contacts`, `upsert_contact` | Contacts with tags, custom fields and consent evidence | read-only / destructive |
| `get_usage` | Plan usage; with `meta: true` the indicative Meta charges | read-only |
| `list_broadcasts`, `get_broadcast`, `cancel_broadcast` | Broadcast status and results; cancel a scheduled or sending broadcast | read-only / destructive |
| `list_donotcall`, `add_donotcall`, `remove_donotcall` | The Do Not Call list | read-only / destructive |
| `list_approvals`, `approve_send` | Sends held for a human OK (keys with an approval threshold) | read-only / destructive |
| `list_bookings`, `get_booking_availability`, `get_booking_reports` | Appointments, free slots, booking numbers | read-only |
| `create_booking`, `cancel_booking`, `set_booking_status` | Book, cancel, mark completed or no-show (the customer is told on WhatsApp) | destructive |
| `get_booking_settings`, `update_booking_settings` | Booking settings: services, hours, messages, calendar, staff | read-only / destructive |
| `list_flows`, `send_flow` | WhatsApp Flows (Book-and-Pay Flows carry `key`, `can_send`); send one inside the 24 hour window | read-only / destructive |
| `get_calendar`, `list_booking_services`, `find_next_booking_slots` | The business calendar, the services with their staff, the next free times | read-only |
| `update_booking`, `reschedule_booking` | Change an appointment's details, move it to another time (the customer is told) | destructive |
| `list_booking_notes`, `add_booking_note` | Internal notes about a customer or an appointment | read-only / destructive |
| `create_time_block`, `delete_time_block` | Block time (time off, breaks) and free it again | destructive |
| `create_booking_link`, `hold_booking_slot`, `create_meeting_poll` | A link to the online booking page, a time held for a few minutes, a poll of possible times | destructive |
| `get_customer_profile`, `erase_customer_data` | Everything about one customer; erase their booking data on request | read-only / destructive |
| `list_payments`, `request_payment`, `refund_payment` | Payments, a pay link for a customer, a refund | read-only / destructive |

A read is read-only; every send or change is destructive, so the client asks before it runs one (the same hints as the hosted server).

Every tool returns the API's answer as text and as `structuredContent`. A failed call is an `isError` result that carries the API's `code`, `message`, `how_to_fix`, `is_retriable`, `retry_after_seconds` and, for template mistakes, an `example_request` to copy from.

`node dist/index.js --list-tools` prints the catalogue as JSON.

## How an agent should use it

1. `check_key`, then `list_templates`.
2. Starting a conversation, or `window_open` is false: `send_template` (an approved template). Inside the window: `send_text` / `send_media` / `send_interactive`.
3. Use `dry_run: true` on `send_template` to validate values; use an `idempotency_key` so a retry never sends twice.
4. When a person must take over: `set_conversation_owner` with `owner: "human"`, a reason and a summary. The person gets it by email (the app2email bridge) or on the dashboard.
5. Never send marketing to numbers on the Do Not Call list (the API refuses) or without consent.

The server's `instructions` field says the same to the model at connect time.

## Rules and limits

- WhatsApp allows free-form messages only within 24 hours of the contact's last message. Otherwise send an approved template. The API answers `422 outside_24h_window` when the window is closed.
- Sends count against the number's monthly plan (outgoing WhatsApp messages and outgoing emails together). `get_usage` shows what is left.
- Rate limit per key; a `429 rate_limited` answer carries `retry_after_seconds`.
- A key's scopes limit what the tools may do (`403 insufficient_scope`).

## Development

```sh
npm install
npm test          # builds, then runs test/run.mjs against a fake API over stdio
```

`src/tools.ts` is the tool catalogue (name, title, description, input schema, annotations, REST call). `src/protocol.ts` is the stdio JSON-RPC loop. `src/rest.ts` is the API client.

## Links

- MCP setup and the hosted tool list: https://www.app2email.com/docs/api/mcp
- API reference: https://www.app2email.com/docs/api (for agents: https://www.app2email.com/llms.txt, https://www.app2email.com/docs-api.md)
- OpenAPI: https://api.app2email.com/v1/openapi.json
- Support: support@app2email.com
