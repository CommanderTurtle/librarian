/**
 * Human review surface for isolated, proposal-only memory consolidation.
 * Background state is polled so a scheduled proposal appears without a page
 * reload; all live-memory mutations remain explicit authenticated actions.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type DreamEdit,
  type DreamerStatus,
  type DreamProposal,
} from "../api";

const REFRESH_MS = 10_000;
type Filter = "pending" | "history" | "all";
type Action = "propose" | "approve" | "reject" | "rollback";

export function DreamsView({ onApplied }: { onApplied: () => void }) {
  const [proposals, setProposals] = useState<DreamProposal[]>([]);
  const [status, setStatus] = useState<DreamerStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [nextProposals, nextStatus] = await Promise.all([
        api.dreams(),
        api.dreamsStatus(),
      ]);
      setProposals(nextProposals);
      setStatus(nextStatus);
      setSelectedId((current) =>
        nextProposals.some((proposal) => proposal.id === current)
          ? current
          : nextProposals.find((proposal) => proposal.status === "pending")?.id ??
            nextProposals[0]?.id ??
            null
      );
      setError("");
    } catch (caught) {
      if (!quiet) setError(errorText(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const visibleProposals = useMemo(() => {
    if (filter === "pending") return proposals.filter((proposal) => proposal.status === "pending");
    if (filter === "history") return proposals.filter((proposal) => proposal.status !== "pending");
    return proposals;
  }, [filter, proposals]);

  useEffect(() => {
    if (selectedId && visibleProposals.some((proposal) => proposal.id === selectedId)) return;
    setSelectedId(visibleProposals[0]?.id ?? null);
  }, [selectedId, visibleProposals]);

  const selected = proposals.find((proposal) => proposal.id === selectedId) ?? null;
  const pendingCount = proposals.filter((proposal) => proposal.status === "pending").length;

  const act = async (action: Action) => {
    if (!confirmAction(action, selected)) return;
    setBusy(action);
    setNotice("");
    setError("");
    try {
      if (action === "propose") {
        const report = await api.proposeDream();
        if (report.proposal) {
          setFilter("pending");
          setSelectedId(report.proposal.id);
        }
        setNotice(
          report.ran
            ? "Proposal staged. Live memory is unchanged until approval."
            : report.reason ?? "The deterministic checks found nothing to consolidate."
        );
      } else if (selected) {
        if (action === "approve") await api.approveDream(selected.id);
        if (action === "reject") await api.rejectDream(selected.id);
        if (action === "rollback") await api.rollbackDream(selected.id);
        if (action === "approve" || action === "rollback") onApplied();
        setNotice(actionMessage(action));
      }
      await refresh(true);
    } catch (caught) {
      setError(errorText(caught));
      await refresh(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 bg-zinc-950">
      <section className="flex w-80 shrink-0 flex-col border-r border-zinc-800">
        <div className="border-b border-zinc-800 p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-100">Wiki dreams</h2>
                {pendingCount > 0 && (
                  <span className="rounded-full bg-cyan-950 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
                    {pendingCount} pending
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">
                Isolated planning. Exact human-reviewed application.
              </p>
            </div>
            <button
              disabled={Boolean(busy) || status?.running}
              onClick={() => void act("propose")}
              className="ml-auto shrink-0 rounded bg-cyan-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "propose" || status?.running ? "Dreaming…" : "Dream now"}
            </button>
          </div>
          <SchedulerCard status={status} />
          <div className="mt-3 grid grid-cols-3 rounded border border-zinc-800 bg-zinc-900/50 p-0.5 text-[11px]">
            {(["pending", "history", "all"] as const).map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={`rounded px-2 py-1 capitalize ${
                  filter === item ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading && <p className="px-2 py-3 text-xs text-zinc-500">Loading dream history…</p>}
          {!loading && visibleProposals.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-5 text-center">
              <p className="text-xs font-medium text-zinc-400">
                {filter === "pending" ? "No proposal is waiting." : "No dream history yet."}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-zinc-600">
                Healthy memory produces a skipped check, not a forced rewrite.
              </p>
            </div>
          )}
          {visibleProposals.map((proposal) => {
            const counts = editCounts(proposal.edits);
            return (
              <button
                key={proposal.id}
                onClick={() => setSelectedId(proposal.id)}
                className={`mb-1.5 w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  selectedId === proposal.id
                    ? "border-cyan-700 bg-cyan-950/30"
                    : "border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900"
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-zinc-200">
                    {proposal.edits.length} edit{proposal.edits.length === 1 ? "" : "s"}
                  </span>
                  <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${badge(proposal.status)}`}>
                    {statusLabel(proposal.status)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">
                  {proposal.summary || "No agent summary was recorded."}
                </p>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] text-zinc-600">
                  {counts.create > 0 && <span>+{counts.create}</span>}
                  {counts.update > 0 && <span>~{counts.update}</span>}
                  {counts.delete > 0 && <span>-{counts.delete}</span>}
                  <time className="ml-auto" dateTime={proposal.createdAt}>
                    {shortDate(proposal.createdAt)}
                  </time>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        {notice && (
          <p className="mb-3 rounded border border-cyan-900/70 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-200">
            {notice}
          </p>
        )}
        {error && (
          <p className="mb-3 rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
        {!selected ? (
          <div className="flex h-full min-h-72 items-center justify-center">
            <div className="max-w-md text-center">
              <h2 className="text-base font-semibold text-zinc-300">No dream selected</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                Dreaming inspects graph health and recent wiki activity, then stages only an exact,
                reversible proposal. Nothing here can silently edit live memory.
              </p>
            </div>
          </div>
        ) : (
          <ProposalDetail
            proposal={selected}
            busy={busy}
            onAction={(action) => void act(action)}
          />
        )}
      </section>
    </div>
  );
}

function SchedulerCard({ status }: { status: DreamerStatus | null }) {
  if (!status) {
    return <div className="mt-3 h-14 animate-pulse rounded-lg bg-zinc-900" />;
  }
  const headline = status.running
    ? "Dream check in progress"
    : status.enabled
      ? `Automatic every ${formatDuration(status.intervalMs)}`
      : "Automatic dreaming disabled";
  const detail = status.running
    ? "The delegated agent is writing only to an isolated bundle copy."
    : status.nextRunAt
      ? `Next check ${relativeTime(status.nextRunAt)} · ${new Date(status.nextRunAt).toLocaleString()}`
      : status.lastRun
        ? lastRunLabel(status.lastRun)
        : status.enabled
          ? `First check after ${status.startDelay}`
          : "Manual Dream now remains available.";

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${status.running ? "animate-pulse bg-cyan-400" : status.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
        <span className="text-[11px] font-medium text-zinc-300">{headline}</span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-zinc-500">{detail}</p>
      {status.configurationError && (
        <p className="mt-1 text-[10px] leading-4 text-amber-400">{status.configurationError}</p>
      )}
    </div>
  );
}

function ProposalDetail({
  proposal,
  busy,
  onAction,
}: {
  proposal: DreamProposal;
  busy: Action | null;
  onAction: (action: Exclude<Action, "propose">) => void;
}) {
  const counts = editCounts(proposal.edits);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-start gap-3 border-b border-zinc-800 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-100">Review exact wiki changes</h2>
            <span className={`rounded px-2 py-0.5 text-[10px] ${badge(proposal.status)}`}>
              {statusLabel(proposal.status)}
            </span>
          </div>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-400">
            {proposal.summary || "No agent summary was recorded; the exact diff below remains authoritative."}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600">
            <span>{counts.create} created</span>
            <span>{counts.update} updated</span>
            <span>{counts.delete} deleted</span>
            <span>planned {new Date(proposal.createdAt).toLocaleString()}</span>
            {proposal.updatedAt !== proposal.createdAt && (
              <span>resolved {new Date(proposal.updatedAt).toLocaleString()}</span>
            )}
          </div>
          <code className="mt-2 block break-all text-[10px] text-zinc-700">{proposal.id}</code>
        </div>
        <div className="flex shrink-0 gap-2">
          {proposal.status === "pending" && (
            <>
              <button
                disabled={Boolean(busy)}
                onClick={() => onAction("reject")}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
              <button
                disabled={Boolean(busy)}
                onClick={() => onAction("approve")}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
              >
                {busy === "approve" ? "Applying…" : "Approve exact diff"}
              </button>
            </>
          )}
          {proposal.status === "applied" && (
            <button
              disabled={Boolean(busy)}
              onClick={() => onAction("rollback")}
              className="rounded bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-40"
            >
              {busy === "rollback" ? "Rolling back…" : "Rollback exact diff"}
            </button>
          )}
        </div>
      </div>

      {proposal.error && (
        <p className="mb-4 rounded border border-red-900/60 bg-red-950/20 px-3 py-2 text-xs text-red-300">
          {proposal.error}
        </p>
      )}

      <details className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/30">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200">
          Why this dream ran and what the agent was authorized to inspect
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-zinc-800 p-3 text-[11px] leading-5 text-zinc-500">
          {proposal.instruction}
        </pre>
        {(proposal.traceId || proposal.sessionId) && (
          <div className="border-t border-zinc-800 px-3 py-2 font-mono text-[10px] text-zinc-600">
            {proposal.traceId && <div>trace {proposal.traceId}</div>}
            {proposal.sessionId && <div>session {proposal.sessionId}</div>}
          </div>
        )}
      </details>

      <div className="space-y-4">
        {proposal.edits.map((edit, index) => (
          <EditDiff key={edit.path} edit={edit} defaultOpen={index === 0} />
        ))}
      </div>
    </>
  );
}

function EditDiff({ edit, defaultOpen }: { edit: DreamEdit; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const diff = useMemo(() => lineDiff(edit.before, edit.after), [edit.after, edit.before]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 uppercase ${actionBadge(edit.action)}`}>{edit.action}</span>
        <code className="min-w-0 truncate text-cyan-300">{edit.path}</code>
        <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
          {diff.before.filter((line) => line.changed).length}− / {diff.after.filter((line) => line.changed).length}+
        </span>
      </summary>
      <div className="overflow-x-auto">
        <div className="grid min-w-[48rem] grid-cols-2 divide-x divide-zinc-800">
          <DiffPane label="Before" lines={diff.before} tone="red" empty={edit.before === null} />
          <DiffPane label="Proposed" lines={diff.after} tone="green" empty={edit.after === null} />
        </div>
      </div>
    </details>
  );
}

interface DiffLine {
  number: number;
  text: string;
  changed: boolean;
}

function DiffPane({
  label,
  lines,
  tone,
  empty,
}: {
  label: string;
  lines: DiffLine[];
  tone: "red" | "green";
  empty: boolean;
}) {
  return (
    <div className="min-w-0 bg-zinc-950">
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      {empty ? (
        <div className="p-4 font-mono text-xs text-zinc-700">∅</div>
      ) : (
        <pre className="max-h-[38rem] overflow-auto text-[11px] leading-5">
          {lines.map((line) => (
            <span
              key={line.number}
              className={`block min-w-max pr-3 ${
                line.changed
                  ? tone === "red"
                    ? "bg-red-950/35 text-red-200"
                    : "bg-emerald-950/35 text-emerald-200"
                  : "text-zinc-500"
              }`}
            >
              <span className="mr-3 inline-block w-10 select-none border-r border-zinc-900 pr-2 text-right text-zinc-700">
                {line.number}
              </span>
              {line.text || " "}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function lineDiff(before: string | null, after: string | null): { before: DiffLine[]; after: DiffLine[] } {
  const left = before === null ? [] : before.split("\n");
  const right = after === null ? [] : after.split("\n");
  const leftMatched = new Set<number>();
  const rightMatched = new Set<number>();

  if (left.length * right.length <= 400_000) {
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        table[i][j] = left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        leftMatched.add(i++);
        rightMatched.add(j++);
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  } else {
    // Large concepts avoid a quadratic browser allocation. Exact common
    // prefix/suffix lines stay neutral; the middle remains visibly changed.
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
      leftMatched.add(prefix);
      rightMatched.add(prefix);
      prefix++;
    }
    let li = left.length - 1;
    let ri = right.length - 1;
    while (li >= prefix && ri >= prefix && left[li] === right[ri]) {
      leftMatched.add(li--);
      rightMatched.add(ri--);
    }
  }

  return {
    before: left.map((text, index) => ({ number: index + 1, text, changed: !leftMatched.has(index) })),
    after: right.map((text, index) => ({ number: index + 1, text, changed: !rightMatched.has(index) })),
  };
}

function editCounts(edits: DreamEdit[]): Record<DreamEdit["action"], number> {
  const counts = { create: 0, update: 0, delete: 0 };
  for (const edit of edits) counts[edit.action]++;
  return counts;
}

function confirmAction(action: Action, proposal: DreamProposal | null): boolean {
  if (action === "propose") return true;
  if (!proposal) return false;
  if (action === "approve") {
    return window.confirm(
      `Apply ${proposal.edits.length} exact dream edit(s) to live memory? Baselines will be rechecked first.`
    );
  }
  if (action === "reject") return window.confirm("Reject this proposal without changing live memory?");
  return window.confirm(
    `Restore the preimages for ${proposal.edits.length} applied edit(s)? Newer live changes will block rollback.`
  );
}

function actionMessage(action: Exclude<Action, "propose">): string {
  if (action === "approve") return "Proposal applied after exact baseline verification.";
  if (action === "reject") return "Proposal rejected. Live memory was not changed.";
  return "Proposal rolled back to its recorded preimages.";
}

function badge(status: DreamProposal["status"]): string {
  if (status === "pending") return "bg-cyan-950 text-cyan-300";
  if (status === "applied") return "bg-emerald-950 text-emerald-300";
  if (status === "rolled_back") return "bg-amber-950 text-amber-300";
  if (status === "conflicted" || status === "failed") return "bg-red-950 text-red-300";
  return "bg-zinc-800 text-zinc-400";
}

function actionBadge(action: DreamEdit["action"]): string {
  if (action === "create") return "bg-emerald-950 text-emerald-300";
  if (action === "delete") return "bg-red-950 text-red-300";
  return "bg-amber-950 text-amber-300";
}

function statusLabel(status: DreamProposal["status"]): string {
  return status.replace("_", " ");
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeTime(value: string): string {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds)) return "at an unknown time";
  if (milliseconds <= 0) return "now";
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "off";
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000}d`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  return `${Math.round(milliseconds / 1000)}s`;
}

function lastRunLabel(run: NonNullable<DreamerStatus["lastRun"]>): string {
  if (run.error) return `Last ${run.trigger} check failed: ${run.error}`;
  if (run.ran) return `Last ${run.trigger} check staged ${run.editCount} edit(s).`;
  return `Last ${run.trigger} check skipped: ${run.reason ?? "nothing to consolidate"}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
