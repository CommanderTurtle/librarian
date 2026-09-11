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

The optional persistent web service also runs conservative memory consolidation.
It checks every six hours by default, with the first check delayed ten minutes
after startup. Set `DREAM_INTERVAL` to another duration or to `off`; set
`DREAM_START_DELAY` independently when a different first-check delay is useful.
Checks are scheduled only after the preceding run finishes, never overlap, and
do not run in ephemeral stdio MCP processes. A dream runs against an isolated
copy of the bundle and saves a pending proposal; it never changes live memory
by itself. The fresh Hermes or OMP process passes a process-local bundle override
to its private `librarian-okf` MCP, so the agent's actual read/write tool calls
are confined to that copy without rewriting either harness profile. Only one
pending proposal is permitted, so an unattended scheduler cannot accumulate
competing plans against the same baseline.

The web UI's **Dreams** view auto-refreshes proposal history and scheduler state,
shows the next and previous checks, highlights changed lines in every exact
before/after diff, and confirms each apply/reject/rollback action. Its guided
add, update, and maintenance routes use the same isolated proposal path. A
versioned `librarian.bundle.v1` JSON export can be merged or replace-staged as a
deterministic proposal; import never writes before review. Only the human-only
HTTP approval route can resolve a proposal; no model-facing MCP tool has
approval authority. Approval first verifies both the stored proposal hashes
and every live concept baseline. Applied proposals retain their preimages and
can be rolled back from the same view, while a later concept change blocks
rollback rather than overwriting newer knowledge. Interrupted multi-file apply
or rollback operations compensate completed edits and retain an explicit error
when compensation cannot fully restore the prior state. This adapts Prime
Agent's plan/apply/rollback refinement lifecycle and LongHorizon-Harness'
persisted human gate without adding another agent loop. All web dream controls
require `AUTH_TOKEN`; without it proposals are read-only and the control routes
fail closed. The UI's **Deauthorize** action forgets its browser-local bearer
token; the server remains stateless.

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
builds the Bun workspace, writes resolved paths to `.env`, and reconciles both
installed harnesses. The backend choice controls only the private delegated
worker; the public five-tool Librarian MCP is available in every ordinary
Hermes and OMP profile. Public calls always use their caller's native RPC path:
Hermes registrations launch Hermes and OMP registrations launch OMP, regardless
of which backend runs the private dream worker.

### Hermes backend (default)

Setup clones the current Hermes profile into an isolated `librarian` profile,
converges that worker to the `librarian-okf` MCP alone, and registers the public
`librarian` MCP in the default profile plus every ordinary named profile. It
also registers the public MCP in ordinary OMP profiles when OMP is installed.
Each ordinary profile receives a small first-party `librarian` routing skill
that advertises the five public tools. Private worker and auditor/scout profiles
receive neither that skill nor the public MCP.
This prevents recursive `memory_*` calls while preserving Hermes as the sole
agent loop.

Rerunning setup refreshes both registrations without recreating the profile.
Non-default installations can set `HERMES_HOME`, `HERMES_PROFILE_HOME`, and
`HERMES_PYTHON`.

The non-interactive integration and read-only audit entrypoints are safe to
reuse after a harness update:

```bash
~/Hermes/librarian/integrate.sh
~/Hermes/librarian/doctor.sh
```

`doctor.sh` verifies the built public/private MCP entrypoints, every ordinary
Hermes and OMP registration, each exact routing skill, each public
registration's caller-native backend, and the selected private-worker boundary.
It does not launch an agent or contact a model.

### OMP backend

Set `LIBRARIAN_AGENT_BACKEND=omp` before setup or select `omp` at the prompt.
Setup follows OMP's native
[profile-scoped MCP configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md):

- the public `librarian` MCP is merged into `~/.omp/agent/mcp.json` and every
  named profile already using the ordinary external-tool stack;
- the dedicated `~/.omp/profiles/librarian/agent/mcp.json` is converged to the
  private `librarian-okf` server only;
- delegated workers launch as `omp --profile librarian --mode rpc --no-session`.

The two profile files are deliberately separate. Rerunning setup removes stale
MCP registrations from isolated profiles but never prunes unrelated servers
from a normal profile. The worker therefore cannot discover its own public
`memory_*` server or recurse back into Librarian. Setup also repairs an old
`OMP_AGENT_DIR` value that accidentally points into a named profile. Override
`OMP_HOME`, `OMP_AGENT_DIR`,
`OMP_PROFILE_AGENT_DIR`, `OMP_PROFILE`, or `OMP_COMMAND` for a non-default
layout. `OMP_MODEL` plus `OMP_PROVIDER` select a model explicitly; blank values
inherit the active OMP profile.

Librarian makes no telemetry calls of its own. Knowledge, traces, delegated
sessions, and configuration remain on the machine running the chosen harness.

## Optional web browser

The MCP servers are stdio processes and require no persistent Librarian
service. To browse the OKF tree, graph, traces, guided operations, portable JSON
exports, dream proposals, and chat through the selected backend:

```bash
./start.sh
```

The default address is `http://localhost:3800`. Set `AUTH_TOKEN` to enable the
Dreams view's propose/approve/reject/rollback controls, and always before
exposing the service beyond a trusted host or LAN. Only this persistent process
runs the optional dream scheduler. Native Hermes and OMP RPC usage is attached
to traces when the selected harness reports it.

## Update

```bash
./update.sh
```

The update path rebases the Librarian repository with an autostash, performs a
frozen Bun install, rebuilds every package, and runs the non-interactive
`bun run integrate` path. It can be rerun after harness or profile updates; the
same script repairs public registrations and the selected private boundary.

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
Hermes ordinary profiles                  OMP ordinary profiles
  └─ librarian MCP (memory_*)               └─ librarian MCP (memory_*)
       └─ fresh TUI-gateway process               └─ fresh OMP RPC process
            └─ isolated librarian profile              └─ isolated librarian profile
                 └─ librarian-okf MCP                        └─ librarian-okf MCP
                      └─ Markdown OKF bundle                       └─ Markdown OKF bundle
```

Query traces stay local under `<bundle>/.traces/`. Dream proposals and their
preimages stay local under `<bundle>/.librarian/dream-proposals/`; the bundle
walker ignores this internal directory.

## License

AGPL-3.0-only. Librarian is a modified derivative of Understory by Anirban Kar.
See [`NOTICE`](NOTICE) for upstream attribution and [`LICENSE`](LICENSE) for the
complete license.
