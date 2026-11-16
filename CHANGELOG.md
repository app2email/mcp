# Changelog

## 0.1.0 (unreleased)

- 2026-11-07: the appointment booking tools of the hosted core set (`list_bookings`, `get_booking_availability`, `create_booking`, `cancel_booking`, `set_booking_status`, `get_booking_settings`, `update_booking_settings`, `get_booking_reports`, `send_flow`) and `list_flows`.
- 2026-11-06: protocol 2025-11-25 (also 2025-06-18, 2025-03-26, 2024-11-05; a 2026-07-28 client falls back to initialize); every send or change is marked destructive, reads read-only (as the hosted server); `get_conversation_messages` added, so the tool names match the hosted server's core set.

- First version: stdio MCP server with 23 tools over the app2email WhatsApp API v1, offline test, registry server.json.
