#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "@understory/core";
import { buildOkfOperationsServer } from "./okf-server.js";

// The installed profile keeps BUNDLE_ROOT as its stable default. A fresh
// Hermes/OMP proposal process may override only its own MCP child, allowing
// dream planning to use an isolated bundle without rewriting shared config.
const configuredOverride = process.env.LIBRARIAN_BUNDLE_ROOT;
const bundleRoot = configuredOverride
  && configuredOverride !== "LIBRARIAN_BUNDLE_ROOT"
  && configuredOverride !== "${LIBRARIAN_BUNDLE_ROOT}"
  ? configuredOverride
  : process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const server = buildOkfOperationsServer(kb);
await server.connect(new StdioServerTransport());
console.error(`[librarian-okf] serving deterministic bundle operations for ${bundleRoot}`);
