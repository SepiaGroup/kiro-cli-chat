// A bounded, numbered log of what a chat posted to its screens, so a browser
// that dropped off can ask for "everything after N". Ids carry an epoch so a
// number from an earlier log (the extension restarted) is never trusted.
// Pure (no vscode import).

import { randomBytes } from "crypto";

export interface LogEntry<T> {
  seq: number;
  msg: T;
}

export class EventLog<T = unknown> {
  readonly epoch = randomBytes(6).toString("hex");
  private items: Array<LogEntry<T>> = [];
  private next = 1;

  constructor(private readonly max = 2000) {}

  push(msg: T): number {
    const seq = this.next++;
    this.items.push({ seq, msg });
    if (this.items.length > this.max + this.max / 4) {
      this.items.splice(0, this.items.length - this.max);
    }
    return seq;
  }

  /** The newest number used (0 when nothing was logged). */
  get lastSeq(): number {
    return this.next - 1;
  }

  /** The id sent to the browser with a message. */
  idOf(seq: number): string {
    return `${this.epoch}:${seq}`;
  }

  /** The number inside an id from this log; undefined for anything else. */
  parseId(id: string | undefined): number | undefined {
    if (!id) {
      return undefined;
    }
    const m = /^([0-9a-f]+):(\d+)$/.exec(id);
    if (!m || m[1] !== this.epoch) {
      return undefined;
    }
    const seq = Number(m[2]);
    return Number.isSafeInteger(seq) ? seq : undefined;
  }

  /**
   * What came after `seq`. Undefined when the log cannot say (it no longer
   * reaches back that far, or `seq` is from the future): send a snapshot then.
   */
  after(seq: number): Array<LogEntry<T>> | undefined {
    if (seq > this.lastSeq) {
      return undefined;
    }
    if (seq === this.lastSeq) {
      return [];
    }
    const oldest = this.items[0]?.seq;
    if (oldest === undefined || seq < oldest - 1) {
      return undefined;
    }
    return this.items.filter((e) => e.seq > seq).slice(-this.max);
  }
}
