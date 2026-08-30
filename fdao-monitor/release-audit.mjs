import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA_DIR = "fdao-monitor/data";
const RELEASE = "0xd62c3c1faaf8940496a12f5f15c9d0c3bae56b62";
const PAIR = "0x4f49ad237a81ad403a88f34a12a8d1d53c2d7d89";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MY_INFOS = "0xc81a81d9";
const RELEASABLE = "0xa3f8eace";
const RELEASE_CALL = "0x86d1a69f";
const RELEASE_BACKFILL_SPAN = 250000;
const RELEASE_BACKFILL_SPAN_AFTER_HISTORY = 2000000;
const PUBLIC_RPC =
  process.env.BSC_PUBLIC_RPC_URL ||
  "https://bsc-dataseed-public.bnbchain.org";
const INDEXING_RPC = process.env.NODEREAL_RPC_URL || PUBLIC_RPC;
const HAS_INDEXING_RPC = Boolean(process.env.NODEREAL_RPC_URL);

const readJson = (name, fallback) => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, name), "utf8"),
    );
  } catch {
    return fallback;
  }
};
const writeJson = (name, value) =>
  fs.writeFileSync(
    path.join(DATA_DIR, name),
    JSON.stringify(value, null, 2) + "\n",
  );
const wordAddress = (address) =>
  "0".repeat(24) + address.toLowerCase().slice(2);
const topicAddress = (address) => "0x" + wordAddress(address);
const fromTopic = (topic) => "0x" + topic.slice(-40).toLowerCase();
const hex = (value) => "0x" + BigInt(value).toString(16);
const number = (value) => Number(BigInt(value || "0x0"));
const units = (value) => Number(BigInt(value || "0x0")) / 1e18;
const words = (data) => {
  const result = [];
  for (let offset = 2; offset < data.length; offset += 64) {
    result.push("0x" + data.slice(offset, offset + 64));
  }
  return result;
};

async function rpc(method, params, retries = 4, url = PUBLIC_RPC) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      return payload.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, 350 * (attempt + 1)),
      );
    }
  }
  throw lastError;
}

export function decodeMyInfos(raw) {
  const decoded = words(raw);
  return {
    releasableLp: units(decoded[0]),
    lockedLp: units(decoded[1]),
    releasedLp: units(decoded[2]),
  };
}

export function releaseBackfillSpan(historyState) {
  return historyState?.done
    ? RELEASE_BACKFILL_SPAN_AFTER_HISTORY
    : RELEASE_BACKFILL_SPAN;
}

async function walletState(wallet) {
  const argument = wordAddress(wallet);
  const [infoRaw, releasableRaw] = await Promise.all([
    rpc("eth_call", [
      { to: RELEASE, from: wallet, data: MY_INFOS + argument },
      "latest",
    ]),
    rpc("eth_call", [
      { to: RELEASE, from: wallet, data: RELEASABLE + argument },
      "latest",
    ]),
  ]);
  return {
    wallet,
    ...decodeMyInfos(infoRaw),
    releasableDirectLp: units(releasableRaw),
  };
}

async function blockTimestamp(blockNumber) {
  const block = await rpc("eth_getBlockByNumber", [hex(blockNumber), false]);
  return number(block.timestamp);
}

