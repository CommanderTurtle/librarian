#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const routingSkillSource = path.join(repoRoot, "skills", "librarian", "SKILL.md");
const integrateOnly = process.argv.includes("--integrate-only");
const interactive = stdin.isTTY && stdout.isTTY && !integrateOnly;
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
const configuredOmpAgentDir = expandHome(
  process.env.OMP_AGENT_DIR || path.join(ompHome, "agent")
);
// OMP_AGENT_DIR is the public/default-profile registry. Older setup runs
// could accidentally persist the caller's active named-profile directory
// here, which hid Librarian from the default profile and contaminated the
// delegated profile. Normalize that stale shape back to the public registry.
const ompAgentDir = isNamedOmpProfileAgentDir(configuredOmpAgentDir, ompHome)
  ? path.join(ompHome, "agent")
  : configuredOmpAgentDir;
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
if (backend === "omp" && path.resolve(ompAgentDir) === path.resolve(ompProfileAgentDir)) {
  fail("The public OMP agent directory and isolated Librarian profile directory must differ.");
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

if (!integrateOnly) {
  console.log("\nInstalling and building with Bun...");
  run(bun, ["install", "--frozen-lockfile"]);
  run(bun, ["run", "build"]);
}

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
  DREAM_INTERVAL: process.env.DREAM_INTERVAL || "6h",
  DREAM_START_DELAY: process.env.DREAM_START_DELAY || "10m",
  DREAM_INSIGHTS: process.env.DREAM_INSIGHTS || "true",
  PORT: process.env.PORT || "3800",
  AUTH_TOKEN: process.env.AUTH_TOKEN || "",
};
writeEnv(path.join(repoRoot, ".env"), envValues);

const distRoot = path.join(repoRoot, "packages", "server", "dist", "mcp");
const okfEntry = path.join(distRoot, "okf-stdio.js");
const librarianEntry = path.join(distRoot, "stdio.js");

const privateEnv = {
  BUNDLE_ROOT: bundleRoot,
  // Each fresh dream process may redirect only its own deterministic OKF MCP
  // to an isolated copy. Hermes interpolates ${VAR}; OMP treats a config value
  // matching an env-var name as an indirection. okf-stdio ignores either
  // unresolved sentinel and falls back to the stable BUNDLE_ROOT above.
  LIBRARIAN_BUNDLE_ROOT: backend === "hermes"
    ? "${LIBRARIAN_BUNDLE_ROOT}"
    : "LIBRARIAN_BUNDLE_ROOT",
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
  convergeHermesPrivateProfile(profileHome, "librarian-okf");
  removeManagedRoutingSkill(profileHome, "hermes");
  removeOmpMcp(path.join(ompProfileAgentDir, "mcp.json"), ["librarian", "librarian-okf"]);
  removeManagedRoutingSkill(ompProfileAgentDir, "omp");
} else {
  const privateMcpPath = path.join(ompProfileAgentDir, "mcp.json");
  console.log(`\nRegistering private OKF operations in OMP profile '${ompProfile}'...`);
  updateOmpMcp(privateMcpPath, "librarian-okf", bun, [okfEntry], privateEnv, true);
  removeManagedRoutingSkill(ompProfileAgentDir, "omp");
  removeHermesMcp("librarian", profileHome);
  removeHermesMcp("librarian-okf", profileHome);
  removeManagedRoutingSkill(profileHome, "hermes");
}

const publicHermesProfiles = hermes ? hermesPublicProfiles() : [];
for (const profile of publicHermesProfiles) {
  console.log(`Registering public Librarian tools with Hermes profile '${profile.name}'...`);
  replaceHermesMcp("librarian", bun, [librarianEntry], publicEnv, profile.directory);
  installRoutingSkill(profile.directory, "hermes");
}

const publicOmpAgents = omp ? ompPublicAgentDirectories() : [];
for (const directory of publicOmpAgents) {
  const publicMcpPath = path.join(directory, "mcp.json");
  console.log(`Registering public Librarian tools in ${publicMcpPath}...`);
  updateOmpMcp(publicMcpPath, "librarian", bun, [librarianEntry], publicEnv);
  installRoutingSkill(directory, "omp");
}
for (const directory of ompIsolatedAgentDirectories()) {
  if (backend === "omp" && path.resolve(directory) === path.resolve(ompProfileAgentDir)) continue;
  removeOmpMcp(path.join(directory, "mcp.json"), ["librarian", "librarian-okf"]);
  removeManagedRoutingSkill(directory, "omp");
}

