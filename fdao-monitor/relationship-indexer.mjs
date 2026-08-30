import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA_DIR = "fdao-monitor/data";
const FDAO = "0xc5424eb1061bd9e147788c527c95ac27710bfa41";
const META = "0x98f0421fcb5129b352cc35c1ed15ae9081deb700";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPC =
  process.env.BSC_PUBLIC_RPC_URL || "https://bsc-dataseed-public.bnbchain.org";
const RUN_SIZE = Number(process.env.RELATIONSHIP_RUN_SIZE || 250);

const readJson = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (name, value) =>
  fs.writeFileSync(
    path.join(DATA_DIR, name),
    JSON.stringify(value, null, 2) + "\n",
  );

const addressFromWord = (word) => {
  const value = word.replace(/^0x/, "").toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) return null;
  const address = "0x" + value.slice(-40);
  return /^0x0{40}$/.test(address) ? null : address;
};

export function findAddressWords(input, knownWallets, self) {
  const body = (input || "0x").slice(10);
  const hits = [];
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const address = addressFromWord(body.slice(offset, offset + 64));
    if (address && address !== self && knownWallets.has(address)) {
      hits.push({ wordIndex: offset / 64, address });
    }
  }
  return hits;
}

const topicAddress = (topic) => addressFromWord(topic || "");
const units = (hex) => Number(BigInt(hex || "0x0")) / 1e18;

