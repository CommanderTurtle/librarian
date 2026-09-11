/**
 * Human-only dream proposal API.
 *
 * This route exposes Prime Agent-style plan/apply/rollback from core
 * `dream-proposals.ts`, LongHorizon-style explicit approval resolution, and
 * Librarian's existing authenticated Express/browser surface. It is
 * intentionally not registered on the model-facing MCP server.
 */
import express, { type RequestHandler, type Router } from "express";
import path from "node:path";
import {
  createDreamProposal,
  createSnapshotProposal,
  DreamProposalStore,
  hasNonEmptyType,
  parseDoc,
  type DreamProposalReport,
  type KnowledgeBase,
} from "@understory/core";
import type { Dreamer } from "../dreamer.js";

const MAX_GUIDED_TEXT = 250_000;
const MAX_IMPORT_CONCEPTS = 20_000;
const MAX_IMPORT_TEXT = 4_000_000;

export function dreamsRouter(
  kb: KnowledgeBase,
  approvalProtected: boolean,
  dreamer: Dreamer
): Router {
  const router = express.Router();
  const store = new DreamProposalStore(kb);
  const requireHumanApproval = approvalGuard(approvalProtected);

  router.get("/dreams", async (_req, res) => {
    res.json(await store.list());
  });

  // Keep this route before /dreams/:id so "status" cannot be parsed as an id.
  router.get("/dreams/status", (_req, res) => {
    res.json(dreamer.status());
  });

  router.get("/dreams/:id", async (req, res) => {
    const proposal = await store.read(routeId(req.params.id));
    if (!proposal) return void res.status(404).json({ error: "dream proposal not found" });
    res.json(proposal);
  });

  router.post("/dreams/propose", requireHumanApproval, async (_req, res) => {
    try {
      const report = await dreamer.runNow("manual");
      res.status(report.ran ? 201 : 200).json(report);
    } catch (error) {
      res.status(500).json({ error: message(error) });
    }
  });

  router.post("/dreams/guided", requireHumanApproval, async (req, res) => {
    try {
      const report = await guidedProposal(kb, req.body);
      res.status(report.ran ? 201 : 200).json(report);
    } catch (error) {
      const status = error instanceof GuidedInputError ? 400 : 500;
      res.status(status).json({ error: message(error) });
    }
  });

  router.post("/dreams/:id/approve", requireHumanApproval, async (req, res) => {
    try {
      res.json(await store.apply(routeId(req.params.id)));
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  router.post("/dreams/:id/reject", requireHumanApproval, async (req, res) => {
    try {
      res.json(await store.reject(routeId(req.params.id)));
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  router.post("/dreams/:id/rollback", requireHumanApproval, async (req, res) => {
    try {
      res.json(await store.rollback(routeId(req.params.id)));
    } catch (error) {
      res.status(409).json({ error: message(error) });
    }
  });

  return router;
}

async function guidedProposal(kb: KnowledgeBase, body: unknown): Promise<DreamProposalReport> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GuidedInputError("guided proposal body must be an object");
  }
  const input = body as Record<string, unknown>;
  const mode = String(input.mode ?? "");

  if (mode === "add") {
    const content = guidedText(input.content, "knowledge", true);
    const suggestedPath = guidedPath(kb, input.suggestedPath);
    const instruction =
      `Persist the following knowledge into the knowledge base. First search for related ` +
      `or owning concepts. Extend an existing concept when the material belongs there; ` +
      `create a new concept only for a distinct subject, and link related concepts in both ` +
      `directions. This is a staged proposal: use the write tools in the isolated copy and ` +
      `summarize the exact edits.\n\nKNOWLEDGE TO RECORD:\n${content}` +
      (suggestedPath ? `\n\nSuggested path, if appropriate: ${suggestedPath}` : "");
    return createDreamProposal(kb, instruction, { title: "Librarian guided add" });
  }

  if (mode === "update") {
    const instruction = guidedText(input.instruction, "update instruction", true);
    return createDreamProposal(
      kb,
      `Apply this targeted knowledge-base update in the isolated copy. Search and read ` +
        `the affected concepts before editing, preserve unrelated material, update links ` +
        `when paths or relationships change, and summarize the exact edits.\n\n` +
        instruction,
      { title: "Librarian guided update" },
    );
  }

  if (mode === "maintain") {
    const focus = guidedText(input.focus, "maintenance focus", false);
    return createDreamProposal(
      kb,
      `Inspect and repair the knowledge graph in the isolated copy. Check orphaned ` +
        `concepts, broken links, duplicated material, oversized concepts, indexes, and ` +
        `cross-links. Prefer focused repairs and summarize the exact edits.` +
        (focus ? `\n\nAdditional maintenance focus:\n${focus}` : ""),
      { title: "Librarian guided maintenance" },
    );
  }

  if (mode === "import") {
    return importProposal(kb, input);
  }

  throw new GuidedInputError("mode must be add, update, maintain, or import");
}

async function importProposal(
  kb: KnowledgeBase,
  input: Record<string, unknown>,
): Promise<DreamProposalReport> {
  const strategy = input.strategy === "replace" ? "replace" : "merge";
  const bundle = input.bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new GuidedInputError("bundle must be a Librarian JSON export");
  }
  const portable = bundle as Record<string, unknown>;
  if (portable.schemaVersion !== "librarian.bundle.v1") {
    throw new GuidedInputError("unsupported bundle schemaVersion");
  }
  if (!Array.isArray(portable.concepts) || portable.concepts.length > MAX_IMPORT_CONCEPTS) {
    throw new GuidedInputError(`bundle concepts must be an array of at most ${MAX_IMPORT_CONCEPTS}`);
  }

  const imported = new Map<string, string>();

  let total = 0;
  for (const item of portable.concepts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GuidedInputError("every imported concept must be an object");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.raw !== "string") {
      throw new GuidedInputError("every imported concept requires string path and raw fields");
    }
    let conceptPath: string;
    try {
      conceptPath = kb.bundle.toBundlePath(record.path);
    } catch (error) {
      throw new GuidedInputError(message(error));
    }
    const base = path.posix.basename(conceptPath);
    if (!conceptPath.endsWith(".md") || base === "index.md" || base === "log.md") {
      throw new GuidedInputError(`invalid concept path: ${record.path}`);
    }
    if (imported.has(conceptPath)) {
      throw new GuidedInputError(`duplicate concept path: ${conceptPath}`);
    }
    let parsed: ReturnType<typeof parseDoc>;
    try {
      parsed = parseDoc(record.raw);
    } catch (error) {
      throw new GuidedInputError(`${conceptPath}: ${message(error)}`);
    }
    if (!hasNonEmptyType(parsed.frontmatter)) {
      throw new GuidedInputError(`${conceptPath}: frontmatter requires a non-empty type`);
    }
    total += record.raw.length;
    if (total > MAX_IMPORT_TEXT) {
      throw new GuidedInputError(`import exceeds ${MAX_IMPORT_TEXT} text characters`);
    }
    imported.set(conceptPath, record.raw);
  }

  return createSnapshotProposal(
    kb,
    `Import ${portable.concepts.length} concepts using ${strategy} strategy`,
    `${strategy === "replace" ? "Replace bundle from" : "Merge"} Librarian JSON export`,
    imported,
    strategy,
  );
}

function guidedText(value: unknown, label: string, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new GuidedInputError(`${label} is required`);
    return "";
  }
  if (typeof value !== "string" || value.length > MAX_GUIDED_TEXT || /\0/.test(value)) {
    throw new GuidedInputError(`${label} must contain at most ${MAX_GUIDED_TEXT} characters`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new GuidedInputError(`${label} is required`);
  return trimmed;
}

function guidedPath(kb: KnowledgeBase, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 1000 || /[\r\n\0]/.test(value)) {
    throw new GuidedInputError("suggestedPath is invalid");
  }
  try {
    const conceptPath = kb.bundle.toBundlePath(value);
    if (!conceptPath.endsWith(".md")) throw new Error("suggestedPath must end in .md");
    return conceptPath;
  } catch (error) {
    throw new GuidedInputError(message(error));
  }
}

class GuidedInputError extends Error {}

function routeId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function approvalGuard(enabled: boolean): RequestHandler {
  return (_req, res, next) => {
    if (enabled) return next();
    res.status(503).json({
      error: "dream controls are disabled until AUTH_TOKEN protects the human approval surface",
    });
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
