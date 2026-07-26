#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const repoRoot = path.resolve(import.meta.dir, "..");
const hermesHome = expandHome(
  process.env.HERMES_HOME || path.join(os.homedir(), ".hermes")
);
const profileName = process.env.LIBRARIAN_PROFILE || "librarian";
const profileHome = expandHome(
  process.env.HERMES_PROFILE_HOME ||
    path.join(hermesHome, "profiles", profileName)
);
const defaultBundle = path.join(repoRoot, "data");
const hermesPython = expandHome(
  process.env.HERMES_PYTHON ||
    path.join(hermesHome, "hermes-agent", "venv", "bin", "python")
);
const bun = Bun.which("bun");
const hermes = Bun.which("hermes");

if (!bun) fail("bun is required. Install Sandwich or Bun before setting up Librarian.");
if (!hermes) fail("hermes is required and must be available on PATH.");
if (!existsSync(hermesPython)) {
  fail(`Hermes Python was not found at ${hermesPython}`);
}

const detected = detectModel();
const interactive = stdin.isTTY && stdout.isTTY;
const prompt = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;

const bundleRoot = path.resolve(
  await choose(
    "OKF bundle path",
    process.env.BUNDLE_ROOT || defaultBundle
  )
);
const model = await choose(
  "Hermes model",
  process.env.HERMES_MODEL || detected.model
);
const provider = await choose(
  "Hermes provider",
  process.env.HERMES_PROVIDER || detected.provider
);
prompt?.close();

mkdirSync(bundleRoot, { recursive: true });

console.log("\nInstalling and building with Bun...");
run(bun, ["install", "--frozen-lockfile"]);
run(bun, ["run", "build"]);

if (!profileExists(profileName)) {
  console.log(`\nCreating isolated Hermes profile '${profileName}' from the current profile...`);
  run(hermes, [
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

const envValues: Record<string, string> = {
  BUNDLE_ROOT: bundleRoot,
  HERMES_HOME: hermesHome,
  LIBRARIAN_PROFILE: profileName,
  HERMES_PROFILE_HOME: profileHome,
  HERMES_PYTHON: hermesPython,
  HERMES_MODEL: model,
  HERMES_PROVIDER: provider,
  HERMES_TIMEOUT_MS: process.env.HERMES_TIMEOUT_MS || "600000",
  GIT_AUTOCOMMIT: process.env.GIT_AUTOCOMMIT || "false",
  PORT: process.env.PORT || "3800",
};
writeEnv(path.join(repoRoot, ".env"), envValues);

const distRoot = path.join(repoRoot, "packages", "server", "dist", "mcp");
const okfEntry = path.join(distRoot, "okf-stdio.js");
const librarianEntry = path.join(distRoot, "stdio.js");

console.log("\nRegistering private OKF operations with the librarian profile...");
replaceMcp(
  "librarian-okf",
  bun,
  [okfEntry],
  {
    BUNDLE_ROOT: bundleRoot,
    GIT_AUTOCOMMIT: envValues.GIT_AUTOCOMMIT,
  },
  profileHome
);

console.log("Registering high-level Librarian tools with the default Hermes profile...");
replaceMcp(
  "librarian",
  bun,
  [librarianEntry],
  {
    BUNDLE_ROOT: bundleRoot,
    HERMES_PROFILE_HOME: profileHome,
    HERMES_PYTHON: hermesPython,
    HERMES_MODEL: model,
    HERMES_PROVIDER: provider,
    HERMES_TIMEOUT_MS: envValues.HERMES_TIMEOUT_MS,
    GIT_AUTOCOMMIT: envValues.GIT_AUTOCOMMIT,
  }
);

console.log(`
Librarian is ready.

  Repository:       ${repoRoot}
  Knowledge bundle:${bundleRoot}
  Hermes profile:  ${profileHome}
  Model:            ${model || "(profile default)"}
  Provider:         ${provider || "(profile default)"}

The default Hermes profile now exposes memory_query, memory_add, memory_update,
memory_status, and memory_maintain. Each agentic call creates a fresh persisted
session in the isolated '${profileName}' profile.
`);

async function choose(label: string, fallback: string): Promise<string> {
  if (!prompt) return fallback;
  const answer = (await prompt.question(`${label} [${fallback}]: `)).trim();
  return answer || fallback;
}

function detectModel(): { model: string; provider: string } {
  const result = spawnSync(hermes!, ["config", "get", "model"], {
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return {
    model: output.match(/^default:\s*(.+)$/m)?.[1]?.trim() || "",
    provider: output.match(/^provider:\s*(.+)$/m)?.[1]?.trim() || "",
  };
}

function profileExists(name: string): boolean {
  const result = spawnSync(hermes!, ["profile", "show", name], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function replaceMcp(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  hermesHome?: string
): void {
  const childEnv = {
    ...process.env,
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
  };
  const listed = spawnSync(hermes!, ["mcp", "list"], {
    env: childEnv,
    encoding: "utf8",
  });
  if (`${listed.stdout || ""}\n${listed.stderr || ""}`.includes(name)) {
    run(hermes!, ["mcp", "remove", name], childEnv, true);
  }
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const addArgs = [
    "mcp",
    "add",
    name,
    "--command",
    command,
    "--env",
    ...envArgs,
    "--args",
    ...args,
  ];
  const added = spawnSync(hermes!, addArgs, {
    cwd: repoRoot,
    env: childEnv,
    input: "y\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (added.status !== 0) {
    fail(`hermes ${addArgs.join(" ")} failed with exit code ${added.status}`);
  }
  const verified = spawnSync(hermes!, ["mcp", "list"], {
    env: childEnv,
    encoding: "utf8",
  });
  const registry = `${verified.stdout || ""}\n${verified.stderr || ""}`;
  const exactName = new RegExp(`(^|\\s)${escapeRegex(name)}(\\s|$)`, "m");
  if (verified.status !== 0 || !exactName.test(registry)) {
    fail(`Hermes did not retain the '${name}' MCP registration`);
  }
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

function escapeEnv(value: string): string {
  return /[\s#"'\\]/.test(value)
    ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : value;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
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
