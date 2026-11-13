import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearedCookie,
  cleanDeviceName,
  COOKIE_NAME,
  DEVICE_MAX_AGE_S,
  deviceCookie,
  DeviceStore,
  deviceNameFromUserAgent,
  hashSecret,
  newSecret,
  PairingCode,
  parseCookies,
  RateLimiter,
  safeEqual,
} from "./remoteAuth";

test("secrets are long, different every time and URL safe", () => {
  const a = newSecret();
  assert.notEqual(a, newSecret());
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashSecret("x"), hashSecret("x"));
  assert.notEqual(hashSecret("x"), hashSecret("y"));
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("a pairing code works once, a wrong guess does not use it up", () => {
  const p = new PairingCode(60_000, () => 1000);
  assert.equal(p.redeem("anything"), false);
  const code = p.issue();
  assert.equal(p.active, true);
  assert.equal(p.redeem("wrong"), false);
  assert.equal(p.redeem(42), false);
  assert.equal(p.redeem(code), true);
  assert.equal(p.redeem(code), false);
  assert.equal(p.active, false);
});

test("a pairing code expires, and a new one replaces the old", () => {
  let t = 0;
  const p = new PairingCode(1000, () => t);
  const first = p.issue();
  t = 1001;
  assert.equal(p.redeem(first), false);
  const a = p.issue();
  const b = p.issue();
  assert.equal(p.redeem(a), false);
  assert.equal(p.redeem(b), true);
  const c = p.issue();
  p.revoke();
  assert.equal(p.redeem(c), false);
  assert.equal(p.redeem("x".repeat(500)), false);
});

test("devices are found by their cookie value, which is never stored", () => {
  const store = new DeviceStore();
  let changes = 0;
  store.onChange = () => changes++;
  const { device, token } = store.add("  Phone\n  one ");
  assert.equal(device.name, "Phone one");
  assert.notEqual(device.tokenHash, token);
  assert.equal(JSON.stringify(store.list()).includes(token), false);
  assert.equal(store.authenticate(token)?.id, device.id);
  assert.equal(store.authenticate("nope"), undefined);
  assert.equal(store.authenticate(undefined), undefined);
  assert.equal(store.remove(device.id), true);
  assert.equal(store.authenticate(token), undefined);
  assert.equal(store.remove(device.id), false);
  assert.equal(changes, 2);
});

test("saved devices come back, and an unused one expires", () => {
  let t = 0;
  const a = new DeviceStore([], () => t);
  const { token, device } = a.add("Tablet");
  const b = new DeviceStore(a.list(), () => t);
  assert.equal(b.authenticate(token)?.id, device.id);
  t = (DEVICE_MAX_AGE_S + 10) * 1000;
  assert.equal(b.authenticate(token), undefined);
  assert.equal(b.list().length, 0);
  const c = new DeviceStore([{ id: 1 } as never, null as never]);
  assert.equal(c.list().length, 0);
});

test("device names", () => {
  assert.equal(cleanDeviceName("a\u0000b\u202e"), "a b\u202e".trim());
  assert.equal(cleanDeviceName(5), "");
  assert.equal(cleanDeviceName("x".repeat(100)).length, 40);
  assert.equal(
    deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    "iPhone, Safari"
  );
  assert.equal(
    deviceNameFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
    "Android, Chrome"
  );
  assert.equal(deviceNameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/120.0"), "Mac, Firefox");
  assert.equal(deviceNameFromUserAgent(undefined), "Device");
});

test("cookies: parse, set and clear", () => {
  assert.deepEqual(parseCookies("a=1; kcc_device=tok=en; b"), { a: "1", kcc_device: "tok=en" });
  assert.deepEqual(parseCookies(undefined), {});
  const c = deviceCookie("tok", true);
  assert.ok(c.startsWith(`${COOKIE_NAME}=tok;`));
  for (const attr of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) {
    assert.ok(c.includes(attr), attr);
  }
  assert.equal(deviceCookie("tok", false).includes("Secure"), false);
  assert.ok(clearedCookie(true).includes("Max-Age=0"));
});

test("the rate limiter allows a number of calls per window", () => {
  let t = 0;
  const r = new RateLimiter(3, 1000, () => t);
  assert.deepEqual([r.allow("k"), r.allow("k"), r.allow("k"), r.allow("k")], [true, true, true, false]);
  assert.equal(r.allow("other"), true);
  t = 1001;
  assert.equal(r.allow("k"), true);
});
