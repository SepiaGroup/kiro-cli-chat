import { test } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, existingServe, findCli, interpretServe, parseStatus, RunResult, Run, serveArgs, TailscaleServe, unserveArgs } from "./tailscale";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const status = (state: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ BackendState: state, Self: { DNSName: "michaels-mac-pro.taila1bfeb.ts.net." }, CertDomains: ["michaels-mac-pro.taila1bfeb.ts.net"], ...extra });

/** A fake Tailscale: answers by the first argument(s); records what was run. */
function fake(handlers: Record<string, (args: string[]) => RunResult>, present = ["/usr/local/bin/tailscale"]) {
  const calls: string[] = [];
  const run: Run = async (cli, args) => {
    if (!present.includes(cli)) {
      return { code: null, stdout: "", stderr: "ENOENT", timedOut: false };
    }
    calls.push(`${cli} ${args.join(" ")}`);
    const key = args.slice(0, args[0] === "serve" && args[1] === "status" ? 2 : 1).join(" ");
    return (handlers[key] ?? (() => ok()))(args);
  };
  return { run, calls };
}

test("the commands are exactly these", () => {
  assert.deepEqual(serveArgs(51234), ["serve", "--bg", "--https=8443", "http://127.0.0.1:51234"]);
  assert.deepEqual(unserveArgs(), ["serve", "--https=8443", "off"]);
  assert.deepEqual(unserveArgs(10000), ["serve", "--https=10000", "off"]);
  assert.equal(baseUrl("a.b.ts.net"), "https://a.b.ts.net:8443");
  assert.equal(baseUrl("a.b.ts.net", 443), "https://a.b.ts.net");
});

test("the CLI is found on PATH, in /usr/local/bin or in the app", async () => {
  const f = fake({}, ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  assert.equal(await findCli(f.run), "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  assert.equal(await findCli(fake({}, []).run), undefined);
});

test("status: running with certificates, running without, and the states that need the user", () => {
  assert.deepEqual(parseStatus(status("Running")), { kind: "ready", dnsName: "michaels-mac-pro.taila1bfeb.ts.net", certsEnabled: true });
  assert.deepEqual(parseStatus(status("Running", { CertDomains: null })), { kind: "ready", dnsName: "michaels-mac-pro.taila1bfeb.ts.net", certsEnabled: false });
  assert.match((parseStatus(status("NeedsLogin")) as { advice: string }).advice, /not logged in/);
  assert.match((parseStatus(status("Stopped")) as { advice: string }).advice, /turned off/);
  assert.match((parseStatus(status("Starting")) as { advice: string }).advice, /not ready/);
  assert.match((parseStatus("not json") as { advice: string }).advice, /Could not read/);
  assert.match((parseStatus(status("Running", { Self: { DNSName: "" } })) as { advice: string }).advice, /MagicDNS/);
});

test("what is already served on our port", () => {
  const name = "m.ts.net";
  assert.equal(existingServe("{}", name, 8443), "none");
  assert.equal(existingServe("garbage", name, 8443), "none");
  const ours = { TCP: { "8443": { HTTPS: true } }, Web: { "m.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:51234" } } } } };
  assert.equal(existingServe(JSON.stringify(ours), name, 8443), "loopbackProxy");
  const files = { Web: { "m.ts.net:8443": { Handlers: { "/": { Path: "/tmp/site" } } } } };
  assert.equal(existingServe(JSON.stringify(files), name, 8443), "other");
  const twoPaths = { Web: { "m.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" }, "/api": { Proxy: "http://127.0.0.1:2" } } } } };
  assert.equal(existingServe(JSON.stringify(twoPaths), name, 8443), "other");
  assert.equal(existingServe(JSON.stringify(ours), name, 443), "none"); // another port
});

test("the output of serve, as seen on a tailnet where Serve was off", () => {
  const waited: RunResult = {
    code: null,
    timedOut: true,
    stderr: "",
    stdout: "\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXFcEcDwr921CNTRL\n\n",
  };
  const r = interpretServe(waited);
  assert.equal(r.ok, false);
  assert.equal((r as { enableUrl?: string }).enableUrl, "https://login.tailscale.com/f/serve?node=nXFcEcDwr921CNTRL");
  assert.deepEqual(interpretServe(ok("Available within your tailnet:\n")), { ok: true });
  assert.match((interpretServe({ code: null, stdout: "", stderr: "", timedOut: true }) as { advice: string }).advice, /did not answer/);
  assert.match((interpretServe({ code: 1, stdout: "", stderr: "error: something odd\n\ntry `tailscale serve --help`", timedOut: false }) as { advice: string }).advice, /something odd/);
});

test("expose: runs serve for the local port and gives the tailnet address", async () => {
  const f = fake({ "status": () => ok(status("Running")), "serve status": () => ok("{}"), serve: () => ok("Available within your tailnet") });
  const t = new TailscaleServe(f.run);
  const r = await t.expose(51234);
  assert.deepEqual(r, { ok: true, url: "https://michaels-mac-pro.taila1bfeb.ts.net:8443" });
  assert.ok(f.calls.includes("/usr/local/bin/tailscale serve --bg --https=8443 http://127.0.0.1:51234"));
  assert.equal(t.active, true);
});

test("expose: says why it cannot, and runs nothing it should not", async () => {
  assert.match(((await new TailscaleServe(fake({}, []).run).expose(1)) as { advice: string }).advice, /not installed/);

  const loggedOut = fake({ status: () => ok(status("NeedsLogin")) });
  const r1 = await new TailscaleServe(loggedOut.run).expose(1);
  assert.match((r1 as { advice: string }).advice, /not logged in/);
  assert.ok(!loggedOut.calls.some((c) => c.includes("--bg")));

  const busy = fake({
    status: () => ok(status("Running")),
    "serve status": () => ok(JSON.stringify({ Web: { "michaels-mac-pro.taila1bfeb.ts.net:8443": { Handlers: { "/": { Path: "/tmp" } } } } })),
  });
  const r2 = await new TailscaleServe(busy.run).expose(1);
  assert.match((r2 as { advice: string }).advice, /already used/);
  assert.ok(!busy.calls.some((c) => c.includes("--bg")));

  const notEnabled = fake({
    status: () => ok(status("Running", { CertDomains: null })),
    "serve status": () => ok("{}"),
    serve: () => ({ code: null, timedOut: true, stderr: "", stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n https://login.tailscale.com/f/serve?node=abc\n" }),
  });
  const t = new TailscaleServe(notEnabled.run);
  const r3 = await t.expose(1);
  assert.equal(r3.ok, false);
  assert.equal((r3 as { enableUrl?: string }).enableUrl, "https://login.tailscale.com/f/serve?node=abc");
  assert.equal(t.active, false);
});

test("remove takes down only what expose set up, once", async () => {
  const f = fake({ status: () => ok(status("Running")), "serve status": () => ok("{}"), serve: () => ok() });
  const t = new TailscaleServe(f.run);
  await t.remove(); // nothing exposed: runs nothing
  assert.ok(!f.calls.some((c) => c.includes("off")));
  await t.expose(1, 10000);
  await t.remove();
  await t.remove();
  assert.equal(f.calls.filter((c) => c.endsWith("serve --https=10000 off")).length, 1);
  assert.equal(t.active, false);
});