async function blockAt(timestamp, latestBlock) {
  let low = 100549415;
  let high = latestBlock;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleTimestamp = await blockTimestamp(middle);
    if (middleTimestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function scanReleaseTransfers(fromBlock, toBlock) {
  const transfers = [];
  for (let start = fromBlock; start <= toBlock; start += 50000) {
    const end = Math.min(toBlock, start + 49999);
    const logs = await rpc(
      "eth_getLogs",
      [
        {
          address: PAIR,
          fromBlock: hex(start),
          toBlock: hex(end),
          topics: [TRANSFER_TOPIC, topicAddress(RELEASE)],
        },
      ],
      4,
      INDEXING_RPC,
    );
    for (const log of logs) {
      const transaction = await rpc("eth_getTransactionByHash", [
        log.transactionHash,
      ]);
      const directReleaseCall =
        transaction?.to?.toLowerCase() === RELEASE &&
        transaction?.input?.toLowerCase().startsWith(RELEASE_CALL);
      transfers.push({
        id: `${log.transactionHash}:${log.logIndex}`,
        tx: log.transactionHash,
        block: number(log.blockNumber),
        from: RELEASE,
        to: fromTopic(log.topics[2]),
        lpAmount: units(log.data),
        directReleaseCall,
        caller: transaction?.from?.toLowerCase() || null,
      });
    }
  }
  const uniqueBlocks = [...new Set(transfers.map((item) => item.block))];
  const timestamps = new Map();
  for (const block of uniqueBlocks) {
    timestamps.set(block, await blockTimestamp(block));
  }
  return transfers.map((item) => ({
    ...item,
    timestamp: timestamps.get(item.block),
    isoTime: new Date(timestamps.get(item.block) * 1000).toISOString(),
  }));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cache = readJson("unstake-evidence-cache.json", {
    byTransaction: {},
  });
  const previous = readJson("release-audit.json", null);
  const historyState = readJson("history-state.json", { events: [] });
  const backfillSpan = releaseBackfillSpan(historyState);
  const events = Object.values(cache.byTransaction || {}).flat();
  const now = Math.floor(Date.now() / 1000);
  const wallets = [...new Set(events.map((event) => event.wallet))];
  const maturedEvents = events.filter(
    (event) =>
      Number(event.timestamp || 0) + Number(event.releaseDays || 0) * 86400 <=
      now,
  );
  const maturedWallets = [
    ...new Set(maturedEvents.map((event) => event.wallet)),
  ];
  const states = [];
  for (const wallet of wallets) states.push(await walletState(wallet));

  const latestBlock = number(await rpc("eth_blockNumber", []));
  let transferScan = {
    status: "not_started",
    fromBlock: null,
    throughBlock: latestBlock,
    transfers: [],
  };
  if (maturedEvents.length && HAS_INDEXING_RPC) {
    const observedUnstakeBlocks = (historyState.events || [])
      .filter((event) => event.kind === "unstake")
      .map((event) => Number(event.block))
      .filter(Number.isFinite);
    const earliestUnstakeTimestamp = Math.min(
      ...events.map((event) => Number(event.timestamp)),
    );
    // Vesting is linear and can become claimable during the selected period,
    // so the only safe lower bound is the earliest observed unstake itself.
    const floorBlock = observedUnstakeBlocks.length
      ? Math.min(...observedUnstakeBlocks)
      : await blockAt(earliestUnstakeTimestamp, latestBlock);
    const previousTransfers = previous?.transferScan?.transfers || [];
    const previousFrom = Number(previous?.transferScan?.fromBlock);
    const previousThrough = Number(previous?.transferScan?.throughBlock);
    const hasPreviousWindow =
      previousTransfers.length > 0 &&
      Number.isFinite(previousFrom) &&
      Number.isFinite(previousThrough);
    const ranges = [];
    if (hasPreviousWindow) {
      if (previousThrough < latestBlock) {
        ranges.push([previousThrough + 1, latestBlock]);
      }
      if (previousFrom > floorBlock) {
        ranges.push([
          Math.max(floorBlock, previousFrom - backfillSpan),
          previousFrom - 1,
        ]);
      }
    } else {
      ranges.push([
        Math.max(floorBlock, latestBlock - backfillSpan + 1),
        latestBlock,
      ]);
    }
    const newTransfers = [];
    for (const [from, to] of ranges) {
      if (from <= to) newTransfers.push(...(await scanReleaseTransfers(from, to)));
    }
    const byId = new Map(
      [...previousTransfers, ...newTransfers].map((item) => [
        item.id || `${item.tx}:${item.to}:${item.lpAmount}`,
        item,
      ]),
    );
    const transfers = [...byId.values()];
    const scannedFromBlock = Math.min(
      hasPreviousWindow ? previousFrom : latestBlock,
      ...ranges.map(([from]) => from),
    );
    transferScan = {
      status:
        scannedFromBlock <= floorBlock
          ? "complete_observed_unstake_window"
          : "backfilling_release_history",
      floorBlock,
      fromBlock: scannedFromBlock,
      throughBlock: latestBlock,
      backfillCoverage:
        latestBlock === floorBlock
          ? 1
          : (latestBlock - scannedFromBlock) / (latestBlock - floorBlock),
      transfers,
    };
  } else if (maturedEvents.length) {
    transferScan = previous?.transferScan
      ? {
          ...previous.transferScan,
          status: previous.transferScan.status,
          refreshStatus: "requires_indexing_rpc",
        }
      : { ...transferScan, status: "requires_indexing_rpc" };
  } else {
    transferScan.status = "no_matured_events_yet";
  }

  const confirmedReleaseTransfers = transferScan.transfers.filter(
    (item) => item.directReleaseCall,
  );
  const report = {
    updatedAt: new Date().toISOString(),
    chainScope: "BNB Smart Chain",
    contracts: {
      release: RELEASE,
      lockToken: PAIR,
      lockTokenType: "META/SENTIS LP",
    },
    mechanism: {
      chainConfirmed:
        "unStake transfers LP into the release contract. LP then vests progressively across the selected 30/60/90-day period; release() transfers the currently vested LP back, and the full amount is vested by the end of the period.",
      importantCorrection:
        "The SENTIS value in the unstake event is the fee valuation basis, not a fixed SENTIS payout.",
      burnTwoPercentStatus:
        "unresolved: frontend text claims a 2% burn, but it is not yet safe to model as a second final-payout deduction. LP, SENTIS fee transfers and Synox transfers are reported separately.",
    },
    summary: {
      decodedUnstakeEvents: events.length,
      auditedWallets: wallets.length,
      maturedEvents: maturedEvents.length,
      maturedWallets: maturedWallets.length,
      walletsWithReleasableLp: states.filter(
        (item) => item.releasableDirectLp > 0,
      ).length,
      releasableLp: states.reduce(
        (total, item) => total + item.releasableDirectLp,
        0,
      ),
      walletsWithReleasedLp: states.filter((item) => item.releasedLp > 0)
        .length,
      contractRecordedReleasedLp: states.reduce(
        (total, item) => total + item.releasedLp,
        0,
      ),
      confirmedReleaseTransfers: confirmedReleaseTransfers.length,
      confirmedReleasedLp: confirmedReleaseTransfers.reduce(
        (total, item) => total + item.lpAmount,
        0,
      ),
    },
    walletStates: states,
    transferScan,
  };
  writeJson("release-audit.json", report);
  console.log(JSON.stringify({ ok: true, ...report.summary, transferScan: transferScan.status }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
