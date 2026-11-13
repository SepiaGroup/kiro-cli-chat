import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { COOKIE_NAME, DeviceStore, PairingCode } from "./remoteAuth";
import { Permission, RemoteMessage } from "./remotePolicy";
import { RemoteChat, RemoteServer } from "./remoteServer";

class FakeChat implements RemoteChat {
  busy = false;
  snapshotMsgs: unknown[] = [{ type: "userMessage", text: "earlier" }];
  sent: Array<{ msg: RemoteMessage; device: { id: string; name: string } }> = [];
  listeners = new Set<(msg: unknown) => void>();
  failSend = false;
  constructor(
    readonly id: string,
    public title = "Kiro Chat"
  ) {}
  snapshot(): unknown[] {
    return this.snapshotMsgs;
  }
  async send(msg: RemoteMessage, device: { id: string; name: string }): Promise<void> {
    if (this.failSend) {
      throw new Error("boom");
    }
    this.sent.push({ msg, device });
  }
  subscribe(listener: (msg: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(msg: unknown): void {
    this.listeners.forEach((l) => l(msg));
  }
}

interface Rig {
  port: number;
  server: RemoteServer;
  chats: FakeChat[];
  devices: DeviceStore;
  pairing: PairingCode;
  perms: { current: Permission[] };
  log: string[];
  paired: string[];
}

async function boot(extra: { logSize?: number; allowedHosts?: string[] } = {}): Promise<Rig> {
  const chats = [new FakeChat("c1", "First")];
  const devices = new DeviceStore();
  const pairing = new PairingCode();
  const perms = { current: ["view", "prompt", "approve"] as Permission[] };
  const log: string[] = [];
  const paired: string[] = [];
  const server = new RemoteServer({
    chats: () => chats,
    devices,
    pairing,
    permissions: () => perms.current,
    assets: (name) => (name === "webview.js" ? { body: "console.log(1)", type: "text/javascript" } : undefined),
    allowedHosts: extra.allowedHosts ? () => extra.allowedHosts as string[] : undefined,
    onPaired: (d) => paired.push(d.name),
    log: (l) => log.push(l),
    logSize: extra.logSize,
    heartbeatMs: 50,
  });
  const port = await server.start(0);
  return { port, server, chats, devices, pairing, perms, log, paired };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer; json?: unknown } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...opts.headers };
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["Content-Type"] = "application/json";
    }
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Pair a device and return its cookie header. */
async function pairDevice(rig: Rig, ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1"): Promise<string> {
  const secret = rig.pairing.issue();
  const r = await request(rig.port, "POST", "/api/pair", { json: { secret }, headers: { "User-Agent": ua } });
  assert.equal(r.status, 200, r.body);
  const cookie = String(r.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  return cookie;
}

interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

interface Stream {
  status: number;
  events: SseEvent[];
  snapshots: () => number;
  pings: () => number;
  ended: Promise<void>;
  close(): void;
}

function openStream(port: number, path: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      let pings = 0;
      let snapshots = 0;
      const events: SseEvent[] = [];
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        let i: number;
        while ((i = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const ev: SseEvent = { data: "" };
          if (block.startsWith(": ping")) {
            pings++;
          }
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) {
              ev.id = line.slice(4);
            } else if (line.startsWith("event: ")) {
              ev.event = line.slice(7);
            } else if (line.startsWith("data: ")) {
              ev.data += line.slice(6);
            }
          }
          if (ev.event === "snapshot") {
            snapshots++; // the marker before a snapshot; not a message
          } else if (ev.data || ev.event) {
            events.push(ev);
          }
        }
      });
      res.on("end", end);
      res.on("close", end);
      resolve({ status: res.statusCode ?? 0, events, snapshots: () => snapshots, pings: () => pings, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const json = (r: Res): Record<string, unknown> => JSON.parse(r.body);

test("the page and static files need no login; the API does", async () => {
  const rig = await boot();
  try {
    const page = await request(rig.port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(page.body, /connect-src 'self'/);
    assert.match(page.body, /\/static\/remoteShim\.js/);
    assert.doesNotMatch(page.body, /style="/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(page.headers["cache-control"], "no-store");

    const js = await request(rig.port, "GET", "/static/webview.js");
    assert.equal(js.status, 200);
    assert.equal(js.body, "console.log(1)");
    assert.equal((await request(rig.port, "GET", "/static/missing.js")).status, 404);
    assert.equal((await request(rig.port, "GET", "/static/..%2Fsecret")).status, 404);

    for (const path of ["/api/me", "/api/chats", "/api/chats/events", "/api/chats/c1/events"]) {
      assert.equal((await request(rig.port, "GET", path)).status, 401, path);
    }
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { json: { type: "ready" } })).status, 401);
    assert.equal((await request(rig.port, "GET", "/nowhere")).status, 404);
  } finally {
    await rig.server.stop();
  }
});

test("pairing: right code once, wrong code refused, cookie works, device is named", async () => {
  const rig = await boot();
  try {
    const bad = await request(rig.port, "POST", "/api/pair", { json: { secret: "nope" } });
    assert.equal(bad.status, 401);

    const secret = rig.pairing.issue();
    const ua = "Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36";
    // Through a proxy (the tailnet name): HTTPS, so the cookie is Secure.
    const ok = await request(rig.port, "POST", "/api/pair", { json: { secret }, headers: { "User-Agent": ua, Host: "mac.tail1.ts.net" } });
    assert.equal(ok.status, 200);
    assert.equal((json(ok).device as { name: string }).name, "Android, Chrome");
    const setCookie = String(ok.headers["set-cookie"]?.[0]);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict"]) {
      assert.ok(setCookie.includes(attr), attr);
    }
    assert.deepEqual(rig.paired, ["Android, Chrome"]);

    assert.equal((await request(rig.port, "POST", "/api/pair", { json: { secret } })).status, 401);

    const cookie = setCookie.split(";")[0];
    const me = await request(rig.port, "GET", "/api/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(json(me).permissions, ["view", "prompt", "approve"]);
    assert.equal((await request(rig.port, "GET", "/api/me", { headers: { Cookie: `${COOKIE_NAME}=forged` } })).status, 401);
    assert.equal(rig.log.some((l) => l.includes(secret)), false);
  } finally {
    await rig.server.stop();
  }
});

test("pairing attempts are rate limited", async () => {
  const rig = await boot();
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(rig.port, "POST", "/api/pair", { json: { secret: "guess" + i } })).status;
    }
    assert.equal(last, 429);
    // Even the right code is refused while limited.
    const secret = rig.pairing.issue();
    assert.equal((await request(rig.port, "POST", "/api/pair", { json: { secret } })).status, 429);
  } finally {
    await rig.server.stop();
  }
});

