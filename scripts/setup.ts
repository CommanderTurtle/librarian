#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

type Backend = "hermes" | "omp";
type McpConfig = {
  $schema?: string;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultBundle = path.join(repoRoot, "data");
const interactive = stdin.isTTY && stdout.isTTY;
const prompt = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;
const bun = Bun.which("bun");

if (!bun) fail("bun is required. Install Sandwich or Bun before setting up Librarian.");

const backend = normalizeBackend(
  await choose("Delegated agent backend (hermes or omp)", process.env.LIBRARIAN_AGENT_BACKEND || "hermes")
);

const hermesHome = expandHome(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
const profileName = process.env.LIBRARIAN_PROFILE || "librarian";
const profileHome = expandHome(
  process.env.HERMES_PROFILE_HOME || path.join(hermesHome, "profiles", profileName)
);
const hermesPython = expandHome(
  process.env.HERMES_PYTHON || path.join(hermesHome, "hermes-agent", "venv", "bin", "python")
);
const hermes = Bun.which("hermes");

const ompProfile = process.env.OMP_PROFILE?.trim() || profileName;
const ompHome = expandHome(process.env.OMP_HOME || path.join(os.homedir(), ".omp"));
const ompAgentDir = expandHome(process.env.OMP_AGENT_DIR || path.join(ompHome, "agent"));
const ompProfileAgentDir = expandHome(
  process.env.OMP_PROFILE_AGENT_DIR ||
    path.join(ompHome, "profiles", ompProfile, "agent")
);
const omp = resolveCommand(process.env.OMP_COMMAND || "omp");

if (backend === "hermes") {
  if (!hermes) fail("hermes is required for LIBRARIAN_AGENT_BACKEND=hermes.");
  if (!existsSync(hermesPython)) fail(`Hermes Python was not found at ${hermesPython}`);
} else if (!omp) {
  fail("omp is required for LIBRARIAN_AGENT_BACKEND=omp.");
}

const detected = backend === "hermes" ? detectHermesModel() : { model: "", provider: "" };
const bundleRoot = path.resolve(
  await choose("OKF bundle path", process.env.BUNDLE_ROOT || defaultBundle)
);
const model = await choose(
  `${backend === "hermes" ? "Hermes" : "OMP"} model (blank inherits the active profile)`,
  process.env[backend === "hermes" ? "HERMES_MODEL" : "OMP_MODEL"] || detected.model
);
const provider = await choose(
  `${backend === "hermes" ? "Hermes" : "OMP"} provider (blank inherits the active profile)`,
  process.env[backend === "hermes" ? "HERMES_PROVIDER" : "OMP_PROVIDER"] || detected.provider
);
prompt?.close();

mkdirSync(bundleRoot, { recursive: true });

console.log("\nInstalling and building with Bun...");
run(bun, ["install", "--frozen-lockfile"]);
run(bun, ["run", "build"]);

const envValues: Record<string, string> = {
  BUNDLE_ROOT: bundleRoot,
  LIBRARIAN_AGENT_BACKEND: backend,
  HERMES_HOME: hermesHome,
  LIBRARIAN_PROFILE: profileName,
  HERMES_PROFILE_HOME: profileHome,
  HERMES_PYTHON: hermesPython,
  HERMES_MODEL: backend === "hermes" ? model : process.env.HERMES_MODEL || "",
  HERMES_PROVIDER: backend === "hermes" ? provider : process.env.HERMES_PROVIDER || "",
  HERMES_TIMEOUT_MS: process.env.HERMES_TIMEOUT_MS || "600000",
  OMP_COMMAND: omp || process.env.OMP_COMMAND || "omp",
  OMP_HOME: ompHome,
  OMP_AGENT_DIR: ompAgentDir,
  OMP_PROFILE_AGENT_DIR: ompProfileAgentDir,
  OMP_PROFILE: ompProfile,
  OMP_MODEL: backend === "omp" ? model : process.env.OMP_MODEL || "",
  OMP_PROVIDER: backend === "omp" ? provider : process.env.OMP_PROVIDER || "",
  OMP_TIMEOUT_MS: process.env.OMP_TIMEOUT_MS || "600000",
  GIT_AUTOCOMMIT: process.env.GIT_AUTOCOMMIT || "false",
  QUERY_CACHE: process.env.QUERY_CACHE || "true",
  QUERY_CACHE_TTL: process.env.QUERY_CACHE_TTL || "24h",
  HOT_MEMORY: process.env.HOT_MEMORY || "true",
  HOT_MEMORY_TTL: process.env.HOT_MEMORY_TTL || "1h",
  DREAM_INTERVAL: process.env.DREAM_INTERVAL || "",
  DREAM_INSIGHTS: process.env.DREAM_INSIGHTS || "true",
  PORT: process.env.PORT || "3800",
};
writeEnv(path.join(repoRoot, ".env"), envValues);

const distRoot = path.join(repoRoot, "packages", "server", "dist", "mcp");
const okfEntry = path.join(distRoot, "okf-stdio.js");
const librarianEntry = path.join(distRoot, "stdio.js");

const privateEnv = {
  BUNDLE_ROOT: bundleRoot,
  GIT_AUTOCOMMIT: envValues.GIT_AUTOCOMMIT,
};
const publicEnv = {
  BUNDLE_ROOT: bundleRoot,
  LIBRARIAN_AGENT_BACKEND: backend,
  HERMES_PROFILE_HOME: profileHome,
  HERMES_PYTHON: hermesPython,
  HERMES_MODEL: envValues.HERMES_MODEL,
  HERMES_PROVIDER: envValues.HERMES_PROVIDER,
  HERMES_TIMEOUT_MS: envValues.HERMES_TIMEOUT_MS,
  OMP_COMMAND: envValues.OMP_COMMAND,
  OMP_HOME: ompHome,
  OMP_AGENT_DIR: ompAgentDir,
  OMP_PROFILE_AGENT_DIR: ompProfileAgentDir,
  OMP_PROFILE: ompProfile,
  OMP_MODEL: envValues.OMP_MODEL,
  OMP_PROVIDER: envValues.OMP_PROVIDER,
  OMP_TIMEOUT_MS: envValues.OMP_TIMEOUT_MS,
  QUERY_CACHE: envValues.QUERY_CACHE,
  QUERY_CACHE_TTL: envValues.QUERY_CACHE_TTL,
  HOT_MEMORY: envValues.HOT_MEMORY,
  HOT_MEMORY_TTL: envValues.HOT_MEMORY_TTL,
  GIT_AUTOCOMMIT: envValues.GIT_AUTOCOMMIT,
};

if (backend === "hermes") {
  if (!profileExists(profileName)) {
    console.log(`\nCreating isolated Hermes profile '${profileName}' from the current profile...`);
    run(hermes!, [
      "profile",
      "create",
      profileName,
      "--clone",
      "--description",
      "Delegated OKF librarian sessions with deterministic knowledge operations.",
    ]);
  } else {
    console.log(`\nHermes profile '${profileName}' already exists.`);
  }

  console.log("\nRegistering private OKF operations with the Librarian Hermes profile...");
  replaceHermesMcp("librarian-okf", bun, [okfEntry], privateEnv, profileHome);
  console.log("Registering high-level Librarian tools with the default Hermes profile...");
  replaceHermesMcp("librarian", bun, [librarianEntry], publicEnv);
} else {
  const publicMcpPath = path.join(ompAgentDir, "mcp.json");
  const privateMcpPath = path.join(ompProfileAgentDir, "mcp.json");
  console.log(`\nRegistering public Librarian tools in ${publicMcpPath}...`);
  updateOmpMcp(publicMcpPath, "librarian", bun, [librarianEntry], publicEnv);
  console.log(`Registering private OKF operations in OMP profile '${ompProfile}'...`);
  updateOmpMcp(privateMcpPath, "librarian-okf", bun, [okfEntry], privateEnv);
}

console.log(`
Librarian is ready.

  Repository:       ${repoRoot}
  Knowledge bundle:${bundleRoot}
  Agent backend:    ${backend}
  ${backend === "hermes" ? `Hermes profile:  ${profileHome}` : `OMP profile:     ${ompProfile}\n  Public MCP:      ${path.join(ompAgentDir, "mcp.json")}\n  Private MCP:     ${path.join(ompProfileAgentDir, "mcp.json")}`}
  Model:            ${model || "(profile default)"}
  Provider:         ${provider || "(profile default)"}

The active ${backend === "hermes" ? "Hermes" : "OMP"} profile now exposes memory_query,
memory_add, memory_update, memory_status, and memory_maintain. Each deep agentic
call uses a fresh isolated ${backend === "hermes" ? "TUI-gateway JSON-RPC" : "OMP RPC"} session.
`);

async function choose(label: string, fallback: string): Promise<string> {
  if (!prompt) return fallback;
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await prompt.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

function normalizeBackend(value: string): Backend {
  const normalized = value.trim().toLowerCase();
  if (normalized === "hermes" || normalized === "omp") return normalized;
  fail(`Unsupported agent backend '${value}'. Use hermes or omp.`);
}

function detectHermesModel(): { model: string; provider: string } {
  const result = spawnSync(hermes!, ["config", "get", "model"], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return {
    model: output.match(/^default:\s*(.+)$/m)?.[1]?.trim() || "",
    provider: output.match(/^provider:\s*(.+)$/m)?.[1]?.trim() || "",
  };
}

function profileExists(name: string): boolean {
  const result = spawnSync(hermes!, ["profile", "show", name], { encoding: "utf8" });
  return result.status === 0;
}

function replaceHermesMcp(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  scopedHome?: string
): void {
  const childEnv = { ...process.env, ...(scopedHome ? { HERMES_HOME: scopedHome } : {}) };
  const listed = spawnSync(hermes!, ["mcp", "list"], { env: childEnv, encoding: "utf8" });
  if (`${listed.stdout || ""}\n${listed.stderr || ""}`.includes(name)) {
    run(hermes!, ["mcp", "remove", name], childEnv, true);
  }
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const addArgs = ["mcp", "add", name, "--command", command, "--env", ...envArgs, "--args", ...args];
  const added = spawnSync(hermes!, addArgs, {
    cwd: repoRoot,
    env: childEnv,
    input: "y\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (added.status !== 0) fail(`hermes ${addArgs.join(" ")} failed with exit code ${added.status}`);
  const verified = spawnSync(hermes!, ["mcp", "list"], { env: childEnv, encoding: "utf8" });
  const registry = `${verified.stdout || ""}\n${verified.stderr || ""}`;
  const exactName = new RegExp(`(^|\\s)${escapeRegex(name)}(\\s|$)`, "m");
  if (verified.status !== 0 || !exactName.test(registry)) {
    fail(`Hermes did not retain the '${name}' MCP registration`);
  }
}

function updateOmpMcp(
  file: string,
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>
): void {
  let config: McpConfig = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    } catch (error) {
      fail(`Cannot update malformed OMP MCP config ${file}: ${String(error)}`);
    }
  }
  config.$schema ||= "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
  config.mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  config.mcpServers[name] = {
    type: "stdio",
    command,
    args,
    env,
    cwd: repoRoot,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writeEnv(file: string, values: Record<string, string>): void {
  const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : example;
  const lines = existing.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const replacement = `${key}=${escapeEnv(value)}`;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = replacement;
    else lines.push(replacement);
  }
  writeFileSync(file, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function resolveCommand(value: string): string | null {
  const isPath = value === "~" || value.startsWith("~/") || value.startsWith("~\\") ||
    value.includes("/") || value.includes("\\");
  if (!isPath) return Bun.which(value);
  const expanded = expandHome(value);
  return existsSync(expanded) ? expanded : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeEnv(value: string): string {
  return /[\s#"'\\]/.test(value)
    ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : value;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  allowFailure = false
): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: allowFailure ? "ignore" : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    fail(`${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function fail(message: string): never {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
}
