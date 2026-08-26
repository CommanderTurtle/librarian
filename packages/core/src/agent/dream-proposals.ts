/**
 * Human-gated Librarian dream proposals.
 *
 * The lifecycle is grounded in existing code from three systems:
 * - Prime Agent `refinement.ts`: plan/apply separation, immutable base prompt,
 *   baseline conflict detection, atomic state writes, and reversible preimages.
 * - LongHorizon-Harness `dashboard/gate.py`, `state.py`, and `rules.py`:
 *   persisted approvals with explicit resolution rather than silent mutation.
 * - Librarian `dream.ts`, `agent.ts`, `knowledge-base.ts`, and `bundle.ts`:
 *   deterministic dream signals, fresh delegated runs, the single conformant
 *   write path, and concept snapshots.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnowledgeBase } from "../okf/index.js";
import { KnowledgeBase as StagedKnowledgeBase } from "../okf/index.js";
import { parseDoc } from "../okf/frontmatter.js";
import type { ConceptFrontmatter } from "../okf/types.js";
import { snapshotConcepts, type AgentOptions, type MutationOutcome, runMutation } from "./agent.js";
import { TraceStore } from "./trace.js";

export type DreamProposalStatus = "pending" | "applied" | "rejected" | "rolled_back" | "conflicted" | "failed";

export interface DreamEdit {
  path: string;
  action: "create" | "update" | "delete";
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  applied: string | null;
  appliedHash: string | null;
}

export interface DreamProposal {
  id: string;
  status: DreamProposalStatus;
  createdAt: string;
  updatedAt: string;
  instruction: string;
  summary: string;
  traceId?: string;
  sessionId?: string;
  edits: DreamEdit[];
  error?: string;
}

export interface DreamProposalReport {
  ran: boolean;
  reason?: string;
  proposal?: DreamProposal;
}

// Proposal creation and resolution share one process-local critical section
// per bundle. The persistent web service is the only component authorized to
// resolve dreams, so this closes double-click/manual-vs-scheduler races without
// introducing a second daemon or a lock file that could survive a crash.
const proposalLocks = new Map<string, Promise<void>>();

export class DreamProposalStore {
  readonly root: string;

  constructor(private readonly kb: KnowledgeBase) {
    this.root = path.join(kb.bundle.root, ".librarian", "dream-proposals");
  }

  async list(): Promise<DreamProposal[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const proposals = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5)))
    );
    return proposals.filter((item): item is DreamProposal => Boolean(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(id: string): Promise<DreamProposal | null> {
    assertId(id);
    try {
      return JSON.parse(await fs.readFile(this.file(id), "utf8")) as DreamProposal;
    } catch {
      return null;
    }
  }

  async save(proposal: DreamProposal): Promise<void> {
    assertId(proposal.id);
    await fs.mkdir(this.root, { recursive: true });
    const target = this.file(proposal.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  }

  async reject(id: string): Promise<DreamProposal> {
    return withProposalLock(this.root, async () => {
      const proposal = await this.requirePending(id);
      proposal.status = "rejected";
      proposal.updatedAt = new Date().toISOString();
      delete proposal.error;
      await this.save(proposal);
      return proposal;
    });
  }

  async apply(id: string): Promise<DreamProposal> {
    return withProposalLock(this.root, async () => {
      const proposal = await this.requirePending(id);
      const corrupt = proposal.edits
        .filter((edit) => hash(edit.before) !== edit.beforeHash || hash(edit.after) !== edit.afterHash)
        .map((edit) => edit.path);
      if (corrupt.length > 0) {
        proposal.status = "failed";
        proposal.error = `Proposal preimage integrity check failed: ${corrupt.join(", ")}`;
        proposal.updatedAt = new Date().toISOString();
        await this.save(proposal);
        throw new Error(proposal.error);
      }

      const conflicts = await this.conflicts(proposal.edits, "beforeHash");
      if (conflicts.length > 0) {
        proposal.status = "conflicted";
        proposal.error = `Live concepts changed after planning: ${conflicts.join(", ")}`;
        proposal.updatedAt = new Date().toISOString();
        await this.save(proposal);
        throw new Error(proposal.error);
      }

      const applied: DreamEdit[] = [];
      try {
        for (const edit of proposal.edits) {
          // Include the in-flight edit in compensation. KnowledgeBase writes
          // the concept before indexing/logging/autocommit, so a later failure
          // can otherwise leave the file changed even though applyRaw rejects.
          applied.push(edit);
          await applyRaw(this.kb, edit.path, edit.after, `Approved dream proposal ${proposal.id}`);
          const raw = await currentRaw(this.kb, edit.path);
          edit.applied = raw;
          edit.appliedHash = hash(raw);
        }
        proposal.status = "applied";
        proposal.updatedAt = new Date().toISOString();
        delete proposal.error;
        await this.save(proposal);
        return proposal;
      } catch (error) {
        const compensationErrors: string[] = [];
        for (const edit of [...applied].reverse()) {
          try {
            await applyRaw(
              this.kb,
              edit.path,
              edit.before,
              `Automatic rollback of failed dream proposal ${proposal.id}`
            );
          } catch (compensationError) {
            compensationErrors.push(`${edit.path}: ${errorMessage(compensationError)}`);
          }
        }
        proposal.status = "failed";
        proposal.error =
          `Dream apply failed: ${errorMessage(error)}` +
          (compensationErrors.length > 0
            ? `; automatic rollback also failed: ${compensationErrors.join("; ")}`
            : "; every completed edit was restored");
        proposal.updatedAt = new Date().toISOString();
        await this.save(proposal);
        throw new Error(proposal.error);
      }
    });
  }

  async rollback(id: string): Promise<DreamProposal> {
    return withProposalLock(this.root, async () => {
      const proposal = await this.require(id);
      if (proposal.status !== "applied") throw new Error(`Dream proposal ${id} is not applied`);
      const conflicts = await this.conflicts(proposal.edits, "appliedHash");
      if (conflicts.length > 0) {
        throw new Error(`Cannot rollback; live concepts changed after approval: ${conflicts.join(", ")}`);
      }

      const reverted: DreamEdit[] = [];
      try {
        for (const edit of [...proposal.edits].reverse()) {
          // As above, compensate an edit whose file mutation succeeded but
          // whose index/log/autocommit step failed afterward.
          reverted.push(edit);
          await applyRaw(this.kb, edit.path, edit.before, `Rollback dream proposal ${proposal.id}`);
        }
        proposal.status = "rolled_back";
        proposal.updatedAt = new Date().toISOString();
        delete proposal.error;
        await this.save(proposal);
        return proposal;
      } catch (error) {
        const compensationErrors: string[] = [];
        for (const edit of [...reverted].reverse()) {
          try {
            await applyRaw(
              this.kb,
              edit.path,
              edit.applied,
              `Restore interrupted rollback of dream proposal ${proposal.id}`
            );
          } catch (compensationError) {
            compensationErrors.push(`${edit.path}: ${errorMessage(compensationError)}`);
          }
        }
        proposal.status = compensationErrors.length === 0 ? "applied" : "failed";
        proposal.error =
          `Dream rollback failed: ${errorMessage(error)}` +
          (compensationErrors.length > 0
            ? `; restoring the applied state also failed: ${compensationErrors.join("; ")}`
            : "; the applied state was restored");
        proposal.updatedAt = new Date().toISOString();
        await this.save(proposal);
        throw new Error(proposal.error);
      }
    });
  }

  private async conflicts(edits: DreamEdit[], key: "beforeHash" | "appliedHash"): Promise<string[]> {
    const out: string[] = [];
    for (const edit of edits) {
      if (hash(await currentRaw(this.kb, edit.path)) !== edit[key]) out.push(edit.path);
    }
    return out;
  }

  private async require(id: string): Promise<DreamProposal> {
    const proposal = await this.read(id);
    if (!proposal) throw new Error(`Unknown dream proposal: ${id}`);
    return proposal;
  }

  private async requirePending(id: string): Promise<DreamProposal> {
    const proposal = await this.require(id);
    if (proposal.status !== "pending") throw new Error(`Dream proposal ${id} is ${proposal.status}, not pending`);
    return proposal;
  }

  private file(id: string): string {
    return path.join(this.root, `${id}.json`);
  }
}

export async function createDreamProposal(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {},
  runner: typeof runMutation = runMutation,
): Promise<DreamProposalReport> {
  const store = new DreamProposalStore(kb);
  return withProposalLock(store.root, async () => {
    const pending = (await store.list()).find((proposal) => proposal.status === "pending");
    if (pending) {
      return { ran: false, reason: `dream proposal ${pending.id} is already awaiting review` };
    }
    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "librarian-dream-"));
    try {
      await fs.cp(kb.bundle.root, stagingRoot, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(kb.bundle.root, source);
          return relative !== ".librarian" && !relative.startsWith(`.librarian${path.sep}`)
            && relative !== ".git" && !relative.startsWith(`.git${path.sep}`);
        },
      });
      const staged = new StagedKnowledgeBase(stagingRoot);
      const before = await snapshotConcepts(staged);
      const outcome = await runner(staged, instruction, {
        ...options,
        cwd: stagingRoot,
        bundleRoot: stagingRoot,
        title: options.title ?? "Librarian dream proposal",
      });
      const normalized = mutationResult(outcome);
      if (!normalized.ok) return { ran: false, reason: normalized.error };
      if (normalized.traceId) {
        const trace = await new TraceStore(stagingRoot).read(normalized.traceId);
        if (trace) await new TraceStore(kb.bundle.root).save(trace);
      }
      const after = await snapshotConcepts(staged);
      const edits = buildEdits(before, after);
      if (edits.length === 0) return { ran: false, reason: "dream agent proposed no concept changes" };
      const now = new Date().toISOString();
      const proposal: DreamProposal = {
        id: `${Date.now()}-${randomUUID()}`,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        instruction,
        summary: normalized.summary,
        ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
        ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
        edits,
      };
      await store.save(proposal);
      return { ran: true, proposal };
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

function mutationResult(outcome: MutationOutcome): { ok: true; summary: string; traceId?: string; sessionId?: string } | { ok: false; error: string } {
  if (outcome.ok) return {
    ok: true,
    summary: outcome.result.summary,
    traceId: outcome.result.traceId,
    sessionId: outcome.result.sessionId,
  };
  return { ok: false, error: `dream planning ${outcome.status}: ${outcome.error}` };
}

function buildEdits(before: Map<string, string>, after: Map<string, string>): DreamEdit[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.filter((conceptPath) => before.get(conceptPath) !== after.get(conceptPath)).map((conceptPath) => {
    const beforeRaw = before.get(conceptPath) ?? null;
    const afterRaw = after.get(conceptPath) ?? null;
    return {
      path: conceptPath,
      action: beforeRaw === null ? "create" : afterRaw === null ? "delete" : "update",
      before: beforeRaw,
      after: afterRaw,
      beforeHash: hash(beforeRaw),
      afterHash: hash(afterRaw),
      applied: null,
      appliedHash: null,
    };
  });
}

async function currentRaw(kb: KnowledgeBase, conceptPath: string): Promise<string | null> {
  try {
    return (await kb.readConcept(conceptPath)).raw;
  } catch {
    return null;
  }
}

async function applyRaw(kb: KnowledgeBase, conceptPath: string, raw: string | null, summary: string): Promise<void> {
  const exists = await kb.bundle.exists(conceptPath);
  if (raw === null) {
    if (exists) await kb.deleteConcept(conceptPath, summary);
    return;
  }
  const parsed = parseDoc(raw);
  await kb.writeConcept(conceptPath, parsed.frontmatter as ConceptFrontmatter, parsed.body, summary);
}

function hash(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid dream proposal id");
}

async function withProposalLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = proposalLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  proposalLocks.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (proposalLocks.get(key) === tail) proposalLocks.delete(key);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
