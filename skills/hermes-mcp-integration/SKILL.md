---
name: hermes-mcp-integration
description: Build and maintain local Bun MCP servers that delegate agentic work through Hermes's native TUI-gateway JSON-RPC protocol. Use for Librarian, profile-isolated Hermes workers, MCP registration, or Hermes-backed tool servers.
---

# Hermes MCP Integration

Use native Hermes integration boundaries:

- Bun runs TypeScript and JavaScript packages. Do not require Node, npm, pnpm,
  npx, or transient package runners.
- Hermes MCP servers use local, versioned build artifacts over stdio.
- Agentic calls use a fresh Hermes TUI-gateway JSON-RPC process, not an
  OpenAI-compatible inference call and not a shell-scraped chat command.
- A child profile prevents recursive access to the public delegating MCP while
  retaining the chosen Hermes provider, model, and explicitly registered tools.

## Reference implementation

Librarian lives at:

```text
${HERMES_SERVICES_ROOT:-$HOME/Hermes}/librarian
```

Its public server preserves Understory's five-tool contract:

- `memory_query`
- `memory_add`
- `memory_update`
- `memory_status`
- `memory_maintain`

Each call starts an isolated Hermes session through the newline-delimited
TUI-gateway JSON-RPC protocol. Deterministic OKF operations are available only
through the private `librarian-okf` MCP in the `librarian` profile.

## Build and registration

```bash
cd "${HERMES_SERVICES_ROOT:-$HOME/Hermes}/librarian"
bun install --frozen-lockfile
bun run build
bun run setup
```

Run `bun run setup` after a profile path, model, or MCP registration changes.
Ordinary source updates need only a frozen Bun install and build.

The default profile should register the public local artifact:

```text
$HOME/.bun/bin/bun \
  $HERMES_SERVICES_ROOT/librarian/packages/server/dist/mcp/stdio.js
```

The isolated librarian profile registers the private OKF stdio artifact and
must not register the public Librarian server.

## Verification

```bash
hermes mcp list
HERMES_HOME="$HOME/.hermes/profiles/librarian" hermes mcp list
```

Confirm that:

1. the default profile exposes exactly five public Librarian tools;
2. the child profile exposes deterministic `librarian-okf` operations;
3. both profiles use local paths, never `npx`, `bunx`, or remote package specs;
4. a completed call closes its JSON-RPC child process cleanly.

Use the `retrieve-knowledge` skill to decide between Librarian, session recall,
specialized skill retrieval, and codebase-memory. Librarian is for delegated,
durable research and editable OKF knowledge; it is not a replacement for every
lookup.
