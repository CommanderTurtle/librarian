import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { duplicateCandidates, oversizedConcepts, runDream } from "../src/agent/dream.js";
import { DreamProposalStore } from "../src/agent/dream-proposals.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ustory-dream-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("duplicateCandidates", () => {
  it("flags near-identical title/description pairs and ignores distinct ones", () => {
    const nodes = [
      { path: "/a.md", title: "Billing API rate limits", description: "100 requests per minute per client", links: 1 },
      { path: "/b.md", title: "API rate limits for billing", description: "per client limit of 100 requests per minute", links: 0 },
      { path: "/c.md", title: "Office WiFi", description: "guest network password rotation", links: 0 },
    ];
    const dupes = duplicateCandidates(nodes);
    expect(dupes).toHaveLength(1);
    expect([dupes[0].a, dupes[0].b].sort()).toEqual(["/a.md", "/b.md"]);
    expect(dupes[0].similarity).toBeGreaterThan(0.6);
  });
});

describe("runDream", () => {
  it("skips (no agent run) when the memory is healthy and quiet", async () => {
    // Two concepts linking to each other: no orphans, no broken links, <5 log entries.
    await kb.writeConcept("/a.md", { type: "T", title: "Alpha topic", description: "first subject" }, "See [B](/b.md).", "add a");
    await kb.writeConcept("/b.md", { type: "T", title: "Beta subject", description: "second matter" }, "See [A](/a.md).", "add b");
    const runner = vi.fn();
    const report = await runDream(kb, {}, runner as never);
    expect(report.ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("dreams when there are orphans, feeding them into the instruction", async () => {
    await kb.writeConcept("/hub.md", { type: "T", title: "Central hub", description: "main entry" }, "core", "add");
    await kb.writeConcept("/stray.md", { type: "T", title: "Stray note", description: "unconnected detail" }, "alone", "add");
    const runner = vi.fn(async (staged: KnowledgeBase) => {
      await staged.patchConcept("/hub.md", { replaceBody: "core\n\nSee [Stray](/stray.md)." }, "wire stray");
      return { ok: true as const, result: { summary: "wired stray into hub", filesChanged: ["/hub.md"], steps: 3, traceId: "t", sessionId: "s" } };
    });
    const report = await runDream(kb, {}, runner as never);
    expect(report.ran).toBe(true);
    expect(report.summary).toBe("wired stray into hub");
    expect(report.proposalId).toBeTruthy();
    expect((await kb.readConcept("/hub.md")).body.trim()).toBe("core");
    const instruction = runner.mock.calls[0][1] as unknown as string;
    const options = runner.mock.calls[0][2] as unknown as { cwd: string; bundleRoot: string };
    expect(instruction).toContain("DREAM");
    expect(instruction).toContain("/stray.md");
    expect(options.bundleRoot).toBe(options.cwd);
    expect(options.bundleRoot).not.toBe(root);
  });

  it("records a pending proposal from the MutationOutcome without touching live memory", async () => {
    await kb.writeConcept("/only.md", { type: "T", title: "Only one", description: "solo" }, "x", "add");
    const runner = vi.fn(async (staged: KnowledgeBase) => {
      await staged.patchConcept("/only.md", { replaceBody: "planned" }, "plan");
      return { ok: true as const, result: { summary: "done", filesChanged: ["/only.md"], steps: 1, traceId: "t", sessionId: "s" } };
    });
    const report = await runDream(kb, {}, runner as never);
    expect(report.ran).toBe(true);
    expect(report.summary).toBe("done");
    expect(report.filesChanged).toEqual(["/only.md"]);
    expect(report.proposal?.status).toBe("pending");
    expect((await kb.readConcept("/only.md")).body.trim()).toBe("x");

    const store = new DreamProposalStore(kb);
    await store.apply(report.proposalId!);
    expect((await kb.readConcept("/only.md")).body.trim()).toBe("planned");
    await store.rollback(report.proposalId!);
    expect((await kb.readConcept("/only.md")).body.trim()).toBe("x");
  });

  it("does not stage a second dream while one proposal awaits review", async () => {
    await kb.writeConcept("/only.md", { type: "T", title: "Only one", description: "solo" }, "x", "add");
    const runner = vi.fn(async (staged: KnowledgeBase) => {
      await staged.patchConcept("/only.md", { replaceBody: "planned" }, "plan");
      return { ok: true as const, result: { summary: "done", filesChanged: ["/only.md"], steps: 1, traceId: "t", sessionId: "s" } };
    });
    expect((await runDream(kb, {}, runner as never)).ran).toBe(true);
    const second = await runDream(kb, {}, runner as never);
    expect(second.ran).toBe(false);
    expect(second.reason).toContain("already awaiting review");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("fails closed when live memory changes after a proposal is staged", async () => {
    await kb.writeConcept("/only.md", { type: "T", title: "Only one", description: "solo" }, "x", "add");
    const runner = vi.fn(async (staged: KnowledgeBase) => {
      await staged.patchConcept("/only.md", { replaceBody: "planned" }, "plan");
      return { ok: true as const, result: { summary: "done", filesChanged: ["/only.md"], steps: 1, traceId: "t", sessionId: "s" } };
    });
    const report = await runDream(kb, {}, runner as never);
    await kb.patchConcept("/only.md", { replaceBody: "newer live edit" }, "concurrent edit");
    const store = new DreamProposalStore(kb);
    await expect(store.apply(report.proposalId!)).rejects.toThrow("Live concepts changed after planning");
    expect((await store.read(report.proposalId!))?.status).toBe("conflicted");
    expect((await kb.readConcept("/only.md")).body.trim()).toBe("newer live edit");
  });
});

describe("oversizedConcepts", () => {
  it("flags many-sectioned or very long bodies, not small concepts", async () => {
    const fatBody = Array.from({ length: 7 }, (_, i) => `# Topic ${i}\n\ncontent for topic ${i}`).join("\n\n");
    await kb.writeConcept("/people/fat.md", { type: "Person", title: "Fat Profile", description: "overgrown" }, fatBody, "add");
    await kb.writeConcept("/facts/tiny.md", { type: "Fact", title: "Tiny", description: "small" }, "one line", "add");

    const fat = await oversizedConcepts(kb);
    expect(fat.map((f) => f.path)).toEqual(["/people/fat.md"]);
    expect(fat[0].sections).toBeGreaterThanOrEqual(6);
  });

  it("feeds the split instruction into the dream (hub kept, path preserved)", async () => {
    const fatBody = Array.from({ length: 7 }, (_, i) => `# Topic ${i}\n\ncontent ${i}`).join("\n\n");
    await kb.writeConcept("/people/fat.md", { type: "Person", title: "Fat", description: "big" }, fatBody, "add");
    // Link it both ways with a friend so no orphan/broken signals muddy the test.
    await kb.patchConcept("/people/fat.md", { replaceSection: { heading: "Topic 0", content: "see [Friend](/facts/friend.md)" } }, "link");
    await kb.writeConcept("/facts/friend.md", { type: "Fact", title: "Friend", description: "companion" }, "see [Fat](/people/fat.md)", "add");

    const runner = vi.fn(async (staged: KnowledgeBase) => {
      await staged.patchConcept("/people/fat.md", { replaceBody: "# Summary\n\nSplit proposal." }, "plan split");
      return { ok: true as const, result: { summary: "split", filesChanged: ["/people/fat.md"], steps: 4, traceId: "t", sessionId: "s" } };
    });
    const report = await runDream(kb, {}, runner as never);
    expect(report.ran).toBe(true);
    const instruction = runner.mock.calls[0][1] as unknown as string;
    expect(instruction).toContain("OVERSIZED CONCEPTS");
    expect(instruction).toContain("/people/fat.md");
    expect(instruction).toContain("NEVER delete or rename the original path");
  });
});
