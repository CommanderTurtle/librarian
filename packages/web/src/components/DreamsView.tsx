/**
 * Review surface derived from Prime Agent's proposal/rollback lifecycle,
 * LongHorizon's dashboard approval records, and Librarian's existing App/API
 * split. Approval stays human-only; no MCP tool can invoke these actions.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type DreamProposal } from "../api";

export function DreamsView({ onApplied }: { onApplied: () => void }) {
  const [proposals, setProposals] = useState<DreamProposal[]>([]);
  const [selected, setSelected] = useState<DreamProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const next = await api.dreams();
    setProposals(next);
    setSelected((current) => next.find((item) => item.id === current?.id) ?? next[0] ?? null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (action: "propose" | "approve" | "reject" | "rollback") => {
    setBusy(true);
    setMessage("");
    try {
      if (action === "propose") {
        const report = await api.proposeDream();
        setMessage(report.ran ? "Proposal staged. Live memory is unchanged." : report.reason ?? "No proposal needed.");
      } else if (selected) {
        if (action === "approve") await api.approveDream(selected.id);
        if (action === "reject") await api.rejectDream(selected.id);
        if (action === "rollback") await api.rollbackDream(selected.id);
        if (action === "approve" || action === "rollback") onApplied();
      }
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <section className="w-72 shrink-0 overflow-y-auto border-r border-zinc-800 p-3">
        <div className="mb-3 flex items-center gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Dream proposals</h2>
            <p className="text-[11px] text-zinc-500">Planning is isolated. Approval mutates memory.</p>
          </div>
          <button disabled={busy} onClick={() => void act("propose")} className="ml-auto rounded bg-cyan-700 px-2 py-1 text-xs text-white disabled:opacity-40">
            Propose
          </button>
        </div>
        {proposals.map((proposal) => (
          <button key={proposal.id} onClick={() => setSelected(proposal)} className={`mb-1 w-full rounded border px-2 py-2 text-left ${selected?.id === proposal.id ? "border-cyan-700 bg-cyan-950/30" : "border-zinc-800 hover:bg-zinc-900"}`}>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-zinc-200">{proposal.edits.length} edit{proposal.edits.length === 1 ? "" : "s"}</span>
              <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${badge(proposal.status)}`}>{proposal.status}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">{proposal.summary}</p>
          </button>
        ))}
        {!proposals.length && <p className="text-xs text-zinc-500">No dream proposals yet.</p>}
      </section>

      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        {message && <p className="mb-3 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">{message}</p>}
        {!selected ? <p className="text-sm text-zinc-500">Create or select a proposal.</p> : (
          <>
            <div className="mb-4 flex items-start gap-3">
              <div>
                <h2 className="text-base font-semibold text-zinc-100">Review before applying</h2>
                <p className="mt-1 max-w-3xl text-sm text-zinc-400">{selected.summary}</p>
                {selected.error && <p className="mt-2 text-xs text-red-400">{selected.error}</p>}
              </div>
              <div className="ml-auto flex gap-2">
                {selected.status === "pending" && <>
                  <button disabled={busy} onClick={() => void act("reject")} className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300">Reject</button>
                  <button disabled={busy} onClick={() => void act("approve")} className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white">Approve exact diff</button>
                </>}
                {selected.status === "applied" && <button disabled={busy} onClick={() => void act("rollback")} className="rounded bg-amber-700 px-3 py-1.5 text-xs text-white">Rollback</button>}
              </div>
            </div>
            <div className="space-y-5">
              {selected.edits.map((edit) => (
                <article key={edit.path} className="overflow-hidden rounded-lg border border-zinc-800">
                  <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 uppercase text-zinc-400">{edit.action}</span>
                    <code className="text-cyan-300">{edit.path}</code>
                  </header>
                  <div className="grid grid-cols-2 divide-x divide-zinc-800">
                    <DiffPane label="Before" value={edit.before} tone="text-red-200" />
                    <DiffPane label="Proposed" value={edit.after} tone="text-emerald-200" />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function DiffPane({ label, value, tone }: { label: string; value: string | null; tone: string }) {
  return <div className="min-w-0 bg-zinc-950">
    <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
    <pre className={`max-h-[34rem] overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 ${tone}`}>{value ?? "∅"}</pre>
  </div>;
}

function badge(status: DreamProposal["status"]): string {
  if (status === "pending") return "bg-cyan-950 text-cyan-300";
  if (status === "applied") return "bg-emerald-950 text-emerald-300";
  if (status === "rolled_back") return "bg-amber-950 text-amber-300";
  return "bg-zinc-800 text-zinc-400";
}
