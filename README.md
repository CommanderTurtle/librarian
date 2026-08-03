# Librarian

Librarian is an RPC-native fork of
[Understory](https://github.com/thecodacus/understory). It preserves
Understory's deterministic
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle and high-level MCP contract while delegating agentic work to an existing
agent harness. [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
is the default backend; [OMP](https://github.com/can1357/oh-my-pi) is an optional
backend selected with `LIBRARIAN_AGENT_BACKEND=omp`.

There is no embedded model provider, API client, or second agent loop. Hermes
uses its native TUI-gateway JSON-RPC protocol. OMP uses its distinct native
[JSONL RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

## What stays deterministic

Every deep read and mutation crosses the private `librarian-okf` MCP boundary.
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

`memory_status` is model-free. Every deep operation starts a fresh isolated
agent turn, streams native tool events internally, and closes the worker after
the final answer.

## Layered memory and dreaming

The current upstream cache and dreaming work is included without restoring
Understory's embedded model provider:

1. an exact query cache is keyed by the bundle fingerprint, backend, model,
   provider, and normalized question;
2. a short-lived hot set checks recently changed concepts and recent answers;
3. a miss delegates to the full Librarian agent and its private OKF tools.

Any bundle change invalidates exact answers. Hot answers are accepted only when
the selected harness returns a tool-free response; otherwise the request falls
through to the deep agent.

The optional persistent web service can also run conservative memory
consolidation. Set `DREAM_INTERVAL=6h` (or another duration) to enable it.
Dreaming is disabled by default, never runs at startup, never overlaps itself,
and does not run in ephemeral stdio MCP processes.

## Setup

Requirements:

- Bun, normally supplied by
  [Sandwich](https://github.com/CommanderTurtle/sandwich);
- either a configured native `hermes` installation or a configured `omp`
  installation;
- a reachable model in the selected backend/profile;
- Git for updates and optional OKF autocommits.

Node.js, npm, pnpm, npx, and yarn are not runtime requirements. Source imports
using the `node:*` namespace run through Bun's compatibility APIs.

```bash
git clone https://github.com/CommanderTurtle/librarian.git
cd librarian
bun run setup
```

Setup asks for the delegated backend, OKF bundle, model, and provider, then
builds the Bun workspace and writes resolved paths to `.env`.

### Hermes backend (default)

Setup clones the current Hermes profile into an isolated `librarian` profile,
registers `librarian-okf` only in that child profile, and registers the public
`librarian` MCP in the default profile. This prevents recursive `memory_*`
calls while preserving Hermes as the sole agent loop.

Rerunning setup refreshes both registrations without recreating the profile.
Non-default installations can set `HERMES_HOME`, `HERMES_PROFILE_HOME`, and
`HERMES_PYTHON`.

### OMP backend

Set `LIBRARIAN_AGENT_BACKEND=omp` before setup or select `omp` at the prompt.
Setup follows OMP's native
[profile-scoped MCP configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md):

- the public `librarian` MCP is merged into `~/.omp/agent/mcp.json`;
- private `librarian-okf` operations are merged into
  `~/.omp/profiles/librarian/agent/mcp.json`;
- delegated workers launch as `omp --profile librarian --mode rpc --no-session`.

The two profile files are deliberately separate. The worker profile cannot
discover its own public `memory_*` server, so a delegated call cannot recurse
back into Librarian. Override `OMP_HOME`, `OMP_AGENT_DIR`,
`OMP_PROFILE_AGENT_DIR`, `OMP_PROFILE`, or `OMP_COMMAND` for a non-default
layout. `OMP_MODEL` plus `OMP_PROVIDER` select a model explicitly; blank values
inherit the active OMP profile.

Librarian makes no telemetry calls of its own. Knowledge, traces, delegated
sessions, and configuration remain on the machine running the chosen harness.

## Optional web browser

The MCP servers are stdio processes and require no persistent Librarian
service. To browse the OKF tree, graph, traces, and chat through the selected
backend:

```bash
./start.sh
```

The default address is `http://localhost:3800`. Set `AUTH_TOKEN` before
exposing it beyond a trusted host or LAN. Only this persistent process runs the
optional dream scheduler.

## Update

```bash
./update.sh
```

The update path rebases the Librarian repository with an autostash, performs a
frozen Bun install, and rebuilds every package. Rerun `bun run setup` only when
paths, backend, profile, model, or MCP registrations change.

## Development

The repository is a private Bun workspace even though its source is public.
Internal `@understory/*` package names preserve the upstream module boundary;
they are not published packages.

```bash
bun install --frozen-lockfile
bun test
bun run build
```

`origin` is the Librarian repository. Understory remains `upstream` so its work
can be reviewed and merged deliberately:

```bash
git fetch upstream --prune
git log --oneline --left-right main...upstream/main
```

Setup and update scripts never pull Understory implicitly.

## Architecture

```text
Hermes default profile                    OMP default profile
  └─ librarian MCP (memory_*)               └─ librarian MCP (memory_*)
       └─ fresh TUI-gateway process               └─ fresh OMP RPC process
            └─ isolated librarian profile              └─ isolated librarian profile
                 └─ librarian-okf MCP                        └─ librarian-okf MCP
                      └─ Markdown OKF bundle                       └─ Markdown OKF bundle
```

Query traces stay local under `<bundle>/.traces/`.

## License

AGPL-3.0-only. Librarian is a modified derivative of Understory by Anirban Kar.
See [`NOTICE`](NOTICE) for upstream attribution and [`LICENSE`](LICENSE) for the
complete license.
