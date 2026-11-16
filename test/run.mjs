// Offline test: a fake app2email REST API (node:http) + the built server spoken to over stdio, like an MCP client would.
// Run with: npm test   (builds first). Exit code 0 = every check passed.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const NUMBER = '4976659348270';
const KEY = 'a2e_test_key';

const seen = []; // every request the fake API got: { method, path, auth, body }

const fake = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, 'http://fake');
  const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
  seen.push(rec);
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '7' } : {}) });
    res.end(JSON.stringify(obj));
  };
  if (rec.auth !== `Bearer ${KEY}`) return send(401, { success: false, request_id: 'r401', error: { code: 'invalid_api_key', message: 'bad key', how_to_fix: 'use a real key' } });
  const p = url.pathname.replace(`/v1/${NUMBER}`, '');
  if (req.method === 'GET' && p === '/me') return send(200, { success: true, request_id: 'rme', key_valid: true, number: NUMBER, plan: 'standard_5000', key: { scopes: ['*'] } });
  if (req.method === 'GET' && p === '/templates') return send(200, { success: true, request_id: 'rt', templates: [{ name: 'order_update', status: 'APPROVED' }] });
  if (req.method === 'POST' && p === '/messages') {
    if (rec.body.type === 'text' && rec.body.to === '61400000000') {
      return send(422, { success: false, request_id: 'r422', error: { code: 'outside_24h_window', message: 'The window is closed', how_to_fix: 'Send an approved template instead', is_retriable: false } });
    }
    if (rec.body.type === 'template') return send(200, { success: true, request_id: 'rtpl', message_id: 'wamid.1', status: rec.body.dry_run ? 'dry_run' : 'accepted', to: rec.body.to });
    return send(200, { success: true, request_id: 'rtxt', message_id: 'wamid.2', status: 'accepted' });
  }
  if (req.method === 'GET' && p === '/conversations/61412345678') return send(200, { success: true, request_id: 'rc', contact: '61412345678', window_open: true, owner: '' });
  if (req.method === 'GET' && p === '/conversations/61412345678/messages') return send(200, { success: true, request_id: 'rcm', messages: [{ message_id: 'wamid.3', text: 'hi' }], next_cursor: null });
  if (req.method === 'PUT' && p === '/conversations/61412345678/owner') return send(200, { success: true, request_id: 'ro', owner: rec.body.owner });
  if (req.method === 'GET' && p === '/usage') return send(429, { success: false, request_id: 'r429', error: { code: 'rate_limited', message: 'slow down', how_to_fix: 'wait' } });
  return send(404, { success: false, request_id: 'r404', error: { code: 'not_found', message: `no route ${req.method} ${p}`, how_to_fix: '' } });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

const child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
  env: { ...process.env, APP2EMAIL_API_KEY: KEY, APP2EMAIL_NUMBER: NUMBER, APP2EMAIL_BASE_URL: `http://127.0.0.1:${port}/v1` },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    } else {
      console.error('unexpected message from server:', line);
    }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

await check('initialize negotiates the protocol version and lists tools capability', async () => {
  const r = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'app2email');
  assert.match(r.result.instructions, /24 hour/);
});
notify('notifications/initialized', {});

