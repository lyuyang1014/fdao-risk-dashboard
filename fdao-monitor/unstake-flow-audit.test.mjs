import assert from "node:assert/strict";
import test from "node:test";
import { classifyTransfer } from "./unstake-flow-audit.mjs";

test("classifyTransfer identifies a direct META burn", () => {
  const transfer = classifyTransfer({
    address: "0x98f0421fcb5129b352cc35c1ed15ae9081deb700",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x" + "0".repeat(24) + "1".repeat(40),
      "0x" + "0".repeat(60) + "dead",
    ],
    data: "0x" + (2n * 10n ** 18n).toString(16),
  });
  assert.equal(transfer.isDirectMetaBurn, true);
  assert.equal(transfer.amount, 2);
});
