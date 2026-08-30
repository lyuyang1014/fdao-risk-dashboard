import test from "node:test";
import assert from "node:assert/strict";
import { compareAtSameAge, decodeReserves } from "./peer-comparison.mjs";

function reserveData(first, second) {
  return `0x${BigInt(first).toString(16).padStart(64, "0")}${BigInt(second).toString(16).padStart(64, "0")}${"0".repeat(64)}`;
}

test("decodeReserves respects pair token order", () => {
  const raw = reserveData(2n * 10n ** 18n, 6n * 10n ** 18n);
  assert.deepEqual(decodeReserves(raw, "token-sentis"), {
    tokenReserve: 2,
    sentisReserve: 6,
    priceSentis: 3,
    liquiditySentis: 12,
  });
  assert.equal(decodeReserves(raw, "sentis-token").priceSentis, 1 / 3);
});

test("compareAtSameAge calculates return and liquidity growth", () => {
  const result = compareAtSameAge([
    { day: 1, priceSentis: 2, liquiditySentis: 10 },
    { day: 43, priceSentis: 5, liquiditySentis: 30 },
  ]);
  assert.equal(result.days, 43);
  assert.equal(result.priceReturn, 1.5);
  assert.equal(result.liquidityGrowth, 2);
});
