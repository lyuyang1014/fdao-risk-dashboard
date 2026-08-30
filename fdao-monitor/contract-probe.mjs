import fs from "node:fs";
const RPC =
  process.env.BSC_PUBLIC_RPC_URL ||
  "https://bsc-dataseed-public.bnbchain.org";
const PROXY = "0xC5424Eb1061bD9e147788c527c95ac27710bFA41";
const BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
async function rpc(method, params) {
  let r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let j = await r.json();
  if (j.error) throw Error(j.error.message);
  return j.result;
}
async function sig(sel) {
  try {
    let j = await (
      await fetch(
        "https://www.4byte.directory/api/v1/signatures/?hex_signature=" + sel,
      )
    ).json();
    return (j.results || []).slice(0, 8).map((x) => x.text_signature);
  } catch {
    return [];
  }
}
function selectors(code) {
  let s = code.slice(2),
    set = new Set();
  for (let i = 0; i < s.length - 10; i += 2)
    if (s.slice(i, i + 2) === "63") set.add("0x" + s.slice(i + 2, i + 10));
  return [...set];
}
async function inspect(a, role) {
  let code = await rpc("eth_getCode", [a, "latest"]),
    sels = selectors(code),
    mapped = [];
  for (let x of sels) {
    let names = await sig(x);
    if (names.length) mapped.push({ selector: x, signatures: names });
  }
  return {
    role,
    address: a,
    bytecodeBytes: (code.length - 2) / 2,
    selectors: mapped,
  };
}
async function frontend() {
  let out = { ok: false, assets: [], hits: [] };
  try {
    let r = await fetch("https://fdao.io/"),
      html = await r.text();
    out.ok = r.ok;
    let urls = [
      ...html.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/g),
    ].map((m) => new URL(m[1], "https://fdao.io/").href);
    out.assets = urls;
    let re =
      /(userInfo|userLevel|level|rank|vip|invite|inviter|referrer|referral|recommend|team|performance|upline|parent|children|directUser|teamAmount|teamStake|贡献|等级|推荐|团队|业绩|直推)/gi;
    for (let u of urls.slice(0, 30)) {
      try {
        let t = await (await fetch(u)).text();
        let m,
          n = 0;
        while ((m = re.exec(t)) && n < 160) {
          out.hits.push({
            asset: u,
            keyword: m[0],
            context: t.slice(
              Math.max(0, m.index - 220),
              Math.min(t.length, m.index + 420),
            ),
          });
          n++;
        }
      } catch {}
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
const beaconRaw = await rpc("eth_getStorageAt", [PROXY, BEACON_SLOT, "latest"]);
const beacon = "0x" + beaconRaw.slice(-40);
const implementationRaw = await rpc("eth_call", [
  { to: beacon, data: "0x5c60da1b" },
  "latest",
]);
const implementation = "0x" + implementationRaw.slice(-40);
const beaconOwnerRaw = await rpc("eth_call", [
  { to: beacon, data: "0x8da5cb5b" },
  "latest",
]);
const beaconOwner = "0x" + beaconOwnerRaw.slice(-40);
let contracts = [
  await inspect(PROXY, "proxy"),
  await inspect(beacon, "upgradeable-beacon"),
  await inspect(implementation, "implementation"),
  await inspect("0x238a358808379702088667322f80aC48bAd5e6c4", "swap/router"),
];
let knownTx = await rpc("eth_getTransactionByHash", [
  "0x34637cca993eab690939bd8692d6ee0db64abd6e5ecea9e9ac523db22d87778a",
]);
let out = {
  updatedAt: new Date().toISOString(),
  proxy: PROXY,
  beacon,
  beaconOwner,
  implementation,
  knownUserStakeTx: {
    from: knownTx?.from,
    to: knownTx?.to,
    input: knownTx?.input,
  },
  contracts,
  frontend: await frontend(),
  trainingRules: {
    V1: { self: 2000, team: 20000, rate: 0.1 },
    V2: { self: 4000, team: 60000, rate: 0.2 },
    V3: { self: 8000, team: 200000, rate: 0.3 },
    V4: { self: 15000, team: 600000, rate: 0.4 },
    V5: { self: 30000, team: 2000000, rate: 0.5 },
    V6: { self: 40000, team: 6000000, rate: 0.6 },
    V7: { self: 50000, team: 20000000, rate: 0.7 },
    V8: { self: 60000, requires: "two V7 legs", rate: 0.8 },
    V9: { self: 80000, requires: "two V8 legs", rate: 0.9 },
    directReferral:
      "5 valid direct users; direct stake reward 10%; training material also says single-account LP self stake >2000",
  },
  note: "The proxy is an ERC-1967 beacon proxy. The implementation is read from the beacon, not by calling implementation() on the proxy. Training rules are transcribed from user-provided material; selector names remain candidates until confirmed against frontend calls or chain behavior.",
};
fs.mkdirSync("fdao-monitor/data", { recursive: true });
fs.writeFileSync(
  "fdao-monitor/data/contract-probe.json",
  JSON.stringify(out, null, 2),
);
console.log(
  JSON.stringify(
    {
      ok: true,
      beacon,
      beaconOwner,
      implementation,
      implBytes: contracts[2].bytecodeBytes,
      implSelectors: contracts[2].selectors.length,
      frontendAssets: out.frontend.assets.length,
      frontendHits: out.frontend.hits.length,
      knownTxSelector: knownTx?.input?.slice(0, 10),
    },
    null,
    2,
  ),
);