verifyIntegration(backend, publicHermesProfiles, publicOmpAgents);

console.log(`
Librarian is ready.

  Repository:       ${repoRoot}
  Knowledge bundle:${bundleRoot}
  Agent backend:    ${backend}
  Private worker:  ${backend === "hermes" ? profileHome : ompProfileAgentDir}
  Hermes publics:  ${publicHermesProfiles.length}
  OMP publics:     ${publicOmpAgents.length}
  Model:            ${model || "(profile default)"}
  Provider:         ${provider || "(profile default)"}

Every ordinary installed profile now exposes memory_query, memory_add,
memory_update, memory_status, and memory_maintain. Each deep agentic call uses
a fresh isolated ${backend === "hermes" ? "TUI-gateway JSON-RPC" : "OMP RPC"} session.
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

type HermesProfile = { name: string; directory: string };

function hermesMcpNames(directory: string): string[] {
  if (!hermes || !existsSync(path.join(directory, "config.yaml"))) return [];
  const result = spawnSync(hermes, ["mcp", "list"], {
    env: { ...process.env, HERMES_HOME: directory },
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`Could not inspect Hermes MCPs in ${directory}`);
  const names = new Set<string>();
  for (const line of `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/)) {
    const match = line.match(/^\s{2}([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}/);
    if (match && match[1] !== "Name") names.add(match[1]);
  }
  return [...names].sort();
}

function hermesPublicProfiles(): HermesProfile[] {
  const profiles: HermesProfile[] = [{ name: "default", directory: hermesHome }];
  const profilesRoot = path.join(hermesHome, "profiles");
  if (existsSync(profilesRoot)) {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(profilesRoot, entry.name);
      if (!existsSync(path.join(directory, "config.yaml"))) continue;
      if (path.resolve(directory) === path.resolve(profileHome)) continue;
      if (hermesMcpNames(directory).includes("librarian-okf")) continue;
      profiles.push({ name: entry.name, directory });
    }
  }
  return profiles;
}

function removeHermesMcp(name: string, directory: string): void {
  if (!hermes || !hermesMcpNames(directory).includes(name)) return;
  run(
    hermes,
    ["mcp", "remove", name],
    { ...process.env, HERMES_HOME: directory },
    true
  );
}

function convergeHermesPrivateProfile(directory: string, keep: string): void {
  for (const name of hermesMcpNames(directory)) {
    if (name !== keep) removeHermesMcp(name, directory);
  }
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

function allOmpProfileAgentDirectories(): string[] {
  const profilesRoot = path.join(ompHome, "profiles");
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(profilesRoot, entry.name, "agent"))
    .filter((directory) => existsSync(path.join(directory, "config.yml")));
}

function ompPublicAgentDirectories(): string[] {
  const directories = [ompAgentDir];
  const normalMarkers = new Set([
    "retrieval",
    "localflame",
    "camofox",
    "camofox-mcp",
    "context-mode",
    "codebase-memory-mcp",
  ]);
  for (const directory of allOmpProfileAgentDirectories()) {
    if (path.resolve(directory) === path.resolve(ompProfileAgentDir)) continue;
    const mcpPath = path.join(directory, "mcp.json");
    if (!existsSync(mcpPath)) continue;
    const config = readOmpMcp(mcpPath);
    const names = Object.keys(config.mcpServers || {});
    if (names.some((name) => normalMarkers.has(name))) directories.push(directory);
  }
  return [...new Set(directories.map((directory) => path.resolve(directory)))];
}

function ompIsolatedAgentDirectories(): string[] {
  const publicDirectories = new Set(
    ompPublicAgentDirectories().map((directory) => path.resolve(directory))
  );
  return allOmpProfileAgentDirectories().filter(
    (directory) => !publicDirectories.has(path.resolve(directory))
  );
}

function readOmpMcp(file: string): McpConfig {
  if (!existsSync(file)) return {};
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as McpConfig;
    config.mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
    return config;
  } catch (error) {
    fail(`Cannot read malformed OMP MCP config ${file}: ${String(error)}`);
  }
}

