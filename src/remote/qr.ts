// A small QR code encoder (ISO/IEC 18004): byte mode, error correction L or M,
// versions 1 to 10 (up to 213 bytes at M, 271 at L). Written for one job, the
// pairing link on the remote access card, so it stays short. Pure (no vscode
// import). Checked against an independent encoder in qr.test.ts.

export type QrLevel = "L" | "M";

export interface QrCode {
  version: number;
  level: QrLevel;
  mask: number;
  size: number;
  /** modules[y][x]: true is a dark module. */
  modules: boolean[][];
}

// [error correction codewords per block, [[blocks, data codewords per block], ...]] for versions 1 to 10.
type Layout = readonly [number, ReadonlyArray<readonly [number, number]>];
const LAYOUT: Record<QrLevel, readonly Layout[]> = {
  L: [
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [18, [[2, 68], [2, 69]]],
  ],
  M: [
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ],
};

/** Centres of the alignment patterns, by version (index 0 is version 1). */
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0 };

export const MAX_VERSION = 10;

function dataCodewords(version: number, level: QrLevel): number {
  return LAYOUT[level][version - 1][1].reduce((sum, [count, size]) => sum + count * size, 0);
}

/** How many bytes of text fit in a version at a level. */
export function byteCapacity(version: number, level: QrLevel): number {
  // 4 bits of mode and 8 (versions 1 to 9) or 16 bits of length come first.
  const header = version < 10 ? 12 : 20;
  return Math.floor((dataCodewords(version, level) * 8 - header) / 8);
}

// --- Reed-Solomon over GF(256), polynomial 0x11d ---

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** The error correction codewords for a block of data. */
function reedSolomon(data: readonly number[], degree: number): number[] {
  // Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first, leading 1 left out.
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) {
      rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// --- The data bits ---

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function pickVersion(length: number, level: QrLevel): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (length <= byteCapacity(v, level)) {
      return v;
    }
  }
  throw new Error(`That is too long for a QR code here (${length} bytes; the most is ${byteCapacity(MAX_VERSION, level)}).`);
}

function dataBits(bytes: readonly number[], version: number, level: QrLevel): number[] {
  const bits: number[] = [];
  const put = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const capacityBits = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacityBits - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    put(pad, 8);
  }
  return bits;
}

/** Data and error correction codewords, split into blocks and interleaved. */
function codewords(bits: readonly number[], version: number, level: QrLevel): number[] {
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  const [ecLen, groups] = LAYOUT[level][version - 1];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const part = data.slice(at, at + size);
      at += size;
      blocks.push({ data: part, ec: reedSolomon(part, ecLen) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) {
      if (i < b.data.length) {
        out.push(b.data[i]);
      }
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) {
      out.push(b.ec[i]);
    }
  }
  return out;
}

// --- The grid ---

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns(level: QrLevel): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0); // timing
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = ALIGNMENT[this.version - 1];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
        if (!corner) {
          this.alignment(pos[i], pos[j]);
        }
      }
    }
    this.formatBits(level, 0); // reserves the format areas
    this.versionBits();
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  formatBits(level: QrLevel, mask: number): void {
    const data = (FORMAT_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) {
      this.set(8, i, bit(i));
    }
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) {
      this.set(14 - i, 8, bit(i));
    }
    for (let i = 0; i < 8; i++) {
      this.set(n - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i++) {
      this.set(8, n - 15 + i, bit(i));
    }
    this.set(8, n - 8, true); // the always-dark module
  }

  private versionBits(): void {
    if (this.version < 7) {
      return;
    }
    let rem = this.version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** Lay the codewords in the two-column zigzag, skipping the function modules. */
  placeData(data: readonly number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5; // the timing column is skipped
      }
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && maskHit(mask, x, y)) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

// --- Choosing the mask: the standard's four penalty rules ---

const FINDER_LIKE = "1011101"; // dark 1:1:3:1:1, to be preceded or followed by four light modules
const LIGHT_4 = "0000";

/** How many finder-like patterns a row or column has. The light quiet zone around the symbol counts as light. */
function finderLikeCount(line: string): number {
  const padded = LIGHT_4 + line + LIGHT_4;
  let count = 0;
  for (let i = padded.indexOf(FINDER_LIKE); i !== -1; ) {
    const lightBefore = padded.slice(i - 4, i) === LIGHT_4;
    const lightAfter = padded.slice(i + 7, i + 11) === LIGHT_4;
    if (lightBefore || lightAfter) {
      count++;
      i = padded.indexOf(FINDER_LIKE, i + 7);
    } else {
      i = padded.indexOf(FINDER_LIKE, i + 1);
    }
  }
  return count;
}

export function penalty(modules: readonly (readonly boolean[])[]): number {
  const n = modules.length;
  let score = 0;
  const rows = modules.map((r) => r.map((d) => (d ? "1" : "0")).join(""));
  const cols = Array.from({ length: n }, (_, x) => modules.map((r) => (r[x] ? "1" : "0")).join(""));
  // 1: five or more in a row of the same colour (3 points, plus 1 for each extra).
  for (const line of [...rows, ...cols]) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) {
          score += 3 + (run - 5);
        }
        run = 1;
      }
    }
    // 3: the finder-like pattern (40 points each).
    score += 40 * finderLikeCount(line);
  }
  // 2: 2x2 blocks of one colour (3 points each).
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }
  // 4: how far the share of dark modules is from half (10 points per 5%).
  const dark = modules.reduce((sum, r) => sum + r.filter(Boolean).length, 0);
  score += 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
  return score;
}

/** The data codewords alone (header, text, terminator, padding), before error correction. For tests. */
export function dataCodewordList(text: string, level: QrLevel = "M"): number[] {
  const bytes = utf8(text);
  const bits = dataBits(bytes, pickVersion(bytes.length, level), level);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  return out;
}

/** Make a QR code for `text` (UTF-8, byte mode). `opts.mask` is for tests; by default the best mask is chosen. */
export function encodeQr(text: string, opts: { level?: QrLevel; mask?: number } = {}): QrCode {
  const level = opts.level ?? "M";
  const bytes = utf8(text);
  const version = pickVersion(bytes.length, level);
  const words = codewords(dataBits(bytes, version, level), version, level);

  const grid = new Grid(version);
  grid.drawFunctionPatterns(level);
  grid.placeData(words);

  let best = opts.mask ?? 0;
  if (opts.mask === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      grid.applyMask(mask);
      grid.formatBits(level, mask);
      const score = penalty(grid.modules);
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
      grid.applyMask(mask); // undo
    }
  }
  grid.applyMask(best);
  grid.formatBits(level, best);
  return { version, level, mask: best, size: grid.size, modules: grid.modules };
}

/** The code as an SVG (black on white with the four-module quiet zone scanners need). */
export function qrSvg(qr: QrCode, opts: { pixelsPerModule?: number } = {}): string {
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const px = (opts.pixelsPerModule ?? 6) * total;
  const cells: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    // One path piece per run of dark modules.
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        let end = x;
        while (end + 1 < qr.size && qr.modules[y][end + 1]) {
          end++;
        }
        cells.push(`M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`);
        x = end;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" role="img" aria-label="QR code with the pairing link" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/><path d="${cells.join("")}" fill="#000000"/></svg>`
  );
}
