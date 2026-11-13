// The ⚙ Settings panel and the toolbar's model and mode dropdowns, filled
// from the engine's config options. Browser context.

import { byId, hidePanels, registerPanel, vscode } from "./ui";

interface ConfigChoiceLike {
  value: string;
  name: string;
  description?: string;
}
export interface ConfigOptionLike {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: unknown;
  options?: ConfigChoiceLike[];
}

const settingsEl = byId("settings");
const modeSel = byId("sel-mode") as HTMLSelectElement;
const modelSel = byId("sel-model") as HTMLSelectElement;
const autopilotChk = byId("chk-autopilot") as HTMLInputElement;
const effortRow = byId("effort-row");
const effortSel = byId("sel-effort") as HTMLSelectElement;
const memorySel = byId("sel-memory") as HTMLSelectElement;
const contentSel = byId("sel-content") as HTMLSelectElement;

export function hideSettingsPanel(): void {
  settingsEl.classList.add("hidden");
}

/** The engine's autopilot setting, as the checkbox shows it. */
export function setAutopilotChecked(on: boolean): void {
  autopilotChk.checked = on;
}

export function initSettingsPanel(): void {
  registerPanel(hideSettingsPanel);
  const button = byId("btn-settings");
  button.addEventListener("click", () => {
    const willOpen = settingsEl.classList.contains("hidden");
    hidePanels();
    settingsEl.classList.toggle("hidden", !willOpen);
  });
  byId("settings-close").addEventListener("click", () => hideSettingsPanel());
  // Clicking anywhere outside the open panel (or its toolbar button) closes it.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node | null;
    if (t && !settingsEl.classList.contains("hidden") && !settingsEl.contains(t) && !button.contains(t)) {
      hideSettingsPanel();
    }
  });

  modeSel.addEventListener("change", () => {
    vscode.postMessage({ type: "setMode", modeId: modeSel.value });
  });

  modelSel.addEventListener("change", () => {
    vscode.postMessage({ type: "setConfig", id: "model", value: modelSel.value });
    modelSel.title = "Model: " + (modelSel.selectedOptions[0]?.textContent ?? "");
  });

  effortSel.addEventListener("change", () => {
    vscode.postMessage({ type: "setConfig", id: "effortLevel", value: effortSel.value });
  });

  memorySel.addEventListener("change", () => {
    vscode.postMessage({ type: "setConfig", id: "memoryReflection", value: memorySel.value });
  });

  contentSel.addEventListener("change", () => {
    vscode.postMessage({ type: "setConfig", id: "contentCollection", value: contentSel.value });
  });

  autopilotChk.addEventListener("change", () => {
    // Autopilot is a real engine option ("on"/"off").
    vscode.postMessage({
      type: "setConfig",
      id: "autopilot",
      value: autopilotChk.checked ? "on" : "off",
    });
  });
}

function fillSelect(sel: HTMLSelectElement, opt: ConfigOptionLike): void {
  const current = String(opt.currentValue ?? "");
  sel.innerHTML = "";
  for (const choice of opt.options ?? []) {
    const o = document.createElement("option");
    o.value = choice.value;
    o.textContent = choice.name || choice.value;
    if (choice.value === current) {
      o.selected = true;
    }
    sel.appendChild(o);
  }
}

export function updateSettings(options: ConfigOptionLike[]): void {
  let sawEffort = false;
  let sawModel = false;
  for (const opt of options) {
    switch (opt.id) {
      case "mode":
        fillSelect(modeSel, opt);
        modeSel.disabled = false;
        break;
      case "model":
        sawModel = true;
        fillSelect(modelSel, opt);
        modelSel.disabled = false;
        modelSel.title = "Model: " + (modelSel.selectedOptions[0]?.textContent ?? "");
        break;
      case "effortLevel":
        sawEffort = true;
        fillSelect(effortSel, opt);
        effortRow.classList.remove("hidden");
        break;
      case "autopilot":
        autopilotChk.checked = String(opt.currentValue ?? "") === "on";
        break;
      case "memoryReflection":
        fillSelect(memorySel, opt);
        break;
      case "contentCollection":
        fillSelect(contentSel, opt);
        break;
      default:
        break;
    }
  }
  // Only re-evaluate effort visibility on updates that include the model (i.e.
  // full/model-changing updates), so a partial update doesn't wrongly hide it.
  if (sawModel && !sawEffort) {
    effortRow.classList.add("hidden");
  }
}