test("requests from another site are refused, even with the cookie", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const evil = { Cookie: cookie, Origin: "https://evil.example" };
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { json: { type: "cancelTurn" }, headers: evil })).status, 403);
    assert.equal((await request(rig.port, "GET", "/api/chats", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await request(rig.port, "POST", "/api/pair", { json: { secret: "x" }, headers: { Origin: "https://evil.example" } })).status, 403);
    const same = { Cookie: cookie, Origin: `http://127.0.0.1:${rig.port}`, "Sec-Fetch-Site": "same-origin" };
    assert.equal((await request(rig.port, "GET", "/api/chats", { headers: same })).status, 200);
    assert.equal(rig.chats[0].sent.length, 0);
  } finally {
    await rig.server.stop();
  }
});

test("a host that is not ours is refused when hosts are restricted", async () => {
  const rig = await boot({ allowedHosts: ["mac.tail1.ts.net"] });
  try {
    assert.equal((await request(rig.port, "GET", "/", { headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await request(rig.port, "GET", "/", { headers: { Host: "mac.tail1.ts.net" } })).status, 200);
    assert.equal((await request(rig.port, "GET", "/")).status, 200); // loopback
  } finally {
    await rig.server.stop();
  }
});

test("it only listens on the loopback address", async () => {
  const rig = await boot();
  try {
    await assert.rejects(new RemoteServer({ chats: () => [], devices: rig.devices, pairing: rig.pairing, permissions: () => [], assets: () => undefined }).start(0, "0.0.0.0"), /loopback/);
    await assert.rejects(rig.server.start(0), /already running/);
  } finally {
    await rig.server.stop();
  }
});

test("chat list, and messages go through the policy to the chat with the device id", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const h = { Cookie: cookie };
    const list = await request(rig.port, "GET", "/api/chats", { headers: h });
    assert.deepEqual(JSON.parse(list.body), [{ id: "c1", title: "First", busy: false }]);

    const ok = await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "sendPrompt", text: "hello", rule: "x" } });
    assert.equal(ok.status, 204);
    assert.equal(rig.chats[0].sent.length, 1);
    assert.deepEqual(rig.chats[0].sent[0].msg, { type: "sendPrompt", text: "hello", images: [] });
    assert.equal(typeof rig.chats[0].sent[0].device.id, "string");
    assert.equal(rig.chats[0].sent[0].device.name, "iPhone, Safari");

    const refused = await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "restart" } });
    assert.equal(refused.status, 403);
    assert.ok(rig.log.some((l) => l.includes("refused restart")));
    const autopilot = await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "setConfig", id: "autopilot", value: "on" } });
    assert.equal(autopilot.status, 403);
    assert.equal(rig.chats[0].sent.length, 1);

    assert.equal((await request(rig.port, "POST", "/api/chats/nope/message", { headers: h, json: { type: "ready" } })).status, 404);
    rig.chats[0].failSend = true;
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "cancelTurn" } })).status, 500);
  } finally {
    await rig.server.stop();
  }
});

