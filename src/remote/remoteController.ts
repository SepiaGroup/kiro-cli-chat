// Remote access inside VS Code: starts and stops the local server, shows the
// pairing link, lists and removes paired devices, and keeps the status bar
// item. The server and its rules are in the pure modules next to this file.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChatViewProvider } from "../chatViewProvider";
import { assetType } from "./assets";
import { DeviceRecord, DeviceStore, PairingCode } from "./remoteAuth";
import { parsePermissions } from "./remotePolicy";
import { RemoteAsset, RemoteServer } from "./remoteServer";
import { errorMessage } from "../format";

const DEVICES_KEY = "kiroCliChat.remoteDevices";

export class RemoteController implements vscode.Disposable {
  private server?: RemoteServer;
  private port = 0;
  private pairing = new PairingCode();
  private devices = new DeviceStore();
  private readonly status: vscode.StatusBarItem;
  private chatSub?: vscode.Disposable;
  private starting?: Promise<void>;
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when remote access starts or stops. */
  readonly onDidChange = this.stateChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly provider: ChatViewProvider
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.status.command = "kiroCliChat.remoteMenu";
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  private log(line: string): void {
    this.output.appendLine(`[remote] ${line}`);
  }

  private settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("kiroCliChat.remote");
  }

  /** The address devices open. Replaced by the Tailscale name once that is wired in. */
  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start unless it already runs. `showLink` also offers the pairing link. */
  async start(showLink = true): Promise<void> {
    if (this.server) {
      if (showLink) {
        await this.showLink();
      }
      return;
    }
    this.starting ??= this.startServer().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    if (this.server && showLink) {
      await this.showLink();
    }
  }

  private async startServer(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "Remote access is off in an untrusted workspace. Trust the workspace first, then run \"Kiro CLI Chat: Start Remote Access\"."
      );
      return;
    }
    this.devices = new DeviceStore(await this.loadDevices());
    this.devices.onChange = () => void this.saveDevices();
    this.pairing = new PairingCode();
    const server = new RemoteServer({
      chats: () => this.provider.chats(),
      devices: this.devices,
      pairing: this.pairing,
      permissions: () => parsePermissions(this.settings().get("permissions")),
      assets: (name) => this.readAsset(name),
      onPaired: (d) => void vscode.window.showInformationMessage(`Remote access: ${d.name} is paired.`),
      onClients: () => this.updateStatus(),
      log: (line) => this.log(line),
    });
    try {
      this.port = await server.start(this.settings().get<number>("port", 0));
    } catch (err) {
      this.log(`could not start: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not start remote access: ${errorMessage(err)}`);
      return;
    }
    this.server = server;
    this.chatSub = this.provider.onDidChangeChats(() => server.chatsChanged());
    this.log(`listening on 127.0.0.1:${this.port}`);
    this.updateStatus();
    this.stateChanged.fire();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    this.chatSub?.dispose();
    this.chatSub = undefined;
    this.pairing.revoke();
    await server.stop();
    this.status.hide();
    this.stateChanged.fire();
    this.log("stopped");
    void vscode.window.showInformationMessage("Remote access is off. Paired devices stay paired for next time.");
  }

  /** A new one-use pairing link, offered to copy or open. */
  async showLink(): Promise<void> {
    if (!this.server) {
      return this.start(true);
    }
    const link = `${this.baseUrl()}/#k=${this.pairing.issue()}`;
    const choice = await vscode.window.showInformationMessage(
      "Remote access is on. Open the pairing link on the device you want to use. It works once, for 10 minutes.",
      "Copy Link",
      "Open in Browser"
    );
    if (choice === "Copy Link") {
      await vscode.env.clipboard.writeText(link);
    } else if (choice === "Open in Browser") {
      await vscode.env.openExternal(vscode.Uri.parse(link));
    }
  }

  /** Pick a paired device to remove (or all of them). */
  async removeDevice(): Promise<void> {
    const list = this.server ? this.devices.list() : new DeviceStore(await this.loadDevices()).list();
    if (list.length === 0) {
      void vscode.window.showInformationMessage("No remote devices are paired.");
      return;
    }
    const items: Array<vscode.QuickPickItem & { device?: DeviceRecord }> = list.map((d) => ({
      label: d.name,
      description: `last used ${new Date(d.lastSeen).toLocaleString()}`,
      device: d,
    }));
    items.push({ label: "Remove all devices", description: `${list.length} paired` });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Remove which device?" });
    if (!picked) {
      return;
    }
    const remove = picked.device ? [picked.device] : list;
    if (this.server) {
      for (const d of remove) {
        this.devices.remove(d.id);
        this.server.disconnectDevice(d.id);
      }
    } else {
      const store = new DeviceStore(list);
      store.onChange = () => void this.saveDevices(store);
      remove.forEach((d) => store.remove(d.id));
    }
    this.log(`removed ${remove.length} device(s)`);
    void vscode.window.showInformationMessage(remove.length === 1 ? `Removed ${remove[0].name}.` : `Removed ${remove.length} devices.`);
  }

  /** The status bar item's menu. */
  async menu(): Promise<void> {
    if (!this.server) {
      return this.start(true);
    }
    const picked = await vscode.window.showQuickPick(
      ["Show pairing link", "Remove a device…", "Stop remote access"].map((label) => ({ label })),
      { placeHolder: "Remote access" }
    );
    if (picked?.label === "Show pairing link") {
      await this.showLink();
    } else if (picked?.label === "Remove a device…") {
      await this.removeDevice();
    } else if (picked?.label === "Stop remote access") {
      await this.stop();
    }
  }

  /** At start-up, when the user asked for remote access to start by itself. */
  async startIfWanted(): Promise<void> {
    if (this.settings().get<boolean>("autoStart", false)) {
      await this.start(false);
    }
  }

  dispose(): void {
    this.chatSub?.dispose();
    void this.server?.stop();
    this.server = undefined;
    this.status.dispose();
    this.stateChanged.dispose();
  }

  // --- helpers ---

  private updateStatus(): void {
    const n = this.server?.connectedDevices.length ?? 0;
    this.status.text = n > 0 ? `$(broadcast) Remote: ${n} connected` : "$(broadcast) Remote";
    this.status.tooltip = "Kiro CLI Chat remote access is on. Click for the pairing link, devices and Stop.";
    this.status.show();
  }

  private readAsset(name: string): RemoteAsset | undefined {
    const type = assetType(name);
    if (!type) {
      return undefined;
    }
    try {
      const file = path.join(this.context.extensionUri.fsPath, "media", name);
      return { body: fs.readFileSync(file), type };
    } catch {
      return undefined;
    }
  }

  private async loadDevices(): Promise<DeviceRecord[]> {
    try {
      const raw = await this.context.secrets.get(DEVICES_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as DeviceRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async saveDevices(store: DeviceStore = this.devices): Promise<void> {
    try {
      await this.context.secrets.store(DEVICES_KEY, JSON.stringify(store.list()));
    } catch (err) {
      this.log(`could not save devices: ${errorMessage(err)}`);
    }
  }
}
