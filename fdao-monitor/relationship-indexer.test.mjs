import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBehaviorClusters,
  buildTeamMetrics,
  findAddressWords,
} from "./relationship-indexer.mjs";

test("findAddressWords only accepts known participating wallets", () => {
  const parent = "0x1111111111111111111111111111111111111111";
  const input =
    "0x12345678" +
    "0000000000000000000000001111111111111111111111111111111111111111" +
    "00000000000000000000000000000000000000000000000000000000000003e8";
  assert.deepEqual(
    findAddressWords(
      input,
      new Set([parent]),
      "0x2222222222222222222222222222222222222222",
    ),
    [{ wordIndex: 0, address: parent }],
  );
});

test("behavior clusters keep same-block evidence separate from parent edges", () => {
  const facts = [
    { user: "0x1", block: 10, ts: 1000, meta: 500 },
    { user: "0x2", block: 10, ts: 1001, meta: 600 },
    { user: "0x3", block: 11, ts: 1002, meta: 700 },
  ];
  const clusters = buildBehaviorClusters(facts);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].type, "same_block");
  assert.equal(clusters[0].walletCount, 2);
});

test("team metrics are only built from unique A/B parent edges", () => {
  const metrics = buildTeamMetrics(
    [
      { child: "child-1", parent: "leader", grade: "B" },
      { child: "child-2", parent: "child-1", grade: "A" },
      { child: "child-2", parent: "wrong", grade: "B" },
    ],
    new Map([
      ["leader", 100],
      ["child-1", 200],
      ["child-2", 300],
    ]),
  );
  assert.equal(metrics.available, true);
  assert.equal(metrics.confirmedParentEdges, 2);
  assert.equal(metrics.rootTeams[0].leader, "leader");
  assert.equal(metrics.rootTeams[0].teamWallets, 2);
  assert.equal(metrics.rootTeams[0].teamStakeUsd, 500);
  assert.equal(metrics.rootTeams[0].largestLegs[0].stakeUsd, 500);
});
