import { existsSync } from "node:fs";
import type { Socket } from "bun";
import { takeLines } from "./lines";
import { paths } from "./paths";
import { type ClientMsg, PROTOCOL_VERSION, type ServerMsg } from "./protocol";

/** Race a promise against a timeout that is cleared afterwards, so it never holds the process open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Client side of the socket: JSON lines in, JSON lines out. */
export class Conn {
  private socket?: Socket<undefined>;
  private buf = "";
  private decoder = new TextDecoder();
  private listeners: ((msg: ServerMsg) => void)[] = [];
  private closeListeners: (() => void)[] = [];
  closed = false;

  /** Returns null when the daemon is not reachable; callers fail open. */
  /**
   * `timeoutMs` bounds a connect to a live but slow daemon. `refusedRetryMs` covers the moment a
   * daemon restarts (after an upgrade): the socket file exists but nothing listens yet, so keep
   * trying briefly instead of failing open. A daemon that is really gone costs that long once.
   */
  static async open(timeoutMs = 1000, socketPath = paths.socket, refusedRetryMs = 0): Promise<Conn | null> {
    const until = Date.now() + refusedRetryMs;
    while (true) {
      if (!existsSync(socketPath)) return null;
      const conn = await Conn.tryOpen(timeoutMs, socketPath);
      if (conn || Date.now() >= until) return conn;
      await Bun.sleep(100);
    }
  }

  private static async tryOpen(timeoutMs: number, socketPath: string): Promise<Conn | null> {
    const conn = new Conn();
    try {
      const socket = await withTimeout(
        Bun.connect({
          unix: socketPath,
          socket: {
            data: (_s, chunk) => conn.feed(chunk),
            close: () => conn.handleClose(),
            error: () => conn.handleClose(),
          },
        }),
        timeoutMs,
      );
      if (!socket) return null;
      conn.socket = socket;
      return conn;
    } catch {
      return null;
    }
  }

  send(msg: ClientMsg): void {
    if (this.closed || !this.socket) return;
    this.socket.write(`${JSON.stringify({ ...msg, v: PROTOCOL_VERSION })}\n`);
  }

  onMessage(fn: (msg: ServerMsg) => void): void {
    this.listeners.push(fn);
  }

  onClose(fn: () => void): void {
    this.closeListeners.push(fn);
  }

  /** One-shot request: send, wait for the first reply, close. */
  async request(msg: ClientMsg, timeoutMs = 2000): Promise<ServerMsg | null> {
    const reply = new Promise<ServerMsg | null>((resolve) => {
      this.onMessage(resolve);
      this.onClose(() => resolve(null));
    });
    this.send(msg);
    const res = await withTimeout(reply, timeoutMs);
    this.close();
    return res;
  }

  close(): void {
    if (this.closed) return;
    this.socket?.end();
    this.handleClose();
  }

  private feed(chunk: Uint8Array): void {
    const { lines, rest } = takeLines(this.buf + this.decoder.decode(chunk, { stream: true }));
    this.buf = rest;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as ServerMsg;
        for (const fn of this.listeners) fn(msg);
      } catch {}
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeListeners) fn();
  }
}

/** Open, send one message, return the reply. `timeoutMs` bounds connecting and replying each. */
export async function ask(msg: ClientMsg, timeoutMs = 5000): Promise<ServerMsg | null> {
  const conn = await Conn.open(timeoutMs);
  if (!conn) return null;
  return conn.request(msg, timeoutMs);
}
