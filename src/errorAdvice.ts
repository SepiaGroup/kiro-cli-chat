// What to tell the user when a prompt fails: the engine's message tidied up,
// and a hint for the failures kiro-cli explains (login, session, network, rate
// limit). Ported from the kiro-cli TUI's turn-error handling (its wording and
// matching rules), so both behave alike. Pure.

export type ErrorCategory = "auth" | "session" | "network" | "permission" | "mcp" | "rate_limit" | "tool" | "unknown";

/** The message without the engine's boilerplate ("Encountered an error in the response stream: ..."). */
export function cleanError(raw: string): string {
  const t = raw.toLowerCase();
  if (t.includes("no token")) {
    return "Not authenticated";
  }
  if (t.includes("token expired")) {
    return "Session expired";
  }
  if (t.includes("error sending request")) {
    return "Network error - unable to connect";
  }
  if (t.includes("i/o error") || t.includes("io error")) {
    return /url \(([^)]+)\)/i.test(raw) ? "Network error - unable to reach service" : "Network error";
  }
  let n = raw;
  for (const prefix of ["Encountered an error in the response stream: ", "An unknown error occurred: "]) {
    if (n.startsWith(prefix)) {
      n = n.slice(prefix.length);
    }
  }
  if (n.toLowerCase().startsWith("dispatch failure")) {
    const last = n.split(" - ").pop();
    if (n.includes(" - ") && last) {
      n = last.charAt(0).toUpperCase() + last.slice(1);
    }
  }
  return n;
}

export function classifyError(raw: string): ErrorCategory {
  const t = raw.toLowerCase();
  if (
    t.includes("no token") ||
    t.includes("token expired") ||
    t.includes("unauthorized") ||
    t.includes("not authenticated") ||
    t.includes("authentication required") ||
    (t.includes("dispatch failure") && t.includes("token"))
  ) {
    return "auth";
  }
  if (t.includes("auth") || t.includes("login")) {
    return "auth";
  }
  if (t.includes("session")) {
    return "session";
  }
  if (
    ["network", "connection", "timeout", "econnrefused", "enotfound", "i/o error", "io error", "error sending request"].some(
      (k) => t.includes(k)
    )
  ) {
    return "network";
  }
  if (t.includes("permission") || t.includes("eacces") || t.includes("eperm")) {
    return "permission";
  }
  if (t.includes("mcp")) {
    return "mcp";
  }
  if (t.includes("rate limit") || t.includes("throttle") || t.includes("throttling")) {
    return "rate_limit";
  }
  if (t.includes("tool")) {
    return "tool";
  }
  return "unknown";
}

export const RATE_LIMIT_ADVICE = "Rate limit exceeded. Please wait a moment before trying again.";

/** A hint for the failures worth one; undefined for the rest. `loginHow` names how to log in here. */
export function adviceFor(raw: string, loginHow: string): string | undefined {
  const t = raw.toLowerCase();
  switch (classifyError(raw)) {
    case "auth":
      return `Log in again (${loginHow}), then try your message again.`;
    case "session":
      return "A session error occurred. Please try again, or start a new session if it keeps happening.";
    case "network":
      if (t.includes("timeout")) {
        return "Connection timed out. Please check your network connection and try again.";
      }
      if (t.includes("econnrefused") || t.includes("connection refused")) {
        return "Connection refused. Please check your network connection and try again.";
      }
      if (t.includes("enotfound") || t.includes("dns")) {
        return "Could not resolve host. Please check your network connection.";
      }
      return "Network error occurred. Please check your connection and try again.";
    case "rate_limit":
      return RATE_LIMIT_ADVICE;
    default:
      return undefined;
  }
}

/** The text to show for a failed prompt: the cleaned message, then the hint if there is one. */
export function describeError(raw: string, loginHow: string): string {
  const message = cleanError(raw);
  const advice = adviceFor(raw, loginHow);
  return advice ? `${message}. ${advice}`.replace(/\.\.\s/, ". ") : message;
}
