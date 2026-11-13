// The screens one chat is shown on: the desktop webview and, with remote
// access, any number of browsers. Decides who gets which message and when.
// Pure (no vscode import), so it can be tested.

/** Anything a chat can post messages to (a vscode.Webview fits). */
export interface UiTarget {
  postMessage(msg: unknown): unknown;
}

export type TargetKind = "desktop" | "remote";

interface Entry {
  kind: TargetKind;
  ready: boolean;
}

export class UiTargets {
  private entries = new Map<UiTarget, Entry>();

  /**
   * Add a screen. The desktop webview gets messages at once (its listener is
   * attached before the page loads); a remote one only after it has said
   * "ready" and been caught up, so live messages never arrive before its snapshot.
   */
  add(target: UiTarget, kind: TargetKind): void {
    this.entries.set(target, { kind, ready: false });
  }

  remove(target: UiTarget): void {
    this.entries.delete(target);
  }

  clear(): void {
    this.entries.clear();
  }

  has(target: UiTarget): boolean {
    return this.entries.has(target);
  }

  kindOf(target: UiTarget): TargetKind | undefined {
    return this.entries.get(target)?.kind;
  }

  /** The screen's page has loaded and asked for the chat. */
  markReady(target: UiTarget): void {
    const e = this.entries.get(target);
    if (e) {
      e.ready = true;
    }
  }

  /** Forget that a screen was ready (its page was replaced). */
  markNotReady(target: UiTarget): void {
    const e = this.entries.get(target);
    if (e) {
      e.ready = false;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get remoteCount(): number {
    return [...this.entries.values()].filter((e) => e.kind === "remote").length;
  }

  /** Send to every screen that should see it. One failing screen does not stop the rest. */
  broadcast(msg: unknown): void {
    for (const [target, e] of [...this.entries]) {
      if (e.kind === "desktop" || e.ready) {
        deliver(target, msg);
      }
    }
  }

  /** A request meant for the desktop UI only. False if no desktop page is ready for it yet. */
  postToDesktop(msg: unknown): boolean {
    let sent = false;
    for (const [target, e] of [...this.entries]) {
      if (e.kind === "desktop" && e.ready) {
        deliver(target, msg);
        sent = true;
      }
    }
    return sent;
  }
}

/** Post without letting a throw or a rejected promise escape. */
export function deliver(target: UiTarget, msg: unknown): void {
  try {
    const r = target.postMessage(msg);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // The screen went away; its owner removes it.
  }
}
