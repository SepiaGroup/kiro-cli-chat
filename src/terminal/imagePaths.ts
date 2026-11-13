// Find image file paths in a terminal prompt. Dragging a file onto a VS Code
// terminal types its path (quoted or backslash-escaped if it has spaces);
// those images get attached to the prompt. Pure (no vscode import).

import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * The image type a file's first bytes show, if it's a PNG, JPEG, GIF or WebP.
 * Used to check that a file named like an image really is one.
 */
export function sniffImageMime(b: Uint8Array): string | undefined {
  const at = (i: number, bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (at(0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (at(0, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return undefined;
}

export function imageMimeForPath(p: string): string | undefined {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext];
}

/**
 * Return candidate image paths (absolute, de-duplicated, in order) mentioned in
 * `text`. Understands 'single quotes', "double quotes", backslash-escaped
 * spaces, ~/ paths, paths relative to `cwd`, and file:// URIs. Existence is
 * not checked here.
 */
export function findImagePaths(text: string, cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /'([^'\n]+)'|"([^"\n]+)"|((?:\\.|[^\s'"])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let token = m[1] ?? m[2] ?? (m[3] ?? "").replace(/\\(.)/g, "$1");
    // "look at a.png," → drop trailing punctuation that isn't part of the name.
    const stripped = token.replace(/[),.;:!?]+$/, "");
    if (!imageMimeForPath(token) && imageMimeForPath(stripped)) {
      token = stripped;
    }
    if (!imageMimeForPath(token)) {
      continue;
    }
    let p = token;
    if (p.startsWith("file://")) {
      try {
        p = fileURLToPath(p);
      } catch {
        continue;
      }
    } else if (p === "~" || p.startsWith("~/")) {
      p = path.join(os.homedir(), p.slice(1));
    } else if (!path.isAbsolute(p)) {
      // Only treat it as a relative path if it looks like one.
      if (!p.includes("/") && !/^[\w.-]+\.\w+$/.test(p)) {
        continue;
      }
      p = path.resolve(cwd, p);
    }
    p = path.normalize(p);
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
