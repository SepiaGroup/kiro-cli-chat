// VSCode configuration reader. Imports vscode (extension-host only).

import * as vscode from "vscode";
import { EngineSetting, InteractionMode } from "./types";

export interface RawConfig {
  cliPath: string;
  engine: EngineSetting;
  model: string;
  interactionMode: InteractionMode;
  autopilot: boolean;
  enterToSend: boolean;
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
  };
}