async function fetchFacts(entries, knownWallets) {
  const facts = [];
  for (let start = 0; start < entries.length; start += 20) {
    const chunk = entries.slice(start, start + 20);
    const requests = [];
    let id = 1;
    for (const entry of chunk) {
      requests.push(
        {
          jsonrpc: "2.0",
          id: id++,
          method: "eth_getTransactionByHash",
          params: [entry.tx],
        },
        {
          jsonrpc: "2.0",
          id: id++,
          method: "eth_getTransactionReceipt",
          params: [entry.tx],
        },
      );
    }
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests),
    });
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(`BSC batch RPC failed: ${JSON.stringify(payload)}`);
    }
    const byId = new Map(payload.map((item) => [item.id, item]));
    for (let index = 0; index < chunk.length; index++) {
      const entry = chunk[index];
      const tx = byId.get(index * 2 + 1)?.result;
      const receipt = byId.get(index * 2 + 2)?.result;
      if (!tx || !receipt) continue;
      const self = entry.user.toLowerCase();
      const directEventAddresses = [];
      const knownWalletTransfers = [];
      const receiptRecipients = new Set();
      for (const log of receipt.logs || []) {
        const contract = log.address.toLowerCase();
        if (contract === FDAO) {
          for (const topic of (log.topics || []).slice(1)) {
            const address = topicAddress(topic);
            if (address && address !== self && knownWallets.has(address)) {
              directEventAddresses.push(address);
            }
          }
        }
        if (log.topics?.[0] === TRANSFER_TOPIC && log.topics.length >= 3) {
          const from = topicAddress(log.topics[1]);
          const to = topicAddress(log.topics[2]);
          if (to) receiptRecipients.add(to);
          if (to && to !== self && knownWallets.has(to)) {
            knownWalletTransfers.push({
              token: contract,
              from,
              to,
              amount: units(log.data),
            });
          }
        }
      }
      facts.push({
        user: self,
        tx: entry.tx,
        block: entry.block,
        ts: entry.ts,
        lp: entry.lp,
        meta: entry.meta,
        selector: tx.input.slice(0, 10),
        inputBytes: (tx.input.length - 2) / 2,
        calldataAddressCandidates: findAddressWords(
          tx.input,
          knownWallets,
          self,
        ),
        directEventAddresses: [...new Set(directEventAddresses)],
        knownWalletTransfers,
        receiptRecipients: [...receiptRecipients],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return facts;
}

export function buildBehaviorClusters(facts) {
  const groups = new Map();
  const add = (key, type, fact, detail) => {
    const group = groups.get(key) || { id: key, type, detail, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  };
  for (const fact of facts) {
    add(`block:${fact.block}`, "same_block", fact, `同一区块 ${fact.block}`);
    const fiveMinutes = Math.floor(fact.ts / 300);
    const roundedMeta = Math.round(fact.meta * 100) / 100;
    add(
      `amount:${fiveMinutes}:${roundedMeta}`,
      "same_amount_window",
      fact,
      `5分钟内相同 META 数量 ${roundedMeta}`,
    );
  }
  return [...groups.values()]
    .filter((group) =>
      group.type === "same_block"
        ? group.facts.length >= 2
        : group.facts.length >= 3,
    )
    .map((group) => ({
      id: group.id,
      type: group.type,
      detail: group.detail,
      walletCount: new Set(group.facts.map((fact) => fact.user)).size,
      firstTs: Math.min(...group.facts.map((fact) => fact.ts)),
      lastTs: Math.max(...group.facts.map((fact) => fact.ts)),
      stakeMeta: group.facts.reduce((sum, fact) => sum + fact.meta, 0),
      wallets: [...new Set(group.facts.map((fact) => fact.user))].slice(0, 50),
    }))
    .sort(
      (left, right) =>
        right.walletCount - left.walletCount ||
        right.stakeMeta - left.stakeMeta,
    );
}

const edgeKey = (edge) => `${edge.child}:${edge.parent}:${edge.grade}`;

export function buildTeamMetrics(edges, stakeByWallet) {
  const candidates = new Map();
  for (const edge of edges) {
    const items = candidates.get(edge.child) || [];
    items.push(edge);
    candidates.set(edge.child, items);
  }
  const parentByChild = new Map();
  const conflicts = [];
  for (const [child, items] of candidates) {
    const bestGrade = items.some((item) => item.grade === "A") ? "A" : "B";
    const parents = [
      ...new Set(
        items
          .filter((item) => item.grade === bestGrade)
          .map((item) => item.parent),
      ),
    ];
    if (parents.length === 1 && parents[0] !== child) {
      parentByChild.set(child, parents[0]);
    } else {
      conflicts.push({ child, grade: bestGrade, parents });
    }
  }
  const childrenByParent = new Map();
  for (const [child, parent] of parentByChild) {
    const children = childrenByParent.get(parent) || [];
    children.push(child);
    childrenByParent.set(parent, children);
  }
  const descendants = (root, seen = new Set()) => {
    if (seen.has(root)) return new Set();
    seen.add(root);
    const result = new Set();
    for (const child of childrenByParent.get(root) || []) {
      result.add(child);
      for (const nested of descendants(child, seen)) result.add(nested);
    }
    return result;
  };
  const allKnown = new Set([
    ...stakeByWallet.keys(),
    ...parentByChild.keys(),
    ...parentByChild.values(),
  ]);
  const totalStakeUsd = [...allKnown].reduce(
    (sum, wallet) => sum + Number(stakeByWallet.get(wallet) || 0),
    0,
  );
  const rows = [...childrenByParent.keys()].map((leader) => {
    const team = descendants(leader);
    const branches = (childrenByParent.get(leader) || [])
      .map((child) => {
        const branch = descendants(child);
        branch.add(child);
        return {
          child,
          wallets: branch.size,
          stakeUsd: [...branch].reduce(
            (sum, wallet) => sum + Number(stakeByWallet.get(wallet) || 0),
            0,
          ),
        };
      })
      .sort((left, right) => right.stakeUsd - left.stakeUsd);
    return {
      leader,
      directChildren: (childrenByParent.get(leader) || []).length,
      teamWallets: team.size,
      teamStakeUsd: [...team].reduce(
        (sum, wallet) => sum + Number(stakeByWallet.get(wallet) || 0),
        0,
      ),
      largestLegs: branches.slice(0, 2),
    };
  });
  const roots = rows
    .filter((row) => !parentByChild.has(row.leader))
    .sort((left, right) => right.teamStakeUsd - left.teamStakeUsd);
  return {
    available: parentByChild.size > 0,
    confirmedParentEdges: parentByChild.size,
    conflicts,
    rootTeams: roots,
    topRootTeamsShare: totalStakeUsd
      ? roots.slice(0, 10).reduce((sum, row) => sum + row.teamStakeUsd, 0) /
        totalStakeUsd
      : null,
  };
}

function buildReport(state, universe, history, current) {
  const facts = state.facts;
  const recipientCounts = new Map();
  for (const fact of facts) {
    for (const recipient of fact.receiptRecipients) {
      recipientCounts.set(recipient, (recipientCounts.get(recipient) || 0) + 1);
    }
  }
  const fixedRecipients = new Set(
    [...recipientCounts]
      .filter(([, count]) => count >= Math.max(5, facts.length * 0.1))
      .map(([address]) => address),
  );
  const edges = [];
  for (const fact of facts) {
    for (const hit of fact.calldataAddressCandidates) {
      edges.push({
        child: fact.user,
        parent: hit.address,
        grade: "A",
        evidence: "calldata_address_field",
        tx: fact.tx,
        detail: `首入 calldata 第 ${hit.wordIndex + 1} 个参数为已参与钱包`,
      });
    }
    for (const parent of fact.directEventAddresses) {
      edges.push({
        child: fact.user,
        parent,
        grade: "A",
        evidence: "fdao_event_topic",
        tx: fact.tx,
        detail: "FDAO 首入事件 topic 直接出现另一参与钱包",
      });
    }
    for (const transfer of fact.knownWalletTransfers) {
      const ratio = fact.meta ? transfer.amount / fact.meta : 0;
      if (
        transfer.token === META &&
        !fixedRecipients.has(transfer.to) &&
        ratio >= 0.08 &&
        ratio <= 0.12
      ) {
        edges.push({
          child: fact.user,
          parent: transfer.to,
          grade: "B",
          evidence: "meta_reward_ratio",
          tx: fact.tx,
          detail: `首入同笔交易向该钱包转出 META，约为质押 META 的 ${(ratio * 100).toFixed(2)}%`,
        });
      }
    }
  }
  const dedupedEdges = [
    ...new Map(edges.map((edge) => [edgeKey(edge), edge])).values(),
  ];
  const patterns = new Map();
  for (const fact of facts) {
    const key = `${fact.selector}:${fact.inputBytes}`;
    const pattern = patterns.get(key) || {
      selector: fact.selector,
      inputBytes: fact.inputBytes,
      argumentWords: Math.max(0, (fact.inputBytes - 4) / 32),
      count: 0,
      addressFieldHits: 0,
    };
    pattern.count++;
    pattern.addressFieldHits += fact.calldataAddressCandidates.length;
    patterns.set(key, pattern);
  }
  const clusters = buildBehaviorClusters(facts);
  const metaPrice = Number(current.market?.metaPrice || 0);
  const stakeByWallet = new Map();
  for (const event of history.events || []) {
    if (event.kind !== "stake") continue;
    stakeByWallet.set(
      event.user,
      (stakeByWallet.get(event.user) || 0) +
        Number(event.meta || 0) * metaPrice,
    );
  }
  const selfRules = [
    ["V1", 2000],
    ["V2", 4000],
    ["V3", 8000],
    ["V4", 15000],
    ["V5", 30000],
    ["V6", 40000],
    ["V7", 50000],
    ["V8", 60000],
    ["V9", 80000],
  ].map(([level, selfUsd]) => ({
    level,
    selfUsd,
    walletsMeetingSelfThreshold: [...stakeByWallet.values()].filter(
      (value) => value >= selfUsd,
    ).length,
  }));
  const gradeA = dedupedEdges.filter((edge) => edge.grade === "A");
  const gradeB = dedupedEdges.filter((edge) => edge.grade === "B");
  const teamMetrics = buildTeamMetrics(dedupedEdges, stakeByWallet);
  return {
    updatedAt: new Date().toISOString(),
    coverage: universe.length ? facts.length / universe.length : 0,
    backfillDone: facts.length >= universe.length,
    relationshipStatus:
      gradeA.length || gradeB.length
        ? "partial_chain_relationships_found"
        : "referral_not_exposed_by_stake_contract",
    sources: {
      chain: "BNB Smart Chain transaction input and receipts",
      frontend:
        "fdao.io exposes /api/user/bind-code, /api/user/invite-records and /api/user/rank/:tokenId behind wallet login",
      contract:
        "The public staking ABI contains stake, unstake, price and reward functions but no referral getter.",
    },
    evidenceSummary: {
      totalFirstStakeWallets: universe.length,
      sampledFirstStakeTransactions: facts.length,
      calldataPatterns: [...patterns.values()].sort(
        (a, b) => b.count - a.count,
      ),
      gradeAConfirmedEdges: gradeA.length,
      gradeBRewardEdges: gradeB.length,
      gradeCBehaviorClusters: clusters.length,
      walletsInBehaviorClusters: new Set(
        clusters.flatMap((cluster) => cluster.wallets),
      ).size,
      fixedReceiptRecipients: [...fixedRecipients],
    },
    edges: dedupedEdges,
    behaviorClusters: clusters.slice(0, 100),
    levelDistribution: {
      available: false,
      reason:
        "V1–V9 requires the official parent-child tree, team performance and two-leg structure. These are not exposed by the staking calldata/events inspected so far.",
      selfThresholdsOnly: selfRules,
      warning:
        "Meeting the personal stake threshold does not mean the wallet has reached that official V level.",
    },
    teamMetrics: teamMetrics.available
      ? teamMetrics
      : {
          ...teamMetrics,
          reason:
            "No A/B-grade parent-child tree exists yet, so team size, team stake, two largest legs and top-team share would be misleading.",
        },
    conclusions: [
      "首入质押参数目前只有金额和质押类型，没有稳定的推荐人地址字段。",
      "首入回执中的资金接收方是固定合约、流动性池和销毁地址，尚未出现可唯一对应上级的10%奖励钱包。",
      "推荐绑定与邀请名单出现在项目方登录后的 API 中，说明组织树很可能主要保存在项目方后台。",
      "C级行为簇只能提示批量铺号或同一操盘批次，不能当成官方上下级关系。",
    ],
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const history = readJson("history-state.json", { events: [] });
  const current = readJson("current.json", { market: {} });
  const firstByWallet = new Map();
  for (const event of [...history.events]
    .filter((event) => event.kind === "stake")
    .sort((left, right) => left.ts - right.ts)) {
    if (!firstByWallet.has(event.user)) {
      firstByWallet.set(event.user, {
        ...event,
        tx: event.tx || event.id.split(":")[0],
      });
    }
  }
  const universe = [...firstByWallet.values()];
  const knownWallets = new Set(universe.map((entry) => entry.user));
  const state = readJson("relationship-state.json", {
    version: 1,
    cursor: 0,
    facts: [],
  });
  if (state.version !== 1 || state.cursor > universe.length) {
    state.version = 1;
    state.cursor = 0;
    state.facts = [];
  }
  const next = universe.slice(state.cursor, state.cursor + RUN_SIZE);
  if (next.length) {
    const fresh = await fetchFacts(next, knownWallets);
    const byUser = new Map(state.facts.map((fact) => [fact.user, fact]));
    for (const fact of fresh) byUser.set(fact.user, fact);
    state.facts = [...byUser.values()].sort((a, b) => a.ts - b.ts);
    state.cursor += next.length;
  }
  state.cursor = Math.min(state.cursor, universe.length);
  state.updatedAt = new Date().toISOString();
  const report = buildReport(state, universe, history, current);
  writeJson("relationship-state.json", state);
  writeJson("relationship-graph.json", report);
  console.log(
    JSON.stringify(
      {
        ok: true,
        processed: state.facts.length,
        total: universe.length,
        coverage: report.coverage,
        gradeA: report.evidenceSummary.gradeAConfirmedEdges,
        gradeB: report.evidenceSummary.gradeBRewardEdges,
        gradeCClusters: report.evidenceSummary.gradeCBehaviorClusters,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
