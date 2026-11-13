import { test } from "node:test";
import assert from "node:assert/strict";
import { cardAction, pairingCardHtml } from "./pairingCard";
import { encodeQr, qrSvg } from "./qr";

const link = "https://mac.tail1.ts.net:8443/#k=abc_DEF-123";

test("with a tailnet link the card shows the QR code, the link and the buttons", () => {
  const html = pairingCardHtml({ link, qrSvg: qrSvg(encodeQr(link)), expiresAt: "4:12 PM", nonce: "N" });
  assert.match(html, /<svg /);
  assert.ok(html.includes(link));
  for (const a of ["copy", "open", "newLink"]) {
    assert.ok(html.includes(`data-action="${a}"`), a);
  }
  assert.ok(!html.includes('data-action="setup"') && !html.includes('data-action="retry"'));
  assert.match(html, /until 4:12 PM/);
});

test("without Tailscale it says why, offers setup and retry, and shows no QR code", () => {
  const html = pairingCardHtml({ link: "http://127.0.0.1:5/#k=x", problem: { advice: "Tailscale is turned off.", canOpenSetup: true }, expiresAt: "1:00 PM" });
  assert.match(html, /this Mac only. Tailscale is turned off\./);
  assert.ok(html.includes('data-action="setup"') && html.includes('data-action="retry"'));
  assert.doesNotMatch(html, /<svg /);
  assert.ok(!pairingCardHtml({ link: "x", problem: { advice: "a", canOpenSetup: false }, expiresAt: "t" }).includes('data-action="setup"'));
});

test("text put in the page is escaped, and the CSP lets only the page's own style and script run", () => {
  const html = pairingCardHtml({ link: `x"><script>alert(1)</script>`, problem: { advice: "<b>no</b>", canOpenSetup: false }, expiresAt: "<i>", nonce: "N" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>no<\/b>/);
  assert.match(html, /default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N'/);
  assert.doesNotMatch(html, / style="/);
});

test("only the known button names are accepted from the page", () => {
  assert.equal(cardAction({ action: "copy" }), "copy");
  assert.equal(cardAction({ action: "newLink" }), "newLink");
  for (const bad of [{ action: "rm -rf" }, { action: 1 }, {}, null, "copy", undefined, { action: "__proto__" }]) {
    assert.equal(cardAction(bad), undefined);
  }
});
