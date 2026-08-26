import {
  parseDuration,
  runDream,
  type DreamReport,
  type KnowledgeBase,
} from "@understory/core";

const DEFAULT_INTERVAL = "6h";
const DEFAULT_START_DELAY = "10m";
const MIN_INTERVAL_MS = 5 * 60_000;
const MIN_START_DELAY_MS = 30_000;

export type DreamTrigger = "scheduled" | "manual";

export interface DreamRunStatus {
  trigger: DreamTrigger;
  startedAt: string;
  finishedAt: string;
  ran: boolean;
  reason?: string;
  summary?: string;
  proposalId?: string;
  editCount: number;
  error?: string;
}

export interface DreamerStatus {
  enabled: boolean;
  running: boolean;
  interval: string;
  intervalMs: number | null;
  startDelay: string;
  startDelayMs: number | null;
  nextRunAt?: string;
  lastRun?: DreamRunStatus;
  configurationError?: string;
}

/**
 * One observable scheduler shared by background and manual dream requests.
 *
 * A short first-run delay makes a newly started Librarian useful without
 * launching an agent during process startup. Every later run is scheduled
 * only after the previous run finishes, so slow delegated turns never overlap
 * or accumulate an interval backlog.
 */
export class Dreamer {
  private readonly intervalLabel: string;
  private readonly intervalMs: number | null;
  private readonly startDelayLabel: string;
  private readonly startDelayMs: number | null;
  private readonly configurationError?: string;
  private timer?: NodeJS.Timeout;
  private nextRunAt?: string;
  private running = false;
  private lastRun?: DreamRunStatus;

  constructor(
    private readonly kb: KnowledgeBase,
    env: NodeJS.ProcessEnv = process.env
  ) {
    const configuredInterval = env.DREAM_INTERVAL?.trim() || DEFAULT_INTERVAL;
    this.intervalLabel = configuredInterval;

    if (isDisabled(configuredInterval)) {
      this.intervalMs = null;
      this.startDelayLabel = env.DREAM_START_DELAY?.trim() || DEFAULT_START_DELAY;
      this.startDelayMs = null;
      return;
    }

    const parsedInterval = parseDuration(configuredInterval);
    if (parsedInterval === null || parsedInterval <= 0) {
      this.intervalMs = null;
      this.startDelayLabel = env.DREAM_START_DELAY?.trim() || DEFAULT_START_DELAY;
      this.startDelayMs = null;
      this.configurationError =
        `invalid DREAM_INTERVAL "${configuredInterval}"; use a duration such as 6h or "off"`;
      return;
    }

    this.intervalMs = Math.max(parsedInterval, MIN_INTERVAL_MS);
    this.startDelayLabel = env.DREAM_START_DELAY?.trim() || DEFAULT_START_DELAY;
    const parsedDelay = parseDuration(this.startDelayLabel);
    if (parsedDelay === null || parsedDelay < 0) {
      this.startDelayMs = Math.min(this.intervalMs, parseDuration(DEFAULT_START_DELAY)!);
      this.configurationError =
        `invalid DREAM_START_DELAY "${this.startDelayLabel}"; using ${DEFAULT_START_DELAY}`;
    } else {
      this.startDelayMs = Math.min(
        this.intervalMs,
        Math.max(parsedDelay, MIN_START_DELAY_MS)
      );
    }
  }

  start(): this {
    if (this.configurationError) {
      console.error(`[librarian] dreaming: ${this.configurationError}`);
    }
    if (this.intervalMs === null || this.startDelayMs === null) {
      console.log(
        "[librarian] dreaming: disabled (set DREAM_INTERVAL to a duration, e.g. 6h, to enable)"
      );
      return this;
    }

    const clamped = this.intervalMs !== parseDuration(this.intervalLabel);
    console.log(
      `[librarian] dreaming: first check in ${this.startDelayLabel}; then every ${this.intervalLabel}` +
        `${clamped ? " (interval clamped to 5m minimum)" : ""}`
    );
    this.schedule(this.startDelayMs);
    return this;
  }

  status(): DreamerStatus {
    return {
      enabled: this.intervalMs !== null,
      running: this.running,
      interval: this.intervalLabel,
      intervalMs: this.intervalMs,
      startDelay: this.startDelayLabel,
      startDelayMs: this.startDelayMs,
      ...(this.nextRunAt ? { nextRunAt: this.nextRunAt } : {}),
      ...(this.lastRun ? { lastRun: { ...this.lastRun } } : {}),
      ...(this.configurationError ? { configurationError: this.configurationError } : {}),
    };
  }

  async runNow(trigger: DreamTrigger = "manual"): Promise<DreamReport> {
    if (this.running) {
      return { ran: false, reason: "a dream is already in progress" };
    }

    if (trigger === "manual") this.clearTimer();
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const report = await runDream(this.kb);
      this.lastRun = {
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        ran: report.ran,
        ...(report.reason ? { reason: report.reason } : {}),
        ...(report.summary ? { summary: report.summary } : {}),
        ...(report.proposalId ? { proposalId: report.proposalId } : {}),
        editCount: report.filesChanged?.length ?? 0,
      };
      if (report.ran) {
        console.log(
          `[librarian] dream proposal ${report.proposalId}: ` +
            `${report.filesChanged?.length ?? 0} candidate edit(s), awaiting approval — ` +
            truncate(report.summary ?? "", 200)
        );
      } else {
        console.log(`[librarian] dream skipped: ${report.reason}`);
      }
      return report;
    } catch (error) {
      const detail = message(error);
      this.lastRun = {
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        ran: false,
        editCount: 0,
        error: detail,
      };
      console.error(`[librarian] dream failed: ${detail}`);
      throw error;
    } finally {
      this.running = false;
      if (this.intervalMs !== null) this.schedule(this.intervalMs);
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRunAt = undefined;
      void this.runNow("scheduled").catch(() => {});
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }
}

export function startDreamer(kb: KnowledgeBase): Dreamer {
  return new Dreamer(kb).start();
}

function isDisabled(value: string): boolean {
  return ["0", "false", "off", "disabled", "none"].includes(value.trim().toLowerCase());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length - 1) + "…" : value;
}
