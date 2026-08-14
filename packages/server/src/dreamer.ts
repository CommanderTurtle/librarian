import { parseDuration, runDream, type KnowledgeBase } from "@understory/core";

const MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Background dreamer: plans a consolidation pass every DREAM_INTERVAL in an
 * isolated bundle copy. It never mutates live memory; approval remains a
 * human action in the web UI. The first run happens one interval after boot.
 */
export function startDreamer(kb: KnowledgeBase): void {
  const raw = process.env.DREAM_INTERVAL;
  const interval = parseDuration(raw);
  if (!interval) {
    if (raw) console.error(`[librarian] invalid DREAM_INTERVAL "${raw}" — dreaming disabled`);
    else console.log("[librarian] dreaming: disabled (set DREAM_INTERVAL, e.g. 6h, to enable)");
    return;
  }
  const every = Math.max(interval, MIN_INTERVAL_MS);
  console.log(`[librarian] dreaming: every ${raw}${every !== interval ? " (clamped to 5m minimum)" : ""}`);

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // never overlap dreams
    busy = true;
    try {
      const report = await runDream(kb);
      if (report.ran) {
        console.log(
          `[librarian] dream proposal ${report.proposalId}: ${report.filesChanged?.length ?? 0} candidate edit(s), awaiting approval — ${truncate(report.summary ?? "", 200)}`
        );
      } else {
        console.log(`[librarian] dream skipped: ${report.reason}`);
      }
    } catch (err) {
      console.error(`[librarian] dream failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, every);
  timer.unref(); // never keep the process alive just to dream
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
