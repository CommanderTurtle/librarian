#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "@understory/core";
import { buildOkfOperationsServer } from "./okf-server.js";

const bundleRoot = process.env.BUNDLE_ROOT;
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