await check('an unknown protocol version falls back to the newest we support', async () => {
  const r = await call('initialize', { protocolVersion: '2030-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(r.result.protocolVersion, '2025-11-25');
});

await check('initialize 2025-11-25 is answered with 2025-11-25', async () => {
  const r = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(r.result.protocolVersion, '2025-11-25');
});

await check('a 2026-07-28 probe (server/discover) gets -32601, so a dual-era client falls back to initialize', async () => {
  const r = await call('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  assert.equal(r.error.code, -32601);
});

await check('ping', async () => {
  const r = await call('ping', {});
  assert.deepEqual(r.result, {});
});

await check('tools/list has the curated set with annotations and schemas', async () => {
  const r = await call('tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  for (const n of ['check_key', 'list_templates', 'send_template', 'send_text', 'get_conversation', 'get_conversation_messages', 'set_conversation_owner', 'list_contacts', 'approve_send']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  const send = r.result.tools.find((t) => t.name === 'send_text');
  assert.equal(send.annotations.readOnlyHint, false);
  assert.equal(send.annotations.destructiveHint, true, 'a send is destructive');
  assert.equal(send.annotations.openWorldHint, true);
  for (const t of r.result.tools) assert.notEqual(t.annotations.readOnlyHint, t.annotations.destructiveHint, `${t.name}: read-only or destructive, one of them`);
  assert.deepEqual(send.inputSchema.required, ['to', 'text']);
  const ro = r.result.tools.find((t) => t.name === 'list_messages');
  assert.equal(ro.annotations.readOnlyHint, true);
  for (const t of r.result.tools) {
    assert.ok(t.title && t.description && t.inputSchema.type === 'object', `tool ${t.name} incomplete`);
    assert.ok(!('run' in t), 'handler leaked into tools/list');
  }
});

await check('tools/call check_key sends the bearer key and returns structuredContent', async () => {
  const r = await call('tools/call', { name: 'check_key', arguments: {} });
  assert.equal(r.result.isError, undefined);
  assert.equal(r.result.structuredContent.key_valid, true);
  assert.equal(seen.at(-1).path, `/v1/${NUMBER}/me`);
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
  assert.match(r.result.content[0].text, /standard_5000/);
});

await check('send_template builds a Cloud API body, passes Idempotency-Key and dry_run', async () => {
  const r = await call('tools/call', {
    name: 'send_template',
    arguments: { to: '61412345678', template_name: 'order_update', components: [{ type: 'body', parameters: [{ type: 'text', text: 'John' }] }], dry_run: true, idempotency_key: 'order-1' },
  });
  assert.equal(r.result.structuredContent.status, 'dry_run');
  const req = seen.at(-1);
  assert.equal(req.method, 'POST');
  assert.equal(req.body.type, 'template');
  assert.equal(req.body.template.name, 'order_update');
  assert.equal(req.body.template.language.code, 'en');
  assert.equal(req.body.dry_run, true);
});

await check('send_text outside the window comes back as an isError result with how_to_fix, not a protocol error', async () => {
  const r = await call('tools/call', { name: 'send_text', arguments: { to: '+61 400 000 000', text: 'hello' } });
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /outside_24h_window/);
  assert.match(r.result.content[0].text, /Send an approved template/);
  assert.equal(r.result.structuredContent.error.code, 'outside_24h_window');
  assert.equal(r.result.structuredContent.error.is_retriable, false);
  assert.equal(seen.at(-1).body.to, '61400000000', 'number was not normalised to digits');
});

await check('get_conversation merges the conversation and its messages', async () => {
  const r = await call('tools/call', { name: 'get_conversation', arguments: { contact: '61412345678', limit: 5 } });
  assert.equal(r.result.structuredContent.window_open, true);
  assert.equal(r.result.structuredContent.messages.length, 1);
});

await check('get_conversation_messages pages one contact with since and cursor', async () => {
  const r = await call('tools/call', { name: 'get_conversation_messages', arguments: { contact: '+61 412 345 678', limit: 5, cursor: 'c1' } });
  assert.equal(r.result.isError, undefined);
  assert.equal(seen.at(-1).path, `/v1/${NUMBER}/conversations/61412345678/messages`);
  assert.deepEqual(seen.at(-1).query, { limit: '5', cursor: 'c1' });
});

await check('set_conversation_owner uses PUT .../owner', async () => {
  const r = await call('tools/call', { name: 'set_conversation_owner', arguments: { contact: '61412345678', owner: 'human', reason: 'asked for a person', summary: 'wants a refund' } });
  assert.equal(r.result.structuredContent.owner, 'human');
  assert.equal(seen.at(-1).method, 'PUT');
  assert.deepEqual(seen.at(-1).body, { owner: 'human', reason: 'asked for a person', summary: 'wants a refund' });
});

await check('a 429 carries retry_after_seconds and is_retriable', async () => {
  const r = await call('tools/call', { name: 'get_usage', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.equal(r.result.structuredContent.error.retry_after_seconds, 7);
  assert.equal(r.result.structuredContent.error.is_retriable, true);
});

await check('a missing required argument is reported without calling the API', async () => {
  const before = seen.length;
  const r = await call('tools/call', { name: 'get_template', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /name/);
  assert.equal(seen.length, before);
});

await check('an unknown tool is a JSON-RPC invalid params error', async () => {
  const r = await call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(r.error.code, -32602);
});

await check('an unknown method is -32601', async () => {
  const r = await call('nope/nothing', {});
  assert.equal(r.error.code, -32601);
});

await check('resources/list and prompts/list answer empty lists', async () => {
  assert.deepEqual((await call('resources/list', {})).result, { resources: [] });
  assert.deepEqual((await call('prompts/list', {})).result, { prompts: [] });
});

child.stdin.end();
await new Promise((r) => child.on('exit', r));
fake.close();

if (!/ready: number 4976659348270/.test(stderr)) {
  failures++;
  console.log('FAIL startup line missing on stderr:', stderr);
}
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
