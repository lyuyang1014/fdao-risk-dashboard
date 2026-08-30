import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA_DIR = "fdao-monitor/data";
const FDAO = "0xc5424eb1061bd9e147788c527c95ac27710bfa41";
const SENTIS = "0x8fd0d741e09a98e82256c63f25f90301ea71a83e";
const META = "0x98f0421fcb5129b352cc35c1ed15ae9081deb700";
const LP = "0x4f49ad237a81ad403a88f34a12a8d1d53c2d7d89";
const SYN0X = "0x8e73501feb043c31d1c04d236e4712d9c7400391";
const RELEASE = "0xd62c3c1faaf8940496a12f5f15c9d0c3bae56b62";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x000000000000000000000000000000000000dead",
]);
const RPCS = [
  process.env.BSC_PUBLIC_RPC_URL,
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed-public.bnbchain.org",
  "https://bsc-dataseed.binance.org",
  "https://bsc-rpc.publicnode.com",
].filter(Boolean);

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
const address = (topic) => "0x" + topic.slice(-40).toLowerCase();
const units = (value) => Number(BigInt(value || "0x0")) / 1e18;
const sum = (values) => values.reduce((total, value) => total + value, 0);

async function hashBatch(transactionHashes, method) {
  const result = new Map();
  for (let start = 0; start < transactionHashes.length; start += 20) {
    const hashes = transactionHashes.slice(start, start + 20);
    const unresolved = new Set(hashes.map((_, index) => index));
    for (const url of RPCS) {
      if (!unresolved.size) break;
      try {
        const requests = [...unresolved].map((index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method,
          params: [hashes[index]],
        }));
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requests),
        });
        const payload = await response.json();
        if (!Array.isArray(payload)) continue;
        for (const item of payload) {
          if (!item?.result) continue;
          result.set(hashes[item.id - 1], item.result);
          unresolved.delete(item.id - 1);
        }
      } catch {}
    }
  }
  return result;
}

export function classifyTransfer(log) {
  if (
    log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    log.topics.length < 3
  ) {
    return null;
  }
  const token = log.address.toLowerCase();
  const from = address(log.topics[1]);
  const to = address(log.topics[2]);
  const amount = units(log.data);
  return {
    token,
    from,
    to,
    amount,
    isDirectMetaBurn: token === META && BURN_ADDRESSES.has(to),
    isLpLock: token === LP && from === FDAO && to === RELEASE,
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const evidence = readJson("unstake-evidence-cache.json", {
    byTransaction: {},
  });
  const transactionHashes = Object.keys(evidence.byTransaction || {});
  const [receipts, transactions] = await Promise.all([
    hashBatch(transactionHashes, "eth_getTransactionReceipt"),
    hashBatch(transactionHashes, "eth_getTransactionByHash"),
  ]);
  const rows = [];
  for (const transactionHash of transactionHashes) {
    const events = evidence.byTransaction[transactionHash] || [];
    const receipt = receipts.get(transactionHash);
    const transaction = transactions.get(transactionHash);
    if (!receipt) continue;
    const transfers = (receipt.logs || [])
      .map(classifyTransfer)
      .filter(Boolean);
    const wallets = new Set(events.map((event) => event.wallet));
    const sentisFees = transfers.filter(
      (transfer) => transfer.token === SENTIS && wallets.has(transfer.from),
    );
    const metaBurns = transfers.filter((transfer) => transfer.isDirectMetaBurn);
    const metaTransfers = transfers.filter((transfer) => transfer.token === META);
    const lpLocks = transfers.filter((transfer) => transfer.isLpLock);
    const synoxTransfers = transfers.filter(
      (transfer) =>
        transfer.token === SYN0X && wallets.has(transfer.to),
    );
    rows.push({
      tx: transactionHash,
      txFrom: transaction?.from?.toLowerCase() || null,
      selector: transaction?.input?.slice(0, 10)?.toLowerCase() || null,
      wallets: [...wallets],
      releaseDays: [...new Set(events.map((event) => event.releaseDays))],
      eventLp: sum(events.map((event) => Number(event.lpAmount || 0))),
      eventFeeSentis: sum(events.map((event) => Number(event.feeSentis || 0))),
      eventGrossSentis: sum(
        events.map((event) => Number(event.grossSentis || 0)),
      ),
      sentisFeeTransfers: sentisFees,
      sentisFeeTransferred: sum(sentisFees.map((transfer) => transfer.amount)),
      lpLocked: sum(lpLocks.map((transfer) => transfer.amount)),
      directMetaBurned: sum(metaBurns.map((transfer) => transfer.amount)),
      metaTransfers,
      synoxTransferred: sum(synoxTransfers.map((transfer) => transfer.amount)),
    });
  }
  const directMetaBurned = sum(rows.map((row) => row.directMetaBurned));
  const fundMovingRows = rows.filter(
    (row) => row.lpLocked > 0 || row.sentisFeeTransferred > 0,
  );
  const eventOnlyRows = rows.filter(
    (row) => row.lpLocked === 0 && row.sentisFeeTransferred === 0,
  );
  const report = {
    updatedAt: new Date().toISOString(),
    methodologyVersion: 1,
    auditedTransactions: rows.length,
    expectedTransactions: transactionHashes.length,
    tokenAddresses: { SENTIS, META, LP, Synox: SYN0X, release: RELEASE },
    summary: {
      auditedTransactions: rows.length,
      fundMovingTransactions: fundMovingRows.length,
      eventOnlyTransactions: eventOnlyRows.length,
      eventLp: sum(rows.map((row) => row.eventLp)),
      lpLocked: sum(rows.map((row) => row.lpLocked)),
      fundMovingEventLp: sum(fundMovingRows.map((row) => row.eventLp)),
      eventOnlyEventLp: sum(eventOnlyRows.map((row) => row.eventLp)),
      fundMovingGrossSentis: sum(
        fundMovingRows.map((row) => row.eventGrossSentis),
      ),
      eventOnlyGrossSentis: sum(
        eventOnlyRows.map((row) => row.eventGrossSentis),
      ),
      eventFeeSentis: sum(rows.map((row) => row.eventFeeSentis)),
      sentisFeeTransferred: sum(
        rows.map((row) => row.sentisFeeTransferred),
      ),
      transactionsWithDirectMetaTransfer: rows.filter(
        (row) => row.metaTransfers.length,
      ).length,
      transactionsWithDirectMetaBurn: rows.filter(
        (row) => row.directMetaBurned > 0,
      ).length,
      directMetaBurned,
      synoxTransferred: sum(rows.map((row) => row.synoxTransferred)),
    },
    burnClaimStatus: directMetaBurned
      ? "Direct META transfers to a burn address were found in unstake receipts."
      : "No direct META transfer to zero/0x1/dead appears in the audited unstake receipts. The frontend's 2% statement is therefore not modeled as an additional payout deduction; it may refer to token-internal accounting, a later operation or marketing wording that still needs separate proof.",
    eventOnlyTransactions: eventOnlyRows.map((row) => ({
      tx: row.tx,
      txFrom: row.txFrom,
      selector: row.selector,
      wallets: row.wallets,
      eventLp: row.eventLp,
      eventGrossSentis: row.eventGrossSentis,
      eventFeeSentis: row.eventFeeSentis,
    })),
    rows,
  };
  writeJson("unstake-flow-audit.json", report);
  console.log(JSON.stringify({ ok: true, ...report.summary }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
