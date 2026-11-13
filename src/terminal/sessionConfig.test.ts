import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionConfig } from "./sessionConfig";

test("merge keeps other settings, drops effort when the new model has none", () => {
  const c = new SessionConfig();
  c.merge([
    { id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "Model A" }] },
    { id: "effortLevel", name: "Effort", type: "select", currentValue: "high" },
    { id: "autopilot", name: "Autopilot", type: "select", currentValue: "on" },
  ]);
  assert.equal(c.autopilot, true);
  assert.equal(c.valueName(c.option("model")!), "Model A");
  c.merge([{ id: "autopilot", name: "Autopilot", type: "select", currentValue: "off" }]);
  assert.equal(c.autopilot, false);
  assert.ok(c.option("effortLevel"));
  c.merge([{ id: "model", name: "Model", type: "select", currentValue: "b" }]);
  assert.equal(c.option("effortLevel"), undefined);
  assert.equal(c.valueName(c.option("model")!), "b");
  c.clear();
  assert.equal(c.all.length, 0);
});
