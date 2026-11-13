// The HTTP server behind remote access. It listens on the loopback address
// only (Tailscale or another tunnel carries traffic to it), serves the chat
// page, pairs devices, streams a chat's messages (Server-Sent Events) and
// takes a device's messages after the policy has checked them.
// Pure (no vscode import): chats come in through the RemoteChat interface.

import * as http from "http";
import { AddressInfo } from "net";
import {
  clearedCookie,
  cleanDeviceName,
  COOKIE_NAME,
  deviceCookie,
  DeviceRecord,
  DeviceStore,
  deviceNameFromUserAgent,
  PairingCode,
  parseCookies,
  RateLimiter,
} from "./remoteAuth";
import { EventLog } from "./eventLog";
import { checkRemoteMessage, Permission, RemoteMessage } from "./remotePolicy";
import { remotePageHtml, SECURITY_HEADERS } from "./remotePage";

/** What the server needs from a chat (ChatSession implements it). */
export interface RemoteChat {
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  /** The chat so far, as messages for a page that has none yet. */
  snapshot(): unknown[];
  /** A message from a remote device that passed the policy. */
  send(msg: RemoteMessage, device: { id: string; name: string }): Promise<void>;
  /** Live messages, in order. Returns the way to stop. */
  subscribe(listener: (msg: unknown) => void): () => void;
}

export interface RemoteAsset {
  body: string | Buffer;
  type: string;
}

export interface RemoteServerOptions {
  chats(): readonly RemoteChat[];
  devices: DeviceStore;
  pairing: PairingCode;
  /** What devices may do right now (read per request, so a setting change applies at once). */
  permissions(): readonly Permission[];
  /** Files under /static/ (script, styles, manifest, icon); undefined = not found. */
  assets(name: string): RemoteAsset | undefined;
  /** Cookies get `Secure` unless the request came straight to loopback over plain HTTP (a proxy in front means HTTPS). */
  secureCookies?(host: string | undefined): boolean;
  /** Host names the server answers to besides loopback (e.g. the tailnet name). */
  allowedHosts?(): readonly string[];
  /** A device just paired. */
  onPaired?(device: DeviceRecord): void;
  /** A device opened or closed a stream (count changed). */
  onClients?(): void;
  log?(line: string): void;
  /** Messages kept per chat for catching up. */
  logSize?: number;
  heartbeatMs?: number;
  now?: () => number;
}

interface Client {
  res: http.ServerResponse;
  device: string;
  timer: NodeJS.Timeout;
}

interface Feed {
  chat: RemoteChat;
  log: EventLog;
  clients: Set<Client>;
  unsubscribe(): void;
}

/** A prompt with a few photos as base64 in JSON. Smaller than the chat's own limits (10 images of 10 MB): this comes over the network. */
const MAX_BODY = 32 * 1024 * 1024;
const MAX_SMALL_BODY = 4 * 1024;
const MAX_STREAMS_PER_DEVICE = 8;
/** A browser that cannot keep up is dropped; it reconnects and catches up. */
const MAX_BUFFERED = 4 * 1024 * 1024;

export class RemoteServer {
  private server?: http.Server;
  private readonly feeds = new Map<string, Feed>();
  private readonly listClients = new Set<Client>();
  private readonly pairLimiter: RateLimiter;

  constructor(private readonly opts: RemoteServerOptions) {
    this.pairLimiter = new RateLimiter(10, 60_000, opts.now);
  }

