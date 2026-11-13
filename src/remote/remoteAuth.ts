// Pairing and device identity for remote access: random secrets, a one-use
// pairing code, device records that keep only a hash of the device's secret,
// cookies, and a rate limit. Pure (no vscode import).

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "kcc_device";
/** How long a paired device stays paired without being used. */
export const DEVICE_MAX_AGE_S = 180 * 24 * 3600;

/** A random secret, safe in a URL fragment or cookie. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time comparison (hashes first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** The code in the pairing link: valid for a short time, once. */
export class PairingCode {
  private entry?: { hash: string; expires: number };

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** A new code; any earlier one stops working. */
  issue(): string {
    const secret = newSecret();
    this.entry = { hash: hashSecret(secret), expires: this.now() + this.ttlMs };
    return secret;
  }

  /** True once for the right code, before it expires. A wrong guess does not use it up. */
  redeem(secret: unknown): boolean {
    const e = this.entry;
    if (!e || typeof secret !== "string" || secret.length > 200) {
      return false;
    }
    if (this.now() > e.expires) {
      this.entry = undefined;
      return false;
    }
    if (!safeEqual(hashSecret(secret), e.hash)) {
      return false;
    }
    this.entry = undefined;
    return true;
  }

  get active(): boolean {
    return Boolean(this.entry && this.now() <= this.entry.expires);
  }

  revoke(): void {
    this.entry = undefined;
  }
}

export interface DeviceRecord {
  id: string;
  name: string;
  /** SHA-256 of the device's cookie value. The value itself is never kept. */
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

export class DeviceStore {
  private byHash = new Map<string, DeviceRecord>();
  /** Called when the list changes, so the owner can save it. */
  onChange?: () => void;

  constructor(
    records: readonly DeviceRecord[] = [],
    private readonly now: () => number = Date.now
  ) {
    for (const r of records) {
      if (r && typeof r.tokenHash === "string" && typeof r.id === "string") {
        this.byHash.set(r.tokenHash, { ...r, name: cleanDeviceName(r.name) || "Device" });
      }
    }
  }

  /** Register a device; the returned token goes into its cookie and nowhere else. */
  add(name: string): { device: DeviceRecord; token: string } {
    const token = newSecret();
    const t = this.now();
    const device: DeviceRecord = {
      id: randomBytes(6).toString("hex"),
      name: cleanDeviceName(name) || "Device",
      tokenHash: hashSecret(token),
      createdAt: t,
      lastSeen: t,
    };
    this.byHash.set(device.tokenHash, device);
    this.onChange?.();
    return { device, token };
  }

  /** The device a cookie value belongs to. (A map lookup on a SHA-256 digest reveals nothing about the value.) */
  authenticate(token: string | undefined): DeviceRecord | undefined {
    if (!token || token.length > 200) {
      return undefined;
    }
    const d = this.byHash.get(hashSecret(token));
    if (!d) {
      return undefined;
    }
    if (this.now() - d.lastSeen > DEVICE_MAX_AGE_S * 1000) {
      this.byHash.delete(d.tokenHash);
      this.onChange?.();
      return undefined;
    }
    d.lastSeen = this.now();
    return d;
  }

  remove(id: string): boolean {
    for (const [hash, d] of this.byHash) {
      if (d.id === id) {
        this.byHash.delete(hash);
        this.onChange?.();
        return true;
      }
    }
    return false;
  }

  clear(): void {
    if (this.byHash.size > 0) {
      this.byHash.clear();
      this.onChange?.();
    }
  }

  list(): DeviceRecord[] {
    return [...this.byHash.values()].map((d) => ({ ...d }));
  }
}

/** A device name from the device itself: trimmed, one line, no control characters. */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** "iPhone, Safari" and the like, for the list of paired devices. */
export function deviceNameFromUserAgent(ua: string | undefined): string {
  const s = ua ?? "";
  const os = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /Linux/.test(s)
              ? "Linux"
              : "Device";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /CriOS|Chrome\//.test(s)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(s)
        ? "Firefox"
        : /Safari\//.test(s)
          ? "Safari"
          : "";
  return browser ? `${os}, ${browser}` : os;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** The Set-Cookie value for a paired device. `secure` is off only for plain-HTTP localhost. */
export function deviceCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** At most `max` calls per `windowMs` for a key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
