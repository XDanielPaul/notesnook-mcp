# Notesnook MCP (experimental)

> **Unofficial personal project.** I am not affiliated with Notesnook or Streetwriters. This project is not endorsed, sponsored, or supported by them.

A local TypeScript MCP server that uses the Notesnook core from the `v3.4.9` app tag. Notes are synced and decrypted locally; no Notesnook credentials or note contents are sent to an AI service except when an MCP tool returns note content to its caller.

## Requirements

- macOS and Node.js 26 (tested with Node `v26.3.0` and npm `11.16`; other versions and operating systems are not validated)
- Git, npm, and Xcode Command Line Tools for building the vendored sodium native module
- Access to your Notesnook sync, auth, and events endpoints

## Install and build

Run from this repository:

```sh
npm run vendor
npm ci
npm run build
```

`npm run vendor` fetches the Notesnook monorepo at `v3.4.9` into the ignored `vendor/` directory, applies the upstream core patches and a Node 26-compatible CommonJS import adjustment for Sodium, then builds the required `@notesnook/*` packages from source. The first run can take several minutes. The tag is configurable with `NOTESNOOK_TAG`, but use a version compatible with your Notesnook server and app. Vendored source is not committed.

## Log in

Run this command in your own terminal; do not send your credentials to an AI agent:

```sh
node dist/cli.js login \
  --api https://api.example.com \
  --auth https://auth.example.com \
  --sse https://events.example.com \
  --monograph https://monograph.example.com
```

Replace the example URLs with your own Notesnook server endpoints; omit `--monograph` if you do not use that service. These hosts must be reachable from your Mac. This server is intended for self-hosted Notesnook and has not been validated with the hosted service.

All endpoints must use HTTPS with valid certificates, including local deployments. Use the final endpoint URLs: HTTP redirects are rejected. Once configured, a profile is bound to its saved server URLs; environment variables and login flags cannot replace them. Run `logout` before changing servers. An interrupted authentication attempt can be retried with `login` using the same saved servers.

The CLI verifies the server endpoints, then prompts locally for email, the 2FA method/code, and password. Email/SMS codes are requested interactively; authenticator-app and recovery codes are entered the same way. The password is not echoed or saved. Login derives the Notesnook encryption key and performs an initial **pull-only** sync. The sync host settings are saved in `~/Library/Application Support/notesnook-mcp/config.json`.

Other CLI commands:

```sh
node dist/cli.js status
node dist/cli.js list 20
node dist/cli.js sync                # pull-only
NOTESNOOK_MCP_ALLOW_WRITE=1 node dist/cli.js sync  # pull + push
node dist/cli.js logout              # revoke session and remove local data/Keychain entries
```

Logout only removes local data after the server confirms revocation (or there is no local account/session to revoke). If the server is unreachable or rejects an expired token, the command fails and retains the local data and keys. Revoke the session through the Notesnook app's session settings if this client cannot do so; local deletion alone does not revoke a remote session.

Only one MCP or CLI process can use a profile at a time. Stop your MCP client before running CLI commands or starting another client. A second process fails with a profile-lock error instead of risking conflicting writes. After a crash or forced termination, a stale empty lock directory may remain beside the data directory (`~/Library/Application Support/notesnook-mcp.lock` by default). Remove it manually only after confirming no process is using the profile. Note updates within a server process are also serialized; edits from other Notesnook devices still depend on upstream sync/conflict handling.

## MCP tools

Start the stdio server with `node dist/cli.js serve`. It syncs on startup and before reads when the previous sync is stale. Read tools fall back to local data if sync is unavailable:

- `search_notes(query, limit)`
- `get_note(id, format?)` — markdown by default; can also return text or HTML
- `list_notebooks()`
- `list_tags()`
- `list_templates()`
- `sync_now()`

Writes are disabled unless `NOTESNOOK_MCP_ALLOW_WRITE=1` is set in the MCP server's environment. When enabled, `create_note(title, content, format?, notebookId?, tagIds?)` and `update_note(id, title?, content?, format?, mode?)` are available. Updates append content by default; choose `mode: "replace"` to replace it. Organization tools are also enabled: `create_notebook(title, description?, parentId?)` (nested notebooks), `create_tag(title)` and `organize_note(id, notebookIds?, tagIds?, pinned?, favorite?)` (add-only), plus `create_from_template` (see Templates). Link notes in markdown with `[text](nn://note/<noteId>)`. The write tools sync changes back to the server. There is no delete tool.

## Templates

Notesnook has no built-in note templates, so the MCP treats every note in a notebook named `Templates` (override with `NOTESNOOK_MCP_TEMPLATES_NOTEBOOK`) as a template:

- `list_templates` lists them.
- `create_from_template(templateId, title?, notebookId?, tagIds?, variables?)` (write mode) copies the template, fills `{{date}}` (YYYY-MM-DD), `{{time}}`, `{{weekday}}`, `{{title}}` and any custom `{{name}}` from `variables`, titles the note `{{date}}` by default, and files it in the notebook with the same name as the template (template "Daily Log" → notebook "Daily Log") unless `notebookId` is given.

Create templates in the Notesnook app by adding notes to the `Templates` notebook.

## Register in Copilot CLI

Merge this entry into `~/.copilot/mcp-config.json` (preserve any existing entries and replace the repository path with its absolute path):

```json
{
  "mcpServers": {
    "notesnook": {
      "command": "node",
      "args": ["/Users/you/work/notesnook-mcp/dist/cli.js", "serve"]
    }
  }
}
```

For write access, add the server environment variable explicitly:

```json
"env": {
  "NOTESNOOK_MCP_ALLOW_WRITE": "1"
}
```

Restart Copilot CLI after editing its MCP config.

## Register in Claude Desktop

Merge this into Claude Desktop's `claude_desktop_config.json`; use an absolute path for both Node and the script:

```json
{
  "mcpServers": {
    "notesnook": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/you/work/notesnook-mcp/dist/cli.js", "serve"]
    }
  }
}
```

Add the same `"env"` object above only if write tools are intentionally enabled. Restart Claude Desktop after changing its config.

## Local data and security

- Local data is stored under `~/Library/Application Support/notesnook-mcp/`; the directory is mode `0700`, and its config/SQLite files are mode `0600`.
- The local SQLite database is encrypted with a random key. The macOS Keychain stores that database key and the derived Notesnook decryption key. The Notesnook core stores session/access and refresh tokens inside the encrypted SQLite database. The user's password is never persisted.
- Together, the Keychain entries and local encrypted database grant full access to the account's locally synced notes. Protect the macOS account and Keychain; use `logout` to revoke the Notesnook session and wipe this local data.
- MCP tool output contains note contents. Any agent/client connected to this MCP server can read those contents; only connect it to clients you trust.
- Write tools are off by default. Enable them only for clients you trust. The server never offers note deletion.
- Attachments and vault-locked note contents are not supported by this prototype. Notes remain end-to-end encrypted in transit and on the Notesnook server; decryption happens locally.
- Server URLs and email are saved locally; no credentials or note contents are written into this repository.

## Validation

```sh
npm test
```

The automated tests cover crypto initialization, markdown/text conversion, templates, sync modes, endpoint validation, profile locking, revocation failures, and concurrent note updates. A real account login and server sync require the user to run `login` interactively.

Account login, MFA and authenticated sync have not yet been exercised end-to-end. Before relying on this server with your account, run `login` and `status`, then verify that `list` and an MCP `get_note` return the expected contents. Leave write mode disabled until you have also tested writes on notes you can afford to restore.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). Notesnook source is fetched separately into the ignored `vendor/` directory and remains subject to its own licenses.
