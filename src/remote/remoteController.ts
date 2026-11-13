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
import { DEFAULT_HTTPS_PORT, HTTPS_PORTS, nodeRun, TailscaleServe } from "./tailscale";
import { errorMessage } from "../format";

const DEVICES_KEY = "kiroCliChat.remoteDevices";
const PORT_KEY = "kiroCliChat.remotePort";

export class RemoteController implements vscode.Disposable {
  private server?: RemoteServer;
  private port = 0;
  private pairing = new PairingCode();
  private devices = new DeviceStore();
  private readonly status: vscode.StatusBarItem;
  private chatSub?: vscode.Disposable;
  private starting?: Promise<void>;
  private readonly tailscale: TailscaleServe;
  /** The tailnet address devices open, once Tailscale shares the port. */
  private publicUrl?: string;
  /** Why Tailscale could not share it (shown with the link), and where to fix that. */
  private problem?: { advice: string; enableUrl?: string };
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when remote access starts or stops. */
  readonly onDidChange = this.stateChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly provider: ChatViewProvider
  ) {
    this.tailscale = new TailscaleServe(nodeRun, (line) => this.log(line));
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

  /** The address devices open: the tailnet name when Tailscale shares the port, else this Mac only. */
  private baseUrl(): string {
    return this.publicUrl ?? `http://127.0.0.1:${this.port}`;
  }

  /** Put the local port on the tailnet. Sets `publicUrl`, or `problem` with what to do. */
  private async shareOnTailnet(): Promise<void> {
    const wanted = this.settings().get<number>("httpsPort", DEFAULT_HTTPS_PORT);
    const httpsPort = HTTPS_PORTS.includes(wanted) ? wanted : DEFAULT_HTTPS_PORT;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Kiro CLI Chat: sharing remote access on your tailnet…" },
      () => this.tailscale.expose(this.port, httpsPort)
    );
    if (result.ok) {
      this.publicUrl = result.url;
      this.problem = undefined;
      this.log(`shared on the tailnet as ${new URL(result.url).host}`);
    } else {
      this.publicUrl = undefined;
      this.problem = { advice: result.advice, enableUrl: result.enableUrl };
      this.log(`tailscale: ${result.advice}`);
    }
    this.updateStatus();
  }

  /** Start unless it already runs. `showLink` also offers the pairing link. */
  async start(showLink = true): Promise<void> {
    if (this.server) {
      if (!this.publicUrl) {
        await this.shareOnTailnet(); // the user may have fixed what was wrong
      }
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
      // Only this Mac and the tailnet name may be the Host: no other name reaches the page.
      allowedHosts: () => (this.publicUrl ? [new URL(this.publicUrl).hostname] : []),
      log: (line) => this.log(line),
    });
    try {
      // The same port as last time when it is free, so a bookmark or an open page
      // still finds the server after a restart.
      const wanted = this.settings().get<number>("port", 0) || this.context.globalState.get<number>(PORT_KEY, 0);
      try {
        this.port = await server.start(wanted);
      } catch (err) {
        if (!wanted || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw err;
        }
        this.log(`port ${wanted} is busy; picking another`);
        this.port = await server.start(0);
      }
      void this.context.globalState.update(PORT_KEY, this.port);
    } catch (err) {
      this.log(`could not start: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not start remote access: ${errorMessage(err)}`);
      return;
    }
    this.server = server;
    this.chatSub = this.provider.onDidChangeChats(() => server.chatsChanged());
    this.log(`listening on 127.0.0.1:${this.port}`);
    await this.shareOnTailnet();
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
    await this.tailscale.remove();
    this.publicUrl = undefined;
    this.problem = undefined;
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
    const setup = this.problem?.enableUrl ? ["Open Tailscale Setup"] : [];
    const text = this.publicUrl
      ? "Remote access is on. Open the pairing link on the device you want to use. It works once, for 10 minutes."
      : `Remote access is on for this Mac only. ${this.problem?.advice ?? ""} The link below works on this Mac.`;
    const choice = await vscode.window.showInformationMessage(text, "Copy Link", "Open in Browser", ...setup);
    if (choice === "Open Tailscale Setup" && this.problem?.enableUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(this.problem.enableUrl));
    } else if (choice === "Copy Link") {
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
    void this.tailscale.remove();
    void this.server?.stop();
    this.server = undefined;
    this.status.dispose();
    this.stateChanged.dispose();
  }

  // --- helpers ---

  private updateStatus(): void {
    const n = this.server?.connectedDevices.length ?? 0;
    this.status.text = n > 0 ? `$(broadcast) Remote: ${n} connected` : "$(broadcast) Remote";
    this.status.tooltip = this.publicUrl
      ? `Kiro CLI Chat remote access is on at ${this.publicUrl}. Click for the pairing link, devices and Stop.`
      : "Kiro CLI Chat remote access is on for this Mac only (Tailscale is not set up). Click for details, devices and Stop.";
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
