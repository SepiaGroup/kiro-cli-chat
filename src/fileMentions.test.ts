import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { expandFileMentions, FileIo, MAX_MENTION_BYTES, mentionNotice } from "./fileMentions";

function io(files: Record<string, string | Buffer>): FileIo {
  return {
    fileSize: (p) => (p in files ? Buffer.from(files[p]).length : undefined),
    read: (p) => Buffer.from(files[p]),
  };
}

test("@file: is replaced by the file's text, relative to the folder", () => {
  const m = expandFileMentions("Explain @file:src/a.ts please", "/w", io({ [join("/w", "src/a.ts")]: "let a = 1;" }));
  assert.equal(m.text, 'Explain <attached_file path="src/a.ts"> let a = 1; </attached_file> please');
  assert.deepEqual(m.attached, ["src/a.ts"]);
  assert.deepEqual(m.skipped, []);
});

test("absolute paths work; text without mentions is untouched", () => {
  assert.equal(expandFileMentions("hi @file", "/w", io({})).text, "hi @file");
  const m = expandFileMentions("@file:/x/n.txt", "/w", io({ "/x/n.txt": "n" }));
  assert.equal(m.text, '<attached_file path="/x/n.txt"> n </attached_file>');
});

test("a mention that can't be attached stays as typed, with a reason", () => {
  const files = { "/w/big.txt": "x".repeat(MAX_MENTION_BYTES + 1), "/w/bin.dat": Buffer.from([1, 0, 2]) };
  const m = expandFileMentions("@file:nope.txt @file:big.txt @file:bin.dat", "/w", io(files));
  assert.equal(m.text, "@file:nope.txt @file:big.txt @file:bin.dat");
  assert.deepEqual(m.skipped.map((s) => s.reason), ["not a file", "larger than 256 KB", "not text"]);
});

test("the same file twice counts twice toward the total", () => {
  const body = "y".repeat(MAX_MENTION_BYTES);
  const m = expandFileMentions("@file:a @file:a @file:a @file:a @file:a", "/w", io({ "/w/a": body }));
  assert.equal(m.attached.length, 4);
  assert.deepEqual(m.skipped.map((s) => s.reason), ["too much attached already"]);
});

test("mentionNotice says what was attached and what was not", () => {
  assert.equal(mentionNotice({ attached: [], skipped: [] }), undefined);
  assert.equal(mentionNotice({ attached: ["a.ts", "b.ts"], skipped: [] }), "Attached: a.ts, b.ts.");
  assert.equal(
    mentionNotice({ attached: ["a.ts"], skipped: [{ path: "x", reason: "not a file" }] }),
    "Attached: a.ts. Not attached: x (not a file)."
  );
});

test("punctuation after a mention isn't part of the name", () => {
  const files = { "/w/a.ts": "A", "/w/odd,": "B" };
  assert.equal(expandFileMentions("see @file:a.ts, then @file:a.ts?", "/w", io(files)).text, 'see <attached_file path="a.ts"> A </attached_file>, then <attached_file path="a.ts"> A </attached_file>?');
  // A file that really ends in punctuation still works.
  assert.equal(expandFileMentions("@file:odd,", "/w", io(files)).text, '<attached_file path="odd,"> B </attached_file>');
  assert.deepEqual(expandFileMentions("@file:gone.ts.", "/w", io(files)).skipped, [{ path: "gone.ts", reason: "not a file" }]);
});
