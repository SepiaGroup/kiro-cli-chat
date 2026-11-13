// The "/" command picker above the input, and the argument hint shown after
// choosing a command. Browser context.

import { autoGrow, byId, div, inputEl } from "./ui";

export interface CommandLike {
  name: string;
  description?: string;
  inputHint?: string;
  type?: string;
}

const pickerEl = byId("cmd-picker");
const hintEl = byId("cmd-hint");

// Built-in commands always offered (engine may add agents/skills on top).
const BUILTIN_COMMANDS: CommandLike[] = [
  { name: "model", description: "Switch the model", inputHint: "model name", type: "builtin" },
  { name: "agent", description: "Switch the active agent", inputHint: "agent name", type: "builtin" },
  { name: "compact", description: "Compact the conversation to save context", type: "builtin" },
  { name: "clear", description: "Clear the conversation", type: "builtin" },
  { name: "help", description: "Show available commands", type: "builtin" },
];

let allCommands: CommandLike[] = [...BUILTIN_COMMANDS];
let pickerMatches: CommandLike[] = [];
let pickerIndex = 0;

export function setCommands(cmds: CommandLike[]): void {
  // Merge engine-provided commands with built-ins, de-duplicating by name.
  const byName = new Map<string, CommandLike>();
  for (const c of BUILTIN_COMMANDS) {
    byName.set(c.name, c);
  }
  for (const c of cmds) {
    if (c && c.name) {
      byName.set(c.name, c);
    }
  }
  allCommands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The leading "/token" at the start of the input, or null. */
function slashQuery(): string | null {
  const v = inputEl.value;
  // Only trigger when the slash is the very first character and there is no
  // space yet (i.e. still typing the command name, not its arguments).
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(v);
  return m ? m[1] : null;
}

export function updatePicker(): void {
  const q = slashQuery();
  if (q === null) {
    hidePicker();
    return;
  }
  const ql = q.toLowerCase();
  pickerMatches = allCommands.filter((c) => c.name.toLowerCase().includes(ql));
  if (pickerMatches.length === 0) {
    hidePicker();
    return;
  }
  pickerIndex = 0;
  renderPicker();
}

function renderPicker(): void {
  pickerEl.innerHTML = "";
  pickerMatches.forEach((c, i) => {
    const item = div("cmd-item" + (i === pickerIndex ? " active" : ""));
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", i === pickerIndex ? "true" : "false");
    const name = div("cmd-name");
    name.textContent = "/" + c.name;
    item.appendChild(name);
    if (c.type && c.type !== "builtin") {
      const tag = div("cmd-tag");
      tag.textContent = c.type;
      item.appendChild(tag);
    }
    if (c.description) {
      const desc = div("cmd-desc");
      desc.textContent = c.description;
      item.appendChild(desc);
    }
    item.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the textarea blur.
      e.preventDefault();
      chooseCommand(c);
    });
    pickerEl.appendChild(item);
  });
  pickerEl.classList.remove("hidden");
}

export function hidePicker(): void {
  pickerEl.classList.add("hidden");
  pickerEl.innerHTML = "";
  pickerMatches = [];
}

function pickerOpen(): boolean {
  return !pickerEl.classList.contains("hidden") && pickerMatches.length > 0;
}

/** Returns true if the picker consumed the key event. */
export function handlePickerKeydown(e: KeyboardEvent): boolean {
  if (!pickerOpen()) {
    return false;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      pickerIndex = (pickerIndex + 1) % pickerMatches.length;
      renderPicker();
      return true;
    case "ArrowUp":
      e.preventDefault();
      pickerIndex =
        (pickerIndex - 1 + pickerMatches.length) % pickerMatches.length;
      renderPicker();
      return true;
    case "Enter":
    case "Tab":
      e.preventDefault();
      chooseCommand(pickerMatches[pickerIndex]);
      return true;
    case "Escape":
      e.preventDefault();
      hidePicker();
      return true;
    default:
      return false;
  }
}

/** Insert the chosen command into the input (does not send). */
function chooseCommand(c: CommandLike): void {
  // Insert "/name " so the user can append arguments, then press Enter.
  inputEl.value = "/" + c.name + " ";
  const pos = inputEl.value.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  hidePicker();
  autoGrow();
  // If the command expects an argument, show its hint as a ghost label.
  if (c.inputHint) {
    showHint(c.inputHint);
  } else {
    hideHint();
  }
}

function showHint(text: string): void {
  hintEl.textContent = "argument: " + text;
  hintEl.classList.remove("hidden");
}

export function hideHint(): void {
  hintEl.classList.add("hidden");
  hintEl.textContent = "";
}

/** Hide the hint once the user has typed an argument or cleared the command. */
export function updateHint(): void {
  if (hintEl.classList.contains("hidden")) {
    return;
  }
  const v = inputEl.value;
  const m = /^\/([a-zA-Z0-9_-]+)\s(.*)$/.exec(v);
  // Keep the hint only while the line is "/cmd " with no argument typed yet.
  if (!m || m[2].trim().length > 0) {
    hideHint();
  }
}
