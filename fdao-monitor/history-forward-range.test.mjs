import assert from "node:assert/strict";
import test from "node:test";
import {
  inferThroughBlock,
  nextForwardRange,
} from "./history-forward-range.mjs";

test("infers the forward cursor from the newest persisted event", () => {
  assert.equal(
    inferThroughBlock({ events: [{ block: 90 }, { block: 125 }] }),
    125,
  );
});

test("continues a completed history toward the previous day boundary", () => {
  assert.deepEqual(
    nextForwardRange({
      state: { done: true, throughBlock: 125 },
      targetBlock: 300,
      span: 100,
    }),
    { from: 126, to: 225 },
  );
});

test("does not scan forward before the initial backfill is complete", () => {
  assert.equal(
    nextForwardRange({
      state: { done: false, throughBlock: 125 },
      targetBlock: 300,
      span: 100,
    }),
    null,
  );
});
