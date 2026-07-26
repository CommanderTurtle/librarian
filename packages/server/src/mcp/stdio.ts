#!/usr/bin/env node
/**
 * High-level Librarian MCP over stdio. The setup script registers this with
 * the default Hermes profile and registers the private OKF operations server
 * with the isolated librarian profile.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "@understory/core";
import { buildMcpServer } from "./server.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
const server = await buildMcpServer(kb);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(`[librarian] serving bundle ${bundleRoot} over stdio through Hermes`);
