# Publishing @app2email/mcp

Nothing here has been run. Steps for the owner, in order. Names were checked on 2 Nov 2026: `@app2email/mcp` is free on npm (the `@app2email` scope must be created by the npm account that publishes; `npm login` then `npm publish --access public` creates it).

## 1. Put the package in its own GitHub repository

`server.json` and `package.json` point at `https://github.com/app2email/mcp`. Create that repository (public) and push this folder as its root. The MCP registry, Claude's connector directory and npm provenance all want a public source.

## 2. Publish to npm

```sh
cd sdk/mcp
npm install
npm test                       # must pass
npm login                      # the account that owns the @app2email scope
npm publish --access public --provenance   # provenance needs a GitHub Actions or a trusted-publishing run; without it drop --provenance
```

`package.json` already carries `"mcpName": "com.app2email/whatsapp"`: the MCP registry reads it to prove the npm package belongs to the registry entry.

After the first publish, set up trusted publishing on npm (package settings > Publishing access > GitHub Actions) and use the workflow in `.github/workflows/publish-npm.yml` (tag `v0.1.0` → publish with provenance).

## 3. Register in the official MCP registry

The name `com.app2email/whatsapp` is a reverse-DNS namespace: the registry must see that you control `app2email.com`. One-off:

```sh
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem        # keep this file private
PUBLIC_KEY="$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=$PUBLIC_KEY"
```

Either add a DNS TXT record on the apex `app2email.com` with that value (`app2email.com. IN TXT "v=MCPv1; k=ed25519; p=..."`), or serve the same line at `https://app2email.com/.well-known/mcp-registry-auth` (plain text, 200, no redirect; note the registry fetches the apex domain, and app2email.com redirects to www: the DNS record is the safer choice).

Then:

```sh
brew install mcp-publisher      # or the install script from https://github.com/modelcontextprotocol/registry
cd sdk/mcp
mcp-publisher login dns --domain app2email.com --private-key "$(openssl pkey -in mcp-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64)"
mcp-publisher publish           # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.app2email/whatsapp"
```

The `remotes` entry (`https://api.app2email.com/mcp`) is listed at the same time. Publish only after the hosted endpoint is deployed, or remove `remotes` from `server.json` for the first publish and add it in the next version.

## 4. Directory listings

- **Claude connectors directory** (claude.ai > Settings > Connectors > "Submit a connector", or the form on https://www.anthropic.com/partners): needs the hosted server with OAuth 2.1. Until app2email has OAuth, the hosted endpoint is usable in Claude Code and Cursor with the bearer header, and this npm package in Claude Desktop.
- **ChatGPT apps directory**: same requirement (hosted + OAuth). Track it for the OAuth phase.
- **Cursor MCP directory** (https://cursor.com/directory): submit the npm package; a one-click install link is `cursor://anysphere.cursor-deeplink/mcp/install?name=app2email&config=<base64 of the mcpServers entry>`.
- **Smithery, Glama, PulseMCP** and similar aggregators read the official registry; nothing to do after step 3.
- **OpenClaw**: `docs.openclaw.ai/cli/mcp/registry` lists registry servers inside OpenClaw automatically once step 3 is done.

## 5. Versioning

Bump `version` in `package.json`, `server.json` (top level and inside `packages[0]`) and `SERVER_INFO.version` in `src/protocol.ts` together. Tag `vX.Y.Z`. Re-run `mcp-publisher publish` for every version (the registry keeps one entry per version).
