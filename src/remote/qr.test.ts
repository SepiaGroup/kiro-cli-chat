import { test } from "node:test";
import assert from "node:assert/strict";
import { byteCapacity, dataCodewordList, encodeQr, MAX_VERSION, penalty, qrSvg } from "./qr";
import { QR_VECTORS } from "./qr.vectors";

function hex(modules: readonly (readonly boolean[])[]): string {
  let bits = modules.map((r) => r.map((d) => (d ? "1" : "0")).join("")).join("");
  bits += "0".repeat((4 - (bits.length % 4)) % 4);
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    out += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return out;
}

test("byte capacities are the standard's", () => {
  assert.deepEqual([1, 2, 3, 5, 10].map((v) => byteCapacity(v, "L")), [17, 32, 53, 106, 271]);
  assert.deepEqual([1, 2, 3, 5, 10].map((v) => byteCapacity(v, "M")), [14, 26, 42, 84, 213]);
});

test("every reference code is reproduced module for module (all versions, both levels, all masks)", () => {
  assert.equal(QR_VECTORS.length, 28);
  for (const v of QR_VECTORS) {
    const qr = encodeQr(v.text, { level: v.level, mask: v.mask });
    assert.equal(qr.version, v.version, `version for ${v.level}${v.version}`);
    assert.equal(hex(qr.modules), v.matrix, `${v.level}${v.version} mask ${v.mask}`);
  }
});

test("the penalty score is the reference's, for every reference code", () => {
  for (const v of QR_VECTORS) {
    const n = 17 + 4 * v.version;
    const bits = [...v.matrix].map((c) => parseInt(c, 16).toString(2).padStart(4, "0")).join("");
    const modules = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => bits[y * n + x] === "1"));
    assert.equal(penalty(modules), v.score, `${v.level}${v.version} mask ${v.mask}`);
  }
});

test("data codewords follow the standard: mode, length, text, terminator, then EC 11 pads", () => {
  // "HI" in version 1-M (16 data codewords): 0100 00000010 01001000 01001001 0000, then pads.
  const d = dataCodewordList("HI", "M");
  assert.equal(d.length, 16);
  assert.deepEqual(d.slice(0, 4), [0x40, 0x24, 0x84, 0x90]);
  assert.deepEqual(d.slice(4), [0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
  // UTF-8 is by byte: "é" is two bytes, so the length field says 2.
  assert.deepEqual(dataCodewordList("é", "M").slice(0, 4), [0x40, 0x2c, 0x3a, 0x90]);
  // Versions 10 and up count with 16 bits.
  const long = dataCodewordList("a".repeat(200), "M");
  assert.equal(long.length, 216);
  assert.deepEqual(long.slice(0, 3), [0x40, 0x0c, 0x86]);
  // The count is in bytes of the capacity, and the stream always fills it.
  for (const level of ["L", "M"] as const) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const n = byteCapacity(v, level);
      const stream = dataCodewordList("x".repeat(n), level);
      assert.equal(encodeQr("x".repeat(n), { level }).version, v);
      assert.equal(stream.length * 8 >= n * 8 + 12, true);
    }
  }
});

test("the best mask really has the lowest penalty", () => {
  const text = "https://michaels-mac-pro.taila1bfeb.ts.net:8443/#k=39iaZLvg-7ACOZO0Se_WxwOtAwufyTUoRZJ9g0u8164";
  const best = encodeQr(text);
  const scores = Array.from({ length: 8 }, (_, mask) => penalty(encodeQr(text, { mask }).modules));
  assert.equal(scores[best.mask], Math.min(...scores));
});

test("a typical pairing link fits, and the size follows the length", () => {
  const link = "https://michaels-mac-pro.taila1bfeb.ts.net:8443/#k=39iaZLvg-7ACOZO0Se_WxwOtAwufyTUoRZJ9g0u8164";
  const qr = encodeQr(link);
  assert.equal(qr.version, 6); // 95 bytes at M (version 6 holds 106)
  assert.equal(qr.size, 41);
  assert.equal(encodeQr("hi").version, 1);
});

test("too much text is refused with a clear message", () => {
  assert.throws(() => encodeQr("x".repeat(214)), /too long/);
  assert.ok(encodeQr("x".repeat(213)).version === MAX_VERSION);
  assert.ok(encodeQr("x".repeat(271), { level: "L" }).version === MAX_VERSION);
});

test("the finder patterns and timing line are in place", () => {
  const { modules, size } = encodeQr("test");
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.ok(modules[y0][x0] && modules[y0 + 3][x0 + 3] && modules[y0 + 6][x0 + 6]);
    assert.ok(!modules[y0 + 1][x0 + 1] && !modules[y0 + 5][x0 + 5]);
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0);
    assert.equal(modules[i][6], i % 2 === 0);
  }
  assert.ok(modules[size - 8][8]); // the always-dark module
});

test("the SVG has a quiet zone and one dark rectangle path, and no inline style", () => {
  const qr = encodeQr("hello");
  const svg = qrSvg(qr);
  assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`));
  assert.match(svg, /fill="#ffffff"/);
  assert.doesNotMatch(svg, /style=/);
  assert.match(svg, /^<svg [^>]*aria-label=/);
});