function removeOmpMcp(file: string, names: string[]): void {
  if (!existsSync(file)) return;
  const config = readOmpMcp(file);
  let changed = false;
  for (const name of names) {
    if (config.mcpServers && Object.hasOwn(config.mcpServers, name)) {
      delete config.mcpServers[name];
      changed = true;
    }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function routingSkillTarget(directory: string, harness: Backend): string {
  return harness === "hermes"
    ? path.join(directory, "skills", "research", "librarian")
    : path.join(directory, "skills", "librarian");
}

function installRoutingSkill(directory: string, harness: Backend): void {
  if (!existsSync(routingSkillSource)) {
    fail(`Librarian routing skill is missing: ${routingSkillSource}`);
  }
  const target = routingSkillTarget(directory, harness);
  mkdirSync(target, { recursive: true });
  const content = readFileSync(routingSkillSource, "utf8");
  const destination = path.join(target, "SKILL.md");
  if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
    writeFileSync(destination, content, "utf8");
  }
}

function removeManagedRoutingSkill(directory: string, harness: Backend): void {
  if (!existsSync(routingSkillSource)) return;
  const target = routingSkillTarget(directory, harness);
  const destination = path.join(target, "SKILL.md");
  if (!existsSync(destination)) return;
  if (readFileSync(destination, "utf8") !== readFileSync(routingSkillSource, "utf8")) {
    console.log(`Retaining modified Librarian routing skill at ${destination}`);
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

function verifyIntegration(
  selectedBackend: Backend,
  publicHermes: HermesProfile[],
  publicOmp: string[]
): void {
  for (const entry of [okfEntry, librarianEntry]) {
    if (!existsSync(entry)) fail(`Built MCP entrypoint is missing: ${entry}`);
  }
  for (const profile of publicHermes) {
    const names = hermesMcpNames(profile.directory);
    if (!names.includes("librarian") || names.includes("librarian-okf")) {
      fail(`Hermes public profile '${profile.name}' has an invalid Librarian boundary`);
    }
    verifyRoutingSkill(profile.directory, "hermes");
  }
  for (const directory of publicOmp) {
    const names = Object.keys(readOmpMcp(path.join(directory, "mcp.json")).mcpServers || {});
    if (!names.includes("librarian") || names.includes("librarian-okf")) {
      fail(`OMP public profile at ${directory} has an invalid Librarian boundary`);
    }
    verifyRoutingSkill(directory, "omp");
  }
  if (selectedBackend === "hermes") {
    const privateNames = hermesMcpNames(profileHome);
    if (privateNames.length !== 1 || privateNames[0] !== "librarian-okf") {
      fail("Hermes Librarian worker must expose only librarian-okf");
    }
    verifyNoRoutingSkill(profileHome, "hermes");
  } else {
    const privateNames = Object.keys(
      readOmpMcp(path.join(ompProfileAgentDir, "mcp.json")).mcpServers || {}
    ).sort();
    if (privateNames.length !== 1 || privateNames[0] !== "librarian-okf") {
      fail("OMP Librarian worker must expose only librarian-okf");
    }
    verifyNoRoutingSkill(ompProfileAgentDir, "omp");
  }
  console.log(
    `Verified Librarian integration: ${publicHermes.length} Hermes public profiles, ` +
      `${publicOmp.length} OMP public profiles, one ${selectedBackend} private worker.`
  );
}

function verifyRoutingSkill(directory: string, harness: Backend): void {
  const destination = path.join(routingSkillTarget(directory, harness), "SKILL.md");
  if (!existsSync(destination)
      || readFileSync(destination, "utf8") !== readFileSync(routingSkillSource, "utf8")) {
    fail(`${harness} public profile is missing the managed Librarian routing skill: ${directory}`);
  }
}

function verifyNoRoutingSkill(directory: string, harness: Backend): void {
  if (existsSync(path.join(routingSkillTarget(directory, harness), "SKILL.md"))) {
    fail(`${harness} Librarian worker must not expose the public routing skill: ${directory}`);
  }
}

function updateOmpMcp(
  file: string,
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  exclusive = false
): void {
  const config = readOmpMcp(file);
  config.$schema ||= "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
  // The delegated OMP profile is a capability boundary, not a clone of the
  // user's normal profile. Converge it to one private OKF server on every
  // setup run so stale/public MCPs cannot recurse into Librarian or broaden a
  // dream worker's tools. Public config remains a merge and is never pruned.
  config.mcpServers = exclusive
    ? {}
    : isRecord(config.mcpServers)
      ? config.mcpServers
      : {};
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

function isNamedOmpProfileAgentDir(candidate: string, ompHome: string): boolean {
  const relative = path.relative(path.join(ompHome, "profiles"), candidate);
  return relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    path.basename(candidate) === "agent";
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
