/**
 * Human-only dream proposal API.
 *
 * This route exposes Prime Agent-style plan/apply/rollback from core
 * `dream-proposals.ts`, LongHorizon-style explicit approval resolution, and
 * Librarian's existing authenticated Express/browser surface. It is
 * intentionally not registered on the model-facing MCP server.
 */
import express, { type RequestHandler, type Router } from "express";
import { DreamProposalStore, runDream, type KnowledgeBase } from "@understory/core";

export function dreamsRouter(kb: KnowledgeBase, approvalProtected: boolean): Router {
  const router = express.Router();
  const store = new DreamProposalStore(kb);
  const requireHumanApproval = approvalGuard(approvalProtected);

  router.get("/dreams", async (_req, res) => {
    res.json(await store.list());
  });

  router.get("/dreams/:id", async (req, res) => {
    const proposal = await store.read(routeId(req.params.id));
    if (!proposal) return void res.status(404).json({ error: "dream proposal not found" });
    res.json(proposal);
  });

  router.post("/dreams/propose", requireHumanApproval, async (_req, res) => {
    try {
      const report = await runDream(kb);
      res.status(report.ran ? 201 : 200).json(report);
    } catch (error) {
      res.status(500).json({ error: message(error) });
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
