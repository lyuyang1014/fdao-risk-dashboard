import assert from "node:assert/strict";
import test from "node:test";
import { storageAddress } from "./storage-relationship-probe.mjs";

test("storageAddress only decodes canonical address storage words", () => {
  assert.equal(
    storageAddress(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
    ),
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(storageAddress("0x01"), null);
  assert.equal(storageAddress("0x" + "0".repeat(64)), null);
});