test("bad bodies: not JSON, wrong type, too large", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const h = { Cookie: cookie, "Content-Type": "application/json" };
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, body: "{nope" })).status, 400);
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: "x" })).status, 415);
    // The server answers 413 and closes; depending on timing the client sees the answer or the cut connection.
    const huge = await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, body: Buffer.alloc(40 * 1024 * 1024, 97) }).catch(
      (e: NodeJS.ErrnoException) => ({ status: 0, code: e.code })
    );
    assert.ok(huge.status === 413 || ("code" in huge && ["ECONNRESET", "EPIPE"].includes(String(huge.code))), JSON.stringify(huge));
    assert.equal(rig.chats[0].sent.length, 0);
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "sendPrompt", text: "x".repeat(300_000) } })).status, 413);
  } finally {
    await rig.server.stop();
  }
});

test("permissions are read for every request", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const h = { Cookie: cookie };
    rig.perms.current = ["view"];
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "sendPrompt", text: "hi" } })).status, 403);
    assert.equal((await request(rig.port, "POST", "/api/chats/c1/message", { headers: h, json: { type: "ready" } })).status, 204);
    rig.perms.current = [];
    assert.equal((await request(rig.port, "GET", "/api/chats", { headers: h })).status, 403);
    assert.equal((await request(rig.port, "GET", "/api/chats/c1/events", { headers: h })).status, 403);
    assert.equal((await request(rig.port, "GET", "/api/chats/events", { headers: h })).status, 403);
  } finally {
    await rig.server.stop();
  }
});

test("a new stream gets the snapshot, a sync id, then live messages with ids", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const s = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    assert.equal(s.status, 200);
    await until("the snapshot", () => s.events.some((e) => e.event === "sync"));
    assert.equal(s.snapshots(), 1);
    assert.deepEqual(JSON.parse(s.events[0].data), { type: "userMessage", text: "earlier" });
    assert.equal(s.events[1].event, "sync");
    assert.match(s.events[1].id ?? "", /^[0-9a-f]+:0$/);

    rig.chats[0].emit({ type: "event", event: { kind: "textChunk", text: "hi" } });
    rig.chats[0].emit({ type: "notice", text: "two" });
    await until("live messages", () => s.events.length >= 4);
    assert.match(s.events[2].id ?? "", /:1$/);
    assert.match(s.events[3].id ?? "", /:2$/);
    assert.equal(JSON.parse(s.events[3].data).text, "two");
    s.close();
  } finally {
    await rig.server.stop();
  }
});

test("reconnecting with the last id gets only what was missed", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const first = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    await until("sync", () => first.events.some((e) => e.event === "sync"));
    rig.chats[0].emit({ n: 1 });
    rig.chats[0].emit({ n: 2 });
    await until("two messages", () => first.events.length >= 4);
    const lastId = first.events[first.events.length - 1].id as string;
    first.close();

    rig.chats[0].emit({ n: 3 });
    rig.chats[0].emit({ n: 4 });

    const again = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie, "Last-Event-ID": lastId });
    await until("the missed messages", () => again.events.length >= 2);
    assert.deepEqual(again.events.map((e) => JSON.parse(e.data)), [{ n: 3 }, { n: 4 }]);
    assert.equal(again.events.some((e) => e.event === "sync"), false); // no snapshot: a delta
    assert.equal(again.snapshots(), 0);
    rig.chats[0].emit({ n: 5 });
    await until("live again", () => again.events.length >= 3);
    assert.deepEqual(JSON.parse(again.events[2].data), { n: 5 });

    // The same through the query string (a page that reopens the stream itself).
    const viaQuery = await openStream(rig.port, `/api/chats/c1/events?last=${encodeURIComponent(lastId)}`, { Cookie: cookie });
    await until("query catch-up", () => viaQuery.events.length >= 3);
    assert.deepEqual(viaQuery.events.map((e) => JSON.parse(e.data)), [{ n: 3 }, { n: 4 }, { n: 5 }]);
    again.close();
    viaQuery.close();
  } finally {
    await rig.server.stop();
  }
});

