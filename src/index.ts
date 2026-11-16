#!/usr/bin/env node
/**
 * @app2email/mcp: MCP server (stdio) for the app2email WhatsApp API.
 *
 *   APP2EMAIL_API_KEY=a2e_... APP2EMAIL_NUMBER=4976659348270 node dist/index.js      (not on npm yet: build it with npm run build)
 *
 * Environment: APP2EMAIL_API_KEY (required), APP2EMAIL_NUMBER (required), APP2EMAIL_BASE_URL (optional, default
 * https://api.app2email.com/v1), APP2EMAIL_TIMEOUT_MS (optional). Logs go to stderr; stdout is the protocol.
 */
import { configFromEnv } from './rest.js';
import { serveStdio, SERVER_INFO } from './protocol.js';
import { listTools } from './tools.js';

export { TOOLS, listTools } from './tools.js';
export { handleMessage, serveStdio } from './protocol.js';
export { callApi, configFromEnv, ApiError } from './rest.js';

function usage(): string {
  return [
    `app2email-mcp ${SERVER_INFO.version}: MCP server for the app2email WhatsApp API (stdio).`,
    '',
    'Set APP2EMAIL_API_KEY and APP2EMAIL_NUMBER, then start it from your MCP client (Claude Desktop, Claude Code, Cursor, OpenClaw ...).',
    'Options: --help, --version, --list-tools (prints the tool catalogue as JSON and exits)',
    'Docs: https://www.app2email.com/docs/api/mcp  Hosted alternative: https://api.app2email.com/mcp (Authorization: Bearer <API key>)',
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(SERVER_INFO.version + '\n');
    return;
  }
  if (argv.includes('--list-tools')) {
    process.stdout.write(JSON.stringify(listTools(), null, 2) + '\n');
    return;
  }
  let cfg;
  try {
    cfg = configFromEnv();
  } catch (err) {
    process.stderr.write(`app2email-mcp: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const log = (line: string) => process.stderr.write(`app2email-mcp: ${line}\n`);
  log(`ready: number ${cfg.number}, ${listTools().length} tools, ${cfg.baseUrl}`);
  await serveStdio({ cfg, log }, process.stdin, process.stdout);
}

// run only when started as a program (not when imported as a library)
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('/index.js') || entry.endsWith('\\index.js') || entry.endsWith('app2email-mcp');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`app2email-mcp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
