import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRisk,
  buildExitOptions,
  completePeriod,
  parseUnstakeEvidence,
} from "./risk-engine.mjs";

test("completePeriod excludes the current partial day", () => {
  const daily = Array.from({ length: 15 }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    stakeUsdAtCurrentPrice: index < 7 ? 100 : 200,
    newWallets: index < 7 ? 10 : 20,
    unstakeUsdAtCurrentPrice: 0,
  }));
  const period = completePeriod(daily, "2026-08-15", 7);
  assert.equal(period.complete, true);
  assert.equal(period.inflowRatio, 2);
  assert.equal(period.newWalletRatio, 2);
  assert.equal(period.recentRange[1], "2026-08-14");
});

test("parseUnstakeEvidence decodes the fee ratio from an FDAO event", () => {
  const hex = (value) => BigInt(value).toString(16).padStart(64, "0");
  const receipt = {
    transactionHash: "0xtx",
    logs: [
      {
        address: "0xC5424Eb1061bD9e147788c527c95ac27710bFA41",
        topics: [
          "0x9d4ddcf7be95a56327247eeb36efb79783c00d13defcd5a572d1e3e0d8bf57d5",
          "0x" + "0".repeat(24) + "1".repeat(40),
        ],
        data:
          "0x" +
          hex(1000n * 10n ** 18n) +
          hex(90) +
          hex(2000n * 10n ** 18n) +
          hex(200n * 10n ** 18n) +
          hex(1234),
      },
    ],
  };
  const [event] = parseUnstakeEvidence([receipt]);
  assert.equal(event.releaseDays, 90);
  assert.equal(event.grossSentis, 2000);
  assert.equal(event.feeSentis, 200);
  assert.equal(event.synoxAmount, 0);
  assert.equal(event.feeRate, 0.1);
});

test("parseUnstakeEvidence keeps the extra Synox amount in six-word events", () => {
  const hex = (value) => BigInt(value).toString(16).padStart(64, "0");
  const receipt = {
    transactionHash: "0xsynox",
    logs: [
      {
        address: "0xC5424Eb1061bD9e147788c527c95ac27710bFA41",
        topics: [
          "0x7baf0db25f935f5cb985caf351c40c4ecfd6a3b4ee3c8e3360183b8f051ed97e",
          "0x" + "0".repeat(24) + "2".repeat(40),
        ],
        data:
          "0x" +
          hex(1n * 10n ** 18n) +
          hex(30) +
          hex(10n * 10n ** 18n) +
          hex(3n * 10n ** 18n) +
          hex(25n * 10n ** 16n) +
          hex(1234),
      },
    ],
  };
  const [event] = parseUnstakeEvidence([receipt]);
  assert.equal(event.synoxAmount, 0.25);
  assert.equal(event.timestamp, 1234);
});

test("buildExitOptions values the returned LP and subtracts the separate SENTIS fee", () => {
  const [option] = buildExitOptions({
    feeQuotes: [{ days: 90, feeRate: 0.1, feeSentis: 100 }],
    stakedLp: 10,
    pairSupply: 100,
    poolLiquidityUsd: 1000,
    sentisUsd: 0.2,
    referenceCostUsd: 90,
  });
  assert.equal(option.currentLpValueUsd, 100);
  assert.equal(option.feeUsd, 20);
  assert.equal(option.currentEquivalentAfterFeeUsd, 80);
  assert.equal(option.pnlUsdVsReference, -10);
  assert.equal(option.breakEvenLpValueUsd, 110);
});

test("assessRisk becomes orange when two independent orange signals exist", () => {
  const assessment = assessRisk({
    custodyCoverage: 0.83,
    period7: {
      inflowRatio: 1.1,
      newWalletRatio: 0.95,
      recentAvgInflowUsd: 95,
    },
    rewardHighUsd: 100,
    cumulativeExitRatio: 0.01,
    relationshipAvailable: false,
  });
  assert.equal(assessment.level, "orange");
  assert.equal(
    assessment.signals.find((signal) => signal.id === "custody_coverage").level,
    "orange",
  );
  assert.equal(
    assessment.signals.find((signal) => signal.id === "high_reward_coverage")
      .level,
    "orange",
  );
});
