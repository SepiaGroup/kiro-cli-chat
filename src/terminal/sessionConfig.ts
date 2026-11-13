// The engine's session settings (model, mode, effort, autopilot, …) as the
// terminal chat knows them. Pure (no vscode import).

import type { ConfigOption } from "../types";

export class SessionConfig {
  private options: ConfigOption[] = [];

  /** All known settings, in the engine's order. */
  get all(): readonly ConfigOption[] {
    return this.options;
  }

  option(id: string): ConfigOption | undefined {
    return this.options.find((o) => o.id === id);
  }

  /** Apply a `configOptions` update (it may list only some settings). */
  merge(opts: ConfigOption[]): void {
    const map = new Map(this.options.map((o) => [o.id, o] as const));
    for (const o of opts) {
      map.set(o.id, o);
    }
    // The engine only offers effortLevel for effort-capable models.
    if (opts.some((o) => o.id === "model") && !opts.some((o) => o.id === "effortLevel")) {
      map.delete("effortLevel");
    }
    this.options = [...map.values()];
  }

  clear(): void {
    this.options = [];
  }

  /** The current value's display name. */
  valueName(opt: ConfigOption): string {
    const v = String(opt.currentValue ?? "");
    return opt.options?.find((o) => o.value === v)?.name ?? v;
  }

  get autopilot(): boolean {
    return String(this.option("autopilot")?.currentValue ?? "off") === "on";
  }
}
