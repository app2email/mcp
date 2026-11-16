/**
 * Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * Stdout carries protocol messages only; everything else (logs) goes to stderr.
 * Protocol versions (initialize era): 2025-11-25 (preferred), 2025-06-18, 2025-03-26, 2024-11-05. The client picks, we answer with the same
 * string when we know it, otherwise with our newest (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation).
 * A 2026-07-28 client on stdio probes with server/discover first; this server answers -32601 (not a 2026-07-28 error), so the client falls back to
 * initialize (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#backward-compatibility). The hosted server
 * (https://api.app2email.com/mcp) also speaks 2026-07-28 itself.
 */
import { describeError, type RestConfig } from './rest.js';
import { listTools, TOOLS_BY_NAME } from './tools.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: 'app2email', title: 'app2email WhatsApp', version: '0.1.0' };

export const INSTRUCTIONS = `app2email sends and receives WhatsApp Business messages for one WhatsApp number (the account owner's number, registered on app2email.com).
Start with check_key, then list_templates. A new conversation, or a contact whose 24 hour window is closed, needs an APPROVED template (send_template); inside the window a plain message works (send_text, send_media, send_interactive). get_conversation tells you whether the window is open and who owns the conversation.
Every send reaches a real person and counts against the customer's plan: confirm recipients and content with the user unless they already told you to send. Never send marketing to numbers on the Do Not Call list (the API refuses them) or without consent. Use dry_run on send_template to validate values first. When a call fails, read how_to_fix and example_request in the error and repair the request instead of retrying blindly.`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface ServerOptions {
  cfg: RestConfig;
  log?: (line: string) => void;
}

/** Handles one decoded JSON-RPC message. Returns the response to write, or null for notifications. */
export async function handleMessage(opts: ServerOptions, raw: unknown): Promise<JsonRpcResponse | null> {
  const msg = raw as JsonRpcRequest;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: (msg as JsonRpcRequest)?.id ?? null, error: { code: INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' } };
  }
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  const params = msg.params ?? {};

  try {
    switch (msg.method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: listTools() } };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return { jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` } };
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
        const missing = (tool.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
        if (missing.length > 0) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` }],
              structuredContent: { error: { code: 'missing_argument', message: `Missing: ${missing.join(', ')}` } },
            },
          };
        }
        try {
          const result = await tool.run(opts.cfg, args);
          const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: structured },
          };
        } catch (err) {
          const d = describeError(err);
          opts.log?.(`tool ${name} failed: ${d.text.split('\n')[0]}`);
          return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: d.text }], structuredContent: d.structured } };
        }
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'resources/templates/list':
        return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      case 'logging/setLevel':
        return { jsonrpc: '2.0', id, result: {} };
      case 'completion/complete':
        return { jsonrpc: '2.0', id, result: { completion: { values: [], hasMore: false } } };
      default:
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` } };
    }
  } catch (err) {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Reads newline-delimited JSON from `input`, writes answers to `output`. Resolves when the input ends. */
export function serveStdio(opts: ServerOptions, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const write = (resp: JsonRpcResponse) => {
    output.write(JSON.stringify(resp) + '\n');
  };
  let buffer = '';
  let chain: Promise<void> = Promise.resolve();

  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
          continue;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of messages) {
          // one at a time, in order: an agent may send a read then a write that depends on it
          chain = chain.then(async () => {
            const resp = await handleMessage(opts, m);
            if (resp) write(resp);
          });
        }
      }
    });
    input.on('end', () => {
      chain.then(() => resolve());
    });
    input.on('error', () => resolve());
  });
}
