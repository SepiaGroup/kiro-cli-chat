import { test } from "node:test";
import assert from "node:assert/strict";
import { QuestionPrompt } from "./questionPrompt";
import { stripAnsi } from "./ansi";
import type { Question, RpcId } from "../types";

const Q: Question = {
  toolCallId: "t",
  question: "**Pick** a color",
  options: [
    { title: "red", description: "warm" },
    { title: "blue", recommended: true },
    { title: "mix", subOptionsLabel: "Which?", subOptions: [{ title: "a" }, { title: "b", description: "bee" }] },
  ],
};

function setup(canRespond = true) {
  const printed: string[] = [];
  const written: string[] = [];
  const answers: Array<[RpcId, string | undefined]> = [];
  const p = new QuestionPrompt({
    print: (t) => printed.push(stripAnsi(t)),
    write: (t) => written.push(stripAnsi(t)),
    cols: () => 80,
    canRespond: () => canRespond,
    respond: (id, a) => answers.push([id, a]),
  });
  const keys = (...ks: string[]) => ks.forEach((k) => p.handleKey(k));
  return { p, printed, written, answers, keys };
}

test("shows the question with numbered choices and a hint", () => {
  const s = setup();
  s.p.enqueue(Q, 1);
  assert.equal(s.p.active, true);
  assert.equal(
    s.printed[0],
    [
      "? Pick a color",
      "  [1] red  warm",
      "  [2] blue (recommended)",
      "  [3] mix",
      "  Type a number or your own answer. Enter sends (empty = 2), Esc skips.",
    ].join("\n")
  );
  assert.equal(s.written.at(-1), "  Answer: ");
});

test("a number picks that choice; other text is sent as typed", () => {
  const s = setup();
  s.p.enqueue(Q, 1);
  s.keys("1", "\r");
  s.p.enqueue(Q, 2);
  s.keys("g", "r", "e", "e", "n", "x", "\x7f", "\r");
  s.p.enqueue(Q, 3);
  s.keys("9", "\r"); // out of range: it's just text
  assert.deepEqual(s.answers, [[1, "red"], [2, "green"], [3, "9"]]);
  assert.match(s.printed.join("\n"), /→ You answered: red/);
  assert.equal(s.p.active, false);
});

test("Enter alone takes the recommended choice; without one it rings", () => {
  const s = setup();
  s.p.enqueue(Q, 1);
  s.keys("\r");
  assert.deepEqual(s.answers, [[1, "blue"]]);
  s.p.enqueue({ ...Q, options: [] }, 2);
  s.keys("\r");
  assert.equal(s.answers.length, 1);
  assert.ok(s.written.includes("\x07"));
  s.keys("\x1b");
  assert.deepEqual(s.answers.at(-1), [2, undefined]);
  assert.match(s.printed.at(-1) ?? "", /→ Skipped/);
});

test("a choice with sub-options opens a checklist", () => {
  const s = setup();
  s.p.enqueue(Q, 1);
  s.keys("3", "\r");
  assert.equal(s.printed.at(-1), ["  Which?", "  [1] [x] a", "  [2] [x] b  bee", "  Press a number to toggle. Enter sends, Esc goes back."].join("\n"));
  s.keys("1");
  assert.match(s.printed.at(-1) ?? "", /\[1\] \[ \] a\n {2}\[2\] \[x\] b/);
  s.keys("7");
  assert.equal(s.written.at(-1), "\x07");
  s.keys("\r");
  assert.deepEqual(s.answers, [[1, "mix [b]"]]);
});

test("Esc in the checklist goes back to the question", () => {
  const s = setup();
  s.p.enqueue(Q, 1);
  s.keys("3", "\r", "\x1b");
  assert.match(s.printed.at(-1) ?? "", /^\? Pick a color/);
  s.keys("2", "\r");
  assert.deepEqual(s.answers, [[1, "blue"]]);
});

test("questions queue; a cancelled one is dropped", () => {
  const s = setup();
  s.p.enqueue({ ...Q, question: "first" }, 1);
  s.p.enqueue({ ...Q, question: "second" }, 2);
  s.p.enqueue({ ...Q, question: "third" }, 3);
  s.p.dropped(2);
  s.keys("1", "\r");
  assert.match(s.printed.at(-2) ?? "", /→ You answered: red/);
  assert.match(s.printed.at(-1) ?? "", /^\? third/);
  s.p.dropped(3);
  assert.match(s.printed.at(-1) ?? "", /The question was cancelled/);
  assert.equal(s.p.active, false);
  assert.deepEqual(s.answers, [[1, "red"]]);
});

test("without an engine to answer, the question is dropped with a note", () => {
  const s = setup(false);
  s.p.enqueue(Q, 1);
  s.keys("1", "\r");
  assert.equal(s.answers.length, 0);
  assert.equal(s.p.active, false);
  assert.match(s.printed.at(-1) ?? "", /Can't answer this question/);
});
