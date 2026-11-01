export interface LoadSample {
  /** Kernel memory pressure: 1 normal, 2 warn, 4 critical. */
  pressureLevel: number;
  /** Percent of memory the kernel considers available. */
  freePercent: number;
  swapUsedMb: number;
  swapTotalMb: number;
}

export interface Proc {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

/** Everything OS-specific lives behind this interface. Only macOS is implemented today. */
export interface Platform {
  sampleLoad(): LoadSample;
  listProcesses(): Proc[];
  /** New out-of-memory kill reports since `sinceMs` (macOS: JetsamEvent files). */
  oomEventsSince(sinceMs: number): number;
  notify(title: string, message: string): void;
}