  /** Start on a loopback address. Port 0 picks a free one; returns the port. */
  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Remote access only listens on the loopback address.");
    }
    if (this.server) {
      throw new Error("Remote access is already running.");
    }
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 0; // streams stay open; bodies are limited by size instead
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const feed of this.feeds.values()) {
      feed.unsubscribe();
      for (const c of feed.clients) {
        this.endClient(c);
      }
    }
    this.feeds.clear();
    for (const c of this.listClients) {
      this.endClient(c);
    }
    this.listClients.clear();
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Number of open streams (a device with the chat open counts once per chat). */
  get streamCount(): number {
    let n = this.listClients.size;
    for (const f of this.feeds.values()) {
      n += f.clients.size;
    }
    return n;
  }

  /** Devices with at least one open stream. */
  get connectedDevices(): string[] {
    const ids = new Set<string>();
    for (const f of this.feeds.values()) {
      f.clients.forEach((c) => ids.add(c.device));
    }
    this.listClients.forEach((c) => ids.add(c.device));
    return [...ids];
  }

  /** The set of chats or a title changed: tell lists, and drop streams of chats that are gone. */
  chatsChanged(): void {
    const live = new Set(this.opts.chats().map((c) => c.id));
    for (const [id, feed] of [...this.feeds]) {
      if (!live.has(id)) {
        feed.unsubscribe();
        for (const c of feed.clients) {
          this.sse(c, "gone", "{}");
          this.endClient(c);
        }
        this.feeds.delete(id);
      }
    }
    const list = JSON.stringify(this.chatList());
    for (const c of this.listClients) {
      this.sse(c, "chats", list);
    }
  }

  /** A device was removed: close its streams. Its cookie stops working with the store entry. */
  disconnectDevice(id: string): void {
    for (const feed of this.feeds.values()) {
      for (const c of [...feed.clients]) {
        if (c.device === id) {
          this.endClient(c);
        }
      }
    }
    for (const c of [...this.listClients]) {
      if (c.device === id) {
        this.endClient(c);
      }
    }
  }

  // --- requests ---

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
      }
      if (!this.hostAllowed(req.headers.host)) {
        return this.fail(res, 421, "unknown host");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(remotePageHtml());
        return;
      }
      if (method === "GET" && path.startsWith("/static/")) {
        return this.serveAsset(res, path.slice("/static/".length));
      }
      if (!path.startsWith("/api/")) {
        return this.fail(res, 404, "not found");
      }
      res.setHeader("Cache-Control", "no-store");
      if (!this.sameOrigin(req)) {
        return this.fail(res, 403, "cross-site request");
      }
      if (method === "POST" && path === "/api/pair") {
        return await this.pair(req, res);
      }

      const device = this.opts.devices.authenticate(parseCookies(req.headers.cookie)[COOKIE_NAME]);
      if (!device) {
        return this.fail(res, 401, "not paired");
      }
      const granted = this.opts.permissions();

      if (method === "GET" && path === "/api/me") {
        return this.json(res, 200, { device: { id: device.id, name: device.name }, permissions: granted });
      }
      if (method === "POST" && path === "/api/logout") {
        this.opts.devices.remove(device.id);
        this.disconnectDevice(device.id);
        res.setHeader("Set-Cookie", clearedCookie(this.secure(req)));
        return this.json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/chats") {
        if (!granted.includes("view")) {
          return this.fail(res, 403, "this device may not view chats");
        }
        return this.json(res, 200, this.chatList());
      }
      if (method === "GET" && path === "/api/chats/events") {
        if (!granted.includes("view")) {
          return this.fail(res, 403, "this device may not view chats");
        }
        return this.openListStream(req, res, device);
      }
      const m = /^\/api\/chats\/([^/]+)\/(events|message)$/.exec(path);
      if (m) {
        const chat = this.opts.chats().find((c) => c.id === decodeURIComponent(m[1]));
        if (!chat) {
          return this.fail(res, 404, "no such chat");
        }
        if (method === "GET" && m[2] === "events") {
          if (!granted.includes("view")) {
            return this.fail(res, 403, "this device may not view chats");
          }
          return this.openChatStream(req, res, device, chat, url.searchParams.get("last") ?? undefined);
        }
        if (method === "POST" && m[2] === "message") {
          return await this.message(req, res, device, chat, granted);
        }
      }
      return this.fail(res, method === "GET" || method === "POST" ? 404 : 405, "not found");
    } catch (err) {
      this.opts.log?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        this.fail(res, 500, "server error");
      } else {
        res.end();
      }
    }
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.pairLimiter.allow("pair")) {
      return this.fail(res, 429, "too many attempts, wait a minute");
    }
    const body = await this.readJson(req, res, MAX_SMALL_BODY);
    if (body === undefined) {
      return;
    }
    const b = body as { secret?: unknown; name?: unknown };
    if (!this.opts.pairing.redeem(b.secret)) {
      this.opts.log?.("pairing refused: wrong or expired code");
      return this.fail(res, 401, "this pairing link is not valid any more");
    }
    const name = cleanDeviceName(b.name) || deviceNameFromUserAgent(req.headers["user-agent"]);
    const { device, token } = this.opts.devices.add(name);
    res.setHeader("Set-Cookie", deviceCookie(token, this.secure(req)));
    this.opts.log?.(`paired device ${device.id} (${device.name})`);
    this.opts.onPaired?.(device);
    this.json(res, 200, { device: { id: device.id, name: device.name } });
  }

  private async message(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    chat: RemoteChat,
    granted: readonly Permission[]
  ): Promise<void> {
    const body = await this.readJson(req, res, MAX_BODY);
    if (body === undefined) {
      return;
    }
    const checked = checkRemoteMessage(body, granted);
    if (!checked.ok) {
      const type = (body as { type?: unknown } | null)?.type;
      this.opts.log?.(`refused ${typeof type === "string" ? type.slice(0, 40) : "?"} from ${device.id}: ${checked.reason}`);
      return this.fail(res, checked.status, checked.reason);
    }
    try {
      await chat.send(checked.msg, { id: device.id, name: device.name });
    } catch (err) {
      this.opts.log?.(`message from ${device.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.fail(res, 500, "the chat could not take that");
    }
    res.writeHead(204);
    res.end();
  }

  // --- streams ---

  private feedFor(chat: RemoteChat): Feed {
    let feed = this.feeds.get(chat.id);
    if (!feed) {
      const created: Feed = {
        chat,
        log: new EventLog(this.opts.logSize ?? 2000),
        clients: new Set(),
        unsubscribe: () => undefined,
      };
      created.unsubscribe = chat.subscribe((msg) => {
        const seq = created.log.push(msg);
        const data = JSON.stringify(msg);
        for (const c of created.clients) {
          this.sse(c, undefined, data, created.log.idOf(seq));
        }
      });
      this.feeds.set(chat.id, created);
      feed = created;
    }
    return feed;
  }

  private openChatStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    chat: RemoteChat,
    lastFromQuery: string | undefined
  ): void {
    if (this.streamsOf(device.id) >= MAX_STREAMS_PER_DEVICE) {
      return this.fail(res, 429, "too many open chats on this device");
    }
    const feed = this.feedFor(chat);
    const client = this.startStream(req, res, device, feed.clients);
    const header = req.headers["last-event-id"];
    const last = feed.log.parseId(typeof header === "string" ? header : lastFromQuery);
    const missed = last === undefined ? undefined : feed.log.after(last);
    if (missed) {
      for (const e of missed) {
        this.sse(client, undefined, JSON.stringify(e.msg), feed.log.idOf(e.seq));
      }
    } else {
      // Tells a page that already shows this chat to clear it before the snapshot arrives.
      this.sse(client, "snapshot", "{}");
      for (const msg of chat.snapshot()) {
        this.sse(client, undefined, JSON.stringify(msg));
      }
      // The snapshot is as of now: this id is where live messages continue.
      this.sse(client, "sync", "{}", feed.log.idOf(feed.log.lastSeq));
    }
    this.opts.onClients?.();
  }

  private openListStream(req: http.IncomingMessage, res: http.ServerResponse, device: DeviceRecord): void {
    if (this.streamsOf(device.id) >= MAX_STREAMS_PER_DEVICE) {
      return this.fail(res, 429, "too many open streams on this device");
    }
    const client = this.startStream(req, res, device, this.listClients);
    this.sse(client, "chats", JSON.stringify(this.chatList()));
    this.opts.onClients?.();
  }

  private startStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    into: Set<Client>
  ): Client {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const timer = setInterval(() => res.write(": ping\n\n"), this.opts.heartbeatMs ?? 15_000);
    timer.unref();
    const client: Client = { res, device: device.id, timer };
    into.add(client);
    req.on("close", () => {
      clearInterval(timer);
      into.delete(client);
      this.opts.onClients?.();
    });
    return client;
  }

  private streamsOf(device: string): number {
    let n = 0;
    for (const f of this.feeds.values()) {
      f.clients.forEach((c) => c.device === device && n++);
    }
    this.listClients.forEach((c) => c.device === device && n++);
    return n;
  }

  private sse(c: Client, event: string | undefined, data: string, id?: string): void {
    if (c.res.writableEnded || c.res.destroyed) {
      return;
    }
    c.res.write(`${id ? `id: ${id}\n` : ""}${event ? `event: ${event}\n` : ""}data: ${data}\n\n`);
    if (c.res.writableLength > MAX_BUFFERED) {
      this.opts.log?.(`dropping a slow stream of ${c.device}`);
      this.endClient(c);
    }
  }

  private endClient(c: Client): void {
    clearInterval(c.timer);
    if (!c.res.writableEnded) {
      c.res.end();
    }
  }

  // --- helpers ---

  private chatList(): Array<{ id: string; title: string; busy: boolean }> {
    return this.opts.chats().map((c) => ({ id: c.id, title: c.title, busy: c.busy }));
  }

  private serveAsset(res: http.ServerResponse, name: string): void {
    const asset = /^[A-Za-z0-9._-]+$/.test(name) ? this.opts.assets(name) : undefined;
    if (!asset) {
      return this.fail(res, 404, "not found");
    }
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
    res.end(asset.body);
  }

  private secure(req: http.IncomingMessage): boolean {
    return this.opts.secureCookies ? this.opts.secureCookies(req.headers.host) : !isLoopbackHost(req.headers.host);
  }

  private hostAllowed(host: string | undefined): boolean {
    const allowed = this.opts.allowedHosts?.();
    if (!allowed) {
      return true;
    }
    const name = hostName(host);
    return isLoopbackName(name) || allowed.some((h) => h.toLowerCase() === name);
  }

  /** Same-origin only: a page on another site must not be able to use a paired browser's cookie. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      return false;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** The JSON body, or undefined after an error response was sent. */
  private readJson(req: http.IncomingMessage, res: http.ServerResponse, max: number): Promise<unknown> {
    return new Promise((resolve) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        this.fail(res, 415, "send JSON");
        resolve(undefined);
        return;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > max) {
        res.setHeader("Connection", "close");
        this.fail(res, 413, "too large");
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) {
          return;
        }
        size += chunk.length;
        if (size > max) {
          done = true;
          res.setHeader("Connection", "close"); // the rest of the body is not read
          this.fail(res, 413, "too large");
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) {
          return;
        }
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          this.fail(res, 400, "not valid JSON");
          resolve(undefined);
        }
      });
      req.on("error", () => {
        if (!done) {
          done = true;
          resolve(undefined);
        }
      });
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, status: number, error: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    this.json(res, status, { error });
  }
}

function hostName(host: string | undefined): string {
  return (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackName(name: string): boolean {
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/** Whether a Host header names this machine itself (no proxy in between). */
export function isLoopbackHost(host: string | undefined): boolean {
  return isLoopbackName(hostName(host));
}
