import { test } from "node:test";
import assert from "node:assert/strict";
import { answerFor, mapUserInput, recommendedIndex } from "./questions";

test("mapUserInput keeps valid options and drops junk", () => {
  const q = mapUserInput({
    sessionId: "s",
    toolCallId: "t1",
    question: "**Pick one**",
    options: [
      { title: "red", description: "warm", recommended: true },
      { title: "" },
      null,
      { title: "blue", subOptionsLabel: "Shades", subOptions: [{ title: "light" }, { title: "" }, { title: "dark", description: "d" }] },
    ],
  });
  assert.deepEqual(q, {
    toolCallId: "t1",
    question: "**Pick one**",
    options: [
      { title: "red", description: "warm", recommended: true },
      { title: "blue", subOptionsLabel: "Shades", subOptions: [{ title: "light" }, { title: "dark", description: "d" }] },
    ],
  });
  assert.equal(recommendedIndex(q!), 0);
});

test("mapUserInput needs a question and tolerates missing options", () => {
  assert.equal(mapUserInput(undefined), undefined);
  assert.equal(mapUserInput({ question: "  " }), undefined);
  assert.deepEqual(mapUserInput({ question: "Why?" }), { toolCallId: "", question: "Why?", options: [] });
});

test("mapUserInput caps sizes", () => {
  const q = mapUserInput({ question: "x".repeat(20000), options: Array.from({ length: 100 }, (_, i) => ({ title: "o" + i })) });
  assert.equal(q?.question.length, 8000);
  assert.equal(q?.options.length, 30);
});

test("answerFor lists picked items only when the option has sub-options", () => {
  assert.equal(answerFor({ title: "red" }), "red");
  assert.equal(answerFor({ title: "blue", subOptions: [{ title: "a" }, { title: "b" }] }, ["a", "b"]), "blue [a, b]");
  assert.equal(answerFor({ title: "blue", subOptions: [{ title: "a" }] }, []), "blue []");
});

test("a question without a toolCallId gets the fallback id", () => {
  assert.equal(mapUserInput({ question: "q" }, "question-7")?.toolCallId, "question-7");
  assert.equal(mapUserInput({ question: "q", toolCallId: "t" }, "question-7")?.toolCallId, "t");
});
