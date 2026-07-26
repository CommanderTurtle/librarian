# Librarian

Librarian is a Hermes-native fork of
[Understory](https://github.com/thecodacus/understory). It preserves
Understory's deterministic
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle and high-level MCP contract while delegating every agentic operation to
a fresh [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
session through the native TUI-gateway JSON-RPC protocol. The original
Understory attribution and Apache-2.0 license are retained in `NOTICE` and
`LICENSE`.

There is no embedded model provider, API client, or second agent loop.

## What stays deterministic

Every read and mutation crosses the private `librarian-okf` MCP boundary.
Understory's `KnowledgeBase` remains the only write path, so it still enforces:

- bundle-relative path sandboxing;
- required OKF frontmatter;
- generated `index.md` files;
- newest-first `log.md` entries;
- serialized mutations;
- optional Git autocommits.

The public MCP retains Understory's original tools:

- `memory_query`
- `memory_add`
- `memory_update`
- `memory_status`
- `memory_maintain`

`memory_status` remains model-free. Every other call creates and persists a
unique Hermes session, streams its JSON-RPC events internally, and closes the
process after the final answer.

## Setup

Requirements:

- a native, configured `hermes` installation;
- Bun, normally supplied by
  [Sandwich](https://github.com/CommanderTurtle/sandwich);
- a reachable model in the selected Hermes profile;
- Git for updates and optional OKF autocommits.

Node.js, npm, pnpm, npx, and yarn are not runtime requirements. Source imports
using the `node:*` namespace run through Bun's compatibility APIs.

```bash
git clone https://github.com/CommanderTurtle/librarian.git
cd librarian
bun run setup
```

Setup is intentionally explicit because it updates Hermes configuration. It
asks for the OKF bundle path, model, and provider, then:

1. installs and builds the Bun workspace;
2. clones the current Hermes profile into an isolated `librarian` profile;
3. registers private `librarian-okf` operations only in that child profile;
4. registers the public `librarian` MCP in the default profile;
5. writes the resolved native paths to `.env`.

The profile split prevents recursive Librarian calls while preserving the
current Hermes provider, tools, skills, and selected MCP servers for delegated
research.

Rerunning `bun run setup` refreshes both MCP registrations without recreating
the profile. Non-default installations can set `HERMES_HOME`,
`HERMES_PROFILE_HOME`, and `HERMES_PYTHON` in `.env` before setup.

Librarian makes no telemetry calls. Knowledge, traces, delegated sessions, and
configuration remain on the machine running Hermes. The optional web server
binds locally by default; use `AUTH_TOKEN` before deliberately exposing it to a
network.

## Optional web browser

The MCP servers are stdio processes and need no persistent service. To browse
the OKF tree, graph, traces, and chat through the same Hermes path:

```bash
./start.sh
```

The default address is `http://localhost:3800`. Set `AUTH_TOKEN` in `.env`
before exposing it beyond a trusted host or LAN.

## Update

```bash
./update.sh
```

The update path rebases with an autostash, performs a frozen Bun install, and
rebuilds all packages. Rerun `bun run setup` only when paths, profile, model, or
MCP registrations change.

## Development

The repository is a private Bun workspace even though its source is public.
Internal `@understory/*` package names preserve the upstream module boundary;
they are not published packages.

```bash
bun install --frozen-lockfile
bun test
bun run build
```

`origin` is the Librarian repository. The original Understory repository is
kept as `upstream` for deliberate review and rebasing:

```bash
git fetch upstream
git log --oneline --left-right main...upstream/main
```

Upstream changes are never pulled implicitly by setup or update scripts.

## Architecture

```text
Hermes default profile
  └─ librarian MCP (memory_*)
       └─ fresh tui_gateway JSON-RPC process per call
            └─ isolated Hermes librarian profile
                 └─ librarian-okf MCP (deterministic OKF operations)
                      └─ plain Markdown bundle
```

Query traces stay local under `<bundle>/.traces/`. Librarian adds no telemetry.

## License

Apache-2.0. Librarian is derived from Understory by Anirban Kar. See
[`NOTICE`](NOTICE) for attribution and [`LICENSE`](LICENSE) for the complete
license.
