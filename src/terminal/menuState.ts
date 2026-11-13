// The "/" menu shown under the terminal chat's prompt while typing a command:
// which items show, which one is selected, and what ↑ ↓ Tab Enter Esc do.
// Pure (no vscode import); the chat draws the lines and acts on the result.

import { fitAnsi, sanitize, style } from "./ansi";
import { EngineCommand, Menu, MenuValue, slashMenu, ValueSource } from "./slashCommands";

const MENU_ROWS = 8;

/** What a key did to the menu. */
export type MenuKeyResult =
  | { type: "redraw" }
  | { type: "setText"; text: string }
  | { type: "submit"; text: string };

export class MenuState {
  private menu?: Menu;
  private sel = 0;
  private text = "";
  private dismissedFor?: string;

  /**
   * Recompute the menu for the input `text`; returns the footer lines to draw
   * under the prompt (none when there's no menu). `enabled` is false while busy.
   */
  update(
    text: string,
    enabled: boolean,
    engineCommands: EngineCommand[],
    values: (s: ValueSource) => MenuValue[],
    cols: number
  ): string[] {
    if (text !== this.text) {
      this.text = text;
      this.sel = 0;
      if (this.dismissedFor !== undefined && text !== this.dismissedFor) {
        this.dismissedFor = undefined;
      }
    }
    this.menu = enabled && this.dismissedFor === undefined ? slashMenu(text, engineCommands, values) : undefined;
    return this.menu ? this.lines(this.menu, cols) : [];
  }

  /** Handle ↑ ↓ Tab Enter Esc when the menu has items; undefined if not consumed. */
  handleKey(data: string): MenuKeyResult | undefined {
    const items = this.menu?.items ?? [];
    if (items.length === 0) {
      return undefined;
    }
    switch (data) {
      case "\x1b[A":
      case "\x1bOA":
        this.sel = (this.sel - 1 + items.length) % items.length;
        return { type: "redraw" };
      case "\x1b[B":
      case "\x1bOB":
        this.sel = (this.sel + 1) % items.length;
        return { type: "redraw" };
      case "\t":
        return { type: "setText", text: items[this.sel].insert };
      case "\x1b":
        this.dismissedFor = this.text;
        return { type: "redraw" };
      case "\r": {
        const item = items[this.sel];
        return item.submit ? { type: "submit", text: item.insert.trimEnd() } : { type: "setText", text: item.insert };
      }
      default:
        return undefined;
    }
  }

  private lines(menu: Menu, cols: number): string[] {
    const width = Math.max(10, cols - 1);
    if (menu.items.length === 0) {
      return menu.hint ? [fitAnsi(style.gray("  " + sanitize(menu.hint)), width)] : [];
    }
    const n = menu.items.length;
    this.sel = Math.min(this.sel, n - 1);
    const start = Math.max(0, Math.min(this.sel - Math.floor(MENU_ROWS / 2), n - MENU_ROWS));
    const shown = menu.items.slice(start, start + MENU_ROWS);
    const labelW = Math.min(24, Math.max(...shown.map((i) => i.label.length)) + 2);
    const lines = shown.map((item, i) => {
      const selected = start + i === this.sel;
      const label = sanitize(item.label).padEnd(labelW);
      const desc = item.desc ? sanitize(item.desc) : "";
      const line = selected
        ? style.magenta("› ") + style.bold(style.cyan(label)) + desc
        : "  " + style.cyan(label) + style.gray(desc);
      return fitAnsi(line, width);
    });
    const keys = "↑↓ select · Tab complete · Enter run · Esc hide";
    lines.push(style.gray(fitAnsi(n > MENU_ROWS ? `  ${this.sel + 1}/${n} · ${keys}` : `  ${keys}`, width)));
    return lines;
  }
}
