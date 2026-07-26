import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatTree, type KnowledgeBase } from "@understory/core";

const conceptPath = z
  .string()
  .describe('Bundle-relative path starting with "/" and ending in .md');

const frontmatterSchema = z
  .object({
    type: z.string().min(1).describe("Concept kind. Required."),
    title: z.string().optional(),
    description: z.string().optional().describe("One-line summary"),
    resource: z.string().optional().describe("Canonical URI of the underlying asset"),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const logSummary = z
  .string()
  .describe("One past-tense sentence for the update log, using bundle-relative links");

/**
 * Private, deterministic OKF operations used by the librarian Hermes profile.
 * This server contains no model/provider code. Every mutation passes through
 * KnowledgeBase so path sandboxing, indexes, logs, and conformance remain code
 * invariants.
 */
export function buildOkfOperationsServer(kb: KnowledgeBase): McpServer {
  const server = new McpServer(
    { name: "librarian-okf", version: "0.1.0" },
    {
      instructions:
        "Private deterministic OKF operations for Librarian. Read and mutate the bundle only through these tools.",
    }
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search knowledge",
      description:
        "Keyword search over the OKF bundle, optionally filtered by exact concept type and tags. A miss is not proof of absence; retry synonyms or inspect the directory.",
      inputSchema: {
        query: z.string().describe("Keywords; may be empty when filtering"),
        type: z.string().optional().describe("Exact concept type"),
        tags: z.array(z.string()).optional().describe("Require all tags"),
      },
    },
    async ({ query, type, tags }) => {
      const hits = await kb.search(query, { type, tags });
      if (hits.length > 0) return text(hits);
      return text({
        hits: [],
        notice:
          "No literal keyword matches. Retry with synonyms or broader terms, then inspect and read plausible concepts before concluding the knowledge is absent.",
        bundle_layout: formatTree(await kb.listTree()),
      });
    }
  );

  server.registerTool(
    "read_concept",
    {
      title: "Read concept",
      description: "Read one concept document in full, including frontmatter and markdown body.",
      inputSchema: { path: conceptPath },
    },
    async ({ path }) => {
      const concept = await kb.readConcept(path);
      return text({
        path: concept.path,
        frontmatter: concept.frontmatter,
        body: concept.body,
      });
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List knowledge layout",
      description:
        "List the bundle directory tree with concept types, titles, and descriptions.",
      inputSchema: {},
    },
    async () => text(formatTree(await kb.listTree()))
  );

  server.registerTool(
    "lint_knowledge",
    {
      title: "Lint knowledge graph",
      description: "Report orphaned concepts, broken links, and graph health.",
      inputSchema: {},
    },
    async () => text(await kb.lint())
  );

  server.registerTool(
    "write_concept",
    {
      title: "Write concept",
      description:
        "Create or fully overwrite a concept. index.md and log.md are maintained automatically.",
      inputSchema: {
        path: conceptPath,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body without frontmatter"),
        log_summary: logSummary,
      },
    },
    async ({ path, frontmatter, body, log_summary }) => {
      const concept = await kb.writeConcept(path, frontmatter, body, log_summary);
      return text({ written: concept.path });
    }
  );

  server.registerTool(
    "patch_concept",
    {
      title: "Patch concept",
      description:
        "Targeted update: merge frontmatter, replace one top-level section, or replace the body.",
      inputSchema: {
        path: conceptPath,
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Keys to merge; null removes a key"),
        replace_section: z
          .object({
            heading: z.string().min(1).describe("Top-level heading without #"),
            content: z.string().describe("Replacement section content"),
          })
          .optional(),
        replace_body: z.string().optional().describe("Replace the entire markdown body"),
        log_summary: logSummary,
      },
    },
    async ({ path, frontmatter, replace_section, replace_body, log_summary }) => {
      const concept = await kb.patchConcept(
        path,
        {
          frontmatter,
          replaceSection: replace_section
            ? { heading: replace_section.heading, content: replace_section.content }
            : undefined,
          replaceBody: replace_body,
        },
        log_summary
      );
      return text({ patched: concept.path });
    }
  );

  server.registerTool(
    "delete_concept",
    {
      title: "Delete concept",
      description:
        "Permanently delete a concept. Prefer deprecation unless deletion is explicitly required.",
      inputSchema: {
        path: conceptPath,
        log_summary: logSummary,
      },
    },
    async ({ path, log_summary }) => {
      await kb.deleteConcept(path, log_summary);
      return text({ deleted: path });
    }
  );

  return server;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}
