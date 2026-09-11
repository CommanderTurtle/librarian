import express, { type Router } from "express";
import {
  BundleError,
  TraceStore,
  type KnowledgeBase,
} from "@understory/core";

/** Deterministic browse API — no LLM involved, browsing never costs tokens. */
export function browseRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.get("/tree", async (_req, res) => {
    res.json(await kb.listTree());
  });

  router.get("/concept", async (req, res) => {
    const path = String(req.query.path ?? "");
    try {
      res.json(await kb.readConcept(path));
    } catch (err) {
      if (err instanceof BundleError) {
        res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "");
    const type = req.query.type ? String(req.query.type) : undefined;
    const tag = req.query.tag ? String(req.query.tag) : undefined;
    res.json(await kb.search(q, { type, tags: tag ? [tag] : undefined }));
  });

  router.get("/log", async (_req, res) => {
    res.json(await kb.readLog());
  });

  router.get("/validate", async (_req, res) => {
    res.json(await kb.validate());
  });

  router.get("/graph", async (_req, res) => {
    res.json(await kb.graph());
  });

  const traces = new TraceStore(kb.bundle.root);

  router.get("/traces", async (_req, res) => {
    // List view: omit full steps/answers to keep the payload light.
    const all = await traces.list();
    res.json(
      all.map(({ id, kind, input, startedAt, durationMs, notation, steps, usage }) => ({
        id,
        kind,
        input,
        startedAt,
        durationMs,
        notation,
        stepCount: steps.length,
        usage,
      }))
    );
  });

  router.get("/trace", async (req, res) => {
    const trace = await traces.read(String(req.query.id ?? ""));
    if (!trace) {
      res.status(404).json({ error: "trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/types", async (_req, res) => {
    res.json(await kb.listTypes());
  });

  router.get("/config", (_req, res) => {
    const backend = process.env.LIBRARIAN_AGENT_BACKEND === "omp" ? "omp" : "hermes";
    res.json({
      model:
        (backend === "omp" ? process.env.OMP_MODEL : process.env.HERMES_MODEL) ||
        "profile default",
      format: backend,
      fallbackConfigured: false,
    });
  });

  router.get("/bundle/export", async (_req, res) => {
    const paths = await kb.bundle.listConceptPaths();
    const concepts = await Promise.all(
      paths.map(async (path) => ({ path, raw: (await kb.readConcept(path)).raw }))
    );
    res.json({
      schemaVersion: "librarian.bundle.v1",
      exportedAt: new Date().toISOString(),
      concepts,
    });
  });

  return router;
}
