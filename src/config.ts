// VS Code configuration and editor state. Imports vscode (extension-host only).

import * as vscode from "vscode";
import { EditorSnapshot, pickEditorContext } from "./editorContext";
import { EngineSetting, InteractionMode } from "./types";

export interface RawConfig {
  cliPath: string;
  engine: EngineSetting;
  model: string;
  interactionMode: InteractionMode;
  autopilot: boolean;
  enterToSend: boolean;
  shareEditorContext: boolean;
}

export function readConfig(): RawConfig {
  const c = vscode.workspace.getConfiguration("kiroCliChat");
  return {
    cliPath: c.get<string>("kiroCliPath", ""),
    engine: c.get<EngineSetting>("defaultEngine", "auto"),
    model: c.get<string>("defaultModel", "auto"),
    interactionMode: c.get<InteractionMode>("interactionMode", "persistent"),
    autopilot: c.get<boolean>("autopilot", false),
    enterToSend: c.get<boolean>("enterToSend", true),
    shareEditorContext: c.get<boolean>("shareEditorContext", false),
  };
}

let lastActiveFile: string | undefined;

/** Remember the last text editor that was active (a chat tab itself is not one). */
export function trackActiveEditor(context: vscode.ExtensionContext): void {
  const take = (e: vscode.TextEditor | undefined): void => {
    if (e?.document.uri.scheme === "file") {
      lastActiveFile = e.document.uri.fsPath;
    }
  };
  take(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(take));
}

function editorSnapshot(): EditorSnapshot {
  const open = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .flatMap((t) => (t.input instanceof vscode.TabInputText && t.input.uri.scheme === "file" ? [t.input.uri.fsPath] : []));
  return { active: lastActiveFile && open.includes(lastActiveFile) ? lastActiveFile : undefined, open };
}

/** What to tell the engine about the editor for a chat in `cwd`; empty while the setting is off. */
export function editorContextFor(cwd: string): () => EditorSnapshot {
  return () => (readConfig().shareEditorContext ? pickEditorContext(editorSnapshot(), cwd) : { open: [] });
}
