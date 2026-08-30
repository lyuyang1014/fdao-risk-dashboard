import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA_DIR = "fdao-monitor/data";
const FDAO = "0xc5424eb1061bd9e147788c527c95ac27710bfa41";
const USER = "0x0e39420fcdb05c5378c7d1f955dc546b5f5a85b6";
const VIEW_STAKING_INFO = "0xb46fb85f";
const METHODOLOGY_VERSION = 1;
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

async function rpc(method, params) {
  let lastError;
  for (const url of RPCS) {
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
    }
  }
  throw lastError;
}

async function storageValues(requests) {
  const values = new Map();
  for (let start = 0; start < requests.length; start += 20) {
    const chunk = requests.slice(start, start + 20);
    const unresolved = new Set(chunk.map((_, index) => index));
    for (const url of RPCS) {
      if (!unresolved.size) break;
      try {
        const payload = [...unresolved].map((index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method: "eth_getStorageAt",
          params: [chunk[index].contract, chunk[index].key, "latest"],
        }));
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!Array.isArray(result)) continue;
        for (const item of result) {
          if (item?.result == null) continue;
          const index = item.id - 1;
          values.set(requests.indexOf(chunk[index]), item.result);
          unresolved.delete(index);
        }
      } catch {}
    }
  }
  return values;
}

export function storageAddress(value) {
  if (!/^0x[0-9a-f]{64}$/i.test(value || "")) return null;
  const body = value.slice(2).toLowerCase();
  if (!/^0{24}/.test(body)) return null;
  const address = "0x" + body.slice(-40);
  return /^0x0{40}$/.test(address) ? null : address;
}

async function inspectWallet(wallet, knownWallets) {
  const access = await rpc("eth_createAccessList", [
    {
      to: FDAO,
      from: wallet,
      data: VIEW_STAKING_INFO,
      gasPrice: "0x0",
    },
    "latest",
  ]);
  const requests = [];
  for (const entry of access.accessList || []) {
    for (const key of entry.storageKeys || []) {
      requests.push({ contract: entry.address.toLowerCase(), key });
    }
  }
  const values = await storageValues(requests);
  const knownParticipantMatches = [];
  const addressLikeValues = [];
  for (let index = 0; index < requests.length; index++) {
    const value = values.get(index);
    const address = storageAddress(value);
    if (!address) continue;
    const row = { ...requests[index], address };
    if (knownWallets.has(address) && address !== wallet) {
      knownParticipantMatches.push(row);
    } else if (!address.startsWith("0x00")) {
      addressLikeValues.push(row);
    }
  }
  const proxyKeys = (access.accessList || [])
    .find((entry) => entry.address.toLowerCase() === FDAO)
    ?.storageKeys.map((key) => key.toLowerCase()) || [];
  return {
    wallet,
    gasUsed: access.gasUsed,
    accessedContracts: (access.accessList || []).length,
    accessedStorageKeys: requests.length,
    proxyStorageKeys: proxyKeys,
    knownParticipantMatches,
    addressLikeValues: [
      ...new Map(
        addressLikeValues.map((row) => [
          `${row.contract}:${row.key}:${row.address}`,
          row,
        ]),
      ).values(),
    ],
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = readJson("storage-relationship-probe.json", null);
  const freshEnough =
    existing?.methodologyVersion === METHODOLOGY_VERSION &&
    Date.now() - Date.parse(existing.updatedAt) < 24 * 3600 * 1000;
  if (freshEnough && process.env.FORCE_STORAGE_PROBE !== "1") {
    console.log(JSON.stringify({ ok: true, cached: true, ...existing.summary }, null, 2));
    return;
  }
  const history = readJson("history-state.json", { events: [] });
  const walletAnalytics = readJson("wallet-analytics.json", { topWallets: [] });
  const knownWallets = new Set(
    (history.events || [])
      .filter((event) => event.kind === "stake")
      .map((event) => event.user),
  );
  const sampleWallets = [
    USER,
    "0x60eee684db86c1e429669aa9e5f13531636777bf",
    "0xdbbda1f4cdcea8434bfa2b0d1b3ef8d4563e24b6",
    ...(walletAnalytics.topWallets || []).slice(0, 7).map((row) => row.address),
  ].filter((wallet, index, all) => wallet && all.indexOf(wallet) === index);
  const wallets = [];
  for (const wallet of sampleWallets) {
    wallets.push(await inspectWallet(wallet, knownWallets));
  }
  const commonProxyKeys = wallets.length
    ? wallets[0].proxyStorageKeys.filter((key) =>
        wallets.every((row) => row.proxyStorageKeys.includes(key)),
      )
    : [];
  const knownMatches = wallets.flatMap((row) =>
    row.knownParticipantMatches.map((match) => ({
      sourceWallet: row.wallet,
      ...match,
    })),
  );
  const report = {
    updatedAt: new Date().toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
    method:
      "eth_createAccessList was used to enumerate storage actually read by viewStakingInfo() for each sampled wallet; each value was then checked against every observed staking wallet address.",
    summary: {
      sampledWallets: wallets.length,
      knownStakingWallets: knownWallets.size,
      accessedStorageKeys: wallets.reduce(
        (sum, row) => sum + row.accessedStorageKeys,
        0,
      ),
      commonProxyStorageKeys: commonProxyKeys.length,
      variableProxyStorageKeys: new Set(
        wallets.flatMap((row) => row.proxyStorageKeys),
      ).size - commonProxyKeys.length,
      knownParticipantAddressMatches: knownMatches.length,
    },
    knownParticipantAddressMatches: knownMatches,
    wallets: wallets.map((row) => ({
      wallet: row.wallet,
      gasUsed: row.gasUsed,
      accessedContracts: row.accessedContracts,
      accessedStorageKeys: row.accessedStorageKeys,
      proxyStorageKeys: row.proxyStorageKeys.length,
      knownParticipantMatches: row.knownParticipantMatches,
      addressLikeValues: row.addressLikeValues,
    })),
    conclusion: knownMatches.length
      ? "Candidate cross-wallet address values were found and require transaction-level validation before any parent-child edge is accepted."
      : "No storage value read by viewStakingInfo() for the sampled wallets equals another observed staking wallet. This is evidence against a public on-chain parent field in the staking read path, not proof that no off-chain referral database exists.",
  };
  writeJson("storage-relationship-probe.json", report);
  console.log(JSON.stringify({ ok: true, ...report.summary }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