test("an id from another run, or one the log no longer holds, gets a fresh snapshot", async () => {
  const rig = await boot({ logSize: 4 });
  try {
    const cookie = await pairDevice(rig);
    const first = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    await until("sync", () => first.events.some((e) => e.event === "sync"));
    const firstId = first.events[1].id as string; // epoch:0
    for (let i = 1; i <= 30; i++) {
      rig.chats[0].emit({ n: i });
    }
    await until("all messages", () => first.events.length >= 32);
    first.close();

    const tooOld = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie, "Last-Event-ID": firstId });
    await until("snapshot", () => tooOld.events.some((e) => e.event === "sync"));
    assert.equal(tooOld.snapshots(), 1);
    assert.deepEqual(JSON.parse(tooOld.events[0].data), { type: "userMessage", text: "earlier" });
    assert.match(tooOld.events[1].id ?? "", /:30$/);
    tooOld.close();

    const foreign = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie, "Last-Event-ID": "aaaaaaaaaaaa:5" });
    await until("snapshot", () => foreign.events.some((e) => e.event === "sync"));
    foreign.close();
  } finally {
    await rig.server.stop();
  }
});

test("streams send a heartbeat comment", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const s = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    await until("two pings", () => s.pings() >= 2);
    assert.equal(s.events.filter((e) => e.event === undefined && e.data).length, 1); // pings are not messages
    s.close();
  } finally {
    await rig.server.stop();
  }
});

test("removing a device closes its streams and its cookie stops working", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const other = await pairDevice(rig);
    const mine = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    const theirs = await openStream(rig.port, "/api/chats/c1/events", { Cookie: other });
    await until("both streams", () => rig.server.connectedDevices.length === 2);

    const dev = rig.devices.list()[0];
    rig.devices.remove(dev.id);
    rig.server.disconnectDevice(dev.id);
    await mine.ended;
    assert.equal((await request(rig.port, "GET", "/api/me", { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await request(rig.port, "GET", "/api/me", { headers: { Cookie: other } })).status, 200);
    assert.equal(rig.server.connectedDevices.length, 1);
    theirs.close();
  } finally {
    await rig.server.stop();
  }
});

test("logout removes the device and clears the cookie", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const r = await request(rig.port, "POST", "/api/logout", { headers: { Cookie: cookie }, json: {} });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await request(rig.port, "GET", "/api/me", { headers: { Cookie: cookie } })).status, 401);
    assert.equal(rig.devices.list().length, 0);
  } finally {
    await rig.server.stop();
  }
});

test("the chat list stream updates, and a chat that goes away ends its streams", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const list = await openStream(rig.port, "/api/chats/events", { Cookie: cookie });
    const chat = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    await until("first list", () => list.events.some((e) => e.event === "chats"));
    assert.deepEqual(JSON.parse(list.events[0].data), [{ id: "c1", title: "First", busy: false }]);

    rig.chats[0].title = "Renamed";
    rig.chats.push(new FakeChat("c2", "Second"));
    rig.server.chatsChanged();
    await until("updated list", () => list.events.length >= 2);
    assert.deepEqual(JSON.parse(list.events[1].data).map((c: { title: string }) => c.title), ["Renamed", "Second"]);

    rig.chats.shift();
    rig.server.chatsChanged();
    await chat.ended;
    assert.ok(chat.events.some((e) => e.event === "gone"));
    assert.equal(rig.chats[0].listeners.size, 0);
    assert.equal((await request(rig.port, "GET", "/api/chats/c1/events", { headers: { Cookie: cookie } })).status, 404);
    list.close();
  } finally {
    await rig.server.stop();
  }
});

test("a device cannot hold more than a few streams open", async () => {
  const rig = await boot();
  try {
    const cookie = await pairDevice(rig);
    const open: Stream[] = [];
    for (let i = 0; i < 8; i++) {
      open.push(await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie }));
    }
    await until("eight streams", () => rig.server.streamCount === 8);
    const ninth = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
    assert.equal(ninth.status, 429);
    open.forEach((s) => s.close());
  } finally {
    await rig.server.stop();
  }
});

test("stop ends open streams and unsubscribes from chats", async () => {
  const rig = await boot();
  const cookie = await pairDevice(rig);
  const s = await openStream(rig.port, "/api/chats/c1/events", { Cookie: cookie });
  await until("sync", () => s.events.some((e) => e.event === "sync"));
  assert.equal(rig.chats[0].listeners.size, 1);
  await rig.server.stop();
  await s.ended;
  assert.equal(rig.chats[0].listeners.size, 0);
  await assert.rejects(request(rig.port, "GET", "/"));
});

test("cookies are Secure behind a proxy (HTTPS) but not for plain loopback", async () => {
  const rig = await boot();
  try {
    const secret = rig.pairing.issue();
    const direct = await request(rig.port, "POST", "/api/pair", { json: { secret } });
    assert.doesNotMatch(String(direct.headers["set-cookie"]), /Secure/);
    const secret2 = rig.pairing.issue();
    const proxied = await request(rig.port, "POST", "/api/pair", { json: { secret: secret2 }, headers: { Host: "mac.tail1.ts.net" } });
    assert.match(String(proxied.headers["set-cookie"]), /Secure/);
  } finally {
    await rig.server.stop();
  }
});
