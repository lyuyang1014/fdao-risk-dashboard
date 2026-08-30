import fs from "node:fs";
import path from "node:path";
const D = "fdao-monitor/data",
  A = "0xc5424eb1061bd9e147788c527c95ac27710bfa41",
  CONTRACT_DEPLOYMENT_BLOCK = 100549415,
  BACKFILL_SPAN = 500000,
  RPC = process.env.NODEREAL_RPC_URL;
if (!RPC) throw Error("NODEREAL_RPC_URL is required");
fs.mkdirSync(D, { recursive: true });
const ST = [
    "0x3e451024d3d4ca4a6f8985802ef8887d16b5f1b2c495e5ace458437b21d18505",
    "0x05a5b88949c1b7e7b6f52ca8bb014e695c3f9bc8893e0f75a3699a1519507e5c",
    "0x95b92b7b8f8d5c56d72e536e955714d166392387f565da17b314fbb8e73280a1",
  ],
  UN = [
    "0x9d4ddcf7be95a56327247eeb36efb79783c00d13defcd5a572d1e3e0d8bf57d5",
    "0x7baf0db25f935f5cb985caf351c40c4ecfd6a3b4ee3c8e3360183b8f051ed97e",
    "0xc4915ee1bfb9fe5fca0991eeb563dea7da3fe05fb9265ffc22a49c16cc9ff58e",
  ],
  ALL = [...ST, ...UN],
  wait = (m) => new Promise((r) => setTimeout(r, m)),
  hx = (n) => "0x" + BigInt(n).toString(16),
  unit = (h) => Number(BigInt(h)) / 1e18,
  num = (h) => Number(BigInt(h)),
  words = (d) => {
    let s = d.slice(2),
      a = [];
    for (let i = 0; i < s.length; i += 64) a.push("0x" + s.slice(i, i + 64));
    return a;
  },
  who = (t) => "0x" + t.slice(-40).toLowerCase(),
  read = (f, x) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(D, f), "utf8"));
    } catch {
      return x;
    }
  },
  write = (f, x) =>
    fs.writeFileSync(path.join(D, f), JSON.stringify(x, null, 2) + "\n");
async function logs(from, to) {
  let out = [];
  for (let a = from; a <= to; a += 50000) {
    let b = Math.min(to, a + 49999),
      filter = { address: A, fromBlock: hx(a), toBlock: hx(b), topics: [ALL] },
      ok = false,
      last;
    for (let k = 0; k < 3; k++) {
      try {
        let r = await fetch(RPC, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getLogs",
              params: [filter],
            }),
          }),
          j = await r.json();
        if (j.error) throw Error(j.error.message);
        out.push(...j.result);
        ok = true;
        break;
      } catch (e) {
        last = e;
        await wait(1000 * (k + 1));
      }
    }
    if (!ok) throw last;
    await wait(300);
  }
  return out;
}
function parse(l) {
  let t = l.topics[0].toLowerCase(),
    w = words(l.data),
    u = who(l.topics[1]),
    id = l.transactionHash + ":" + l.logIndex,
    b = num(l.blockNumber);
  return ST.includes(t)
    ? {
        kind: "stake",
        id,
        user: u,
        block: b,
        lp: unit(w[0]),
        meta: unit(w[1]),
        ts: num(w.at(-1)),
        tx: l.transactionHash,
      }
    : {
        kind: "unstake",
        id,
        user: u,
        block: b,
        lp: unit(w[0]),
        rtype: num(w[1]),
        token: unit(w[2]),
        fee: unit(w[3]),
        synox: w.length >= 6 ? unit(w[4]) : 0,
        ts: num(w.at(-1)),
        tx: l.transactionHash,
      };
}
function date(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts * 1000));
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0),
  med = (a) => {
    if (!a.length) return 0;
    let b = [...a].sort((x, y) => x - y),
      m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  },
  sum = (a) => a.reduce((s, v) => s + v, 0),
  tier = (v) =>
    v < 1000
      ? "<$1k"
      : v < 3000
        ? "$1k–3k"
        : v < 10000
          ? "$3k–10k"
          : v < 30000
            ? "$10k–30k"
            : "≥$30k";
let cur = read("current.json", null);
if (!cur) throw Error("current missing");
let flowAudit = read("unstake-flow-audit.json", { eventOnlyTransactions: [] }),
  eventOnlyTransactions = new Set(
    (flowAudit.eventOnlyTransactions || []).map((row) => row.tx),
  );
let s = read("history-state.json", {
  cursor: cur.indexing.dayStartBlock - 1,
  floor: CONTRACT_DEPLOYMENT_BLOCK,
  events: [],
  done: false,
});
if (!s.source || s.source !== "nodereal") {
  s = {
    cursor: cur.indexing.dayStartBlock - 1,
    floor: CONTRACT_DEPLOYMENT_BLOCK,
    events: [],
    done: false,
    source: "nodereal",
  };
}
if (s.floor > CONTRACT_DEPLOYMENT_BLOCK) {
  s.floor = CONTRACT_DEPLOYMENT_BLOCK;
  s.done = false;
}
let ids = new Set(s.events.map((e) => e.id));
if (!s.done) {
  let to = s.cursor,
    from = Math.max(s.floor, to - BACKFILL_SPAN + 1),
    ls = await logs(from, to);
  for (let l of ls) {
    let e = parse(l);
    if (!ids.has(e.id)) {
      s.events.push(e);
      ids.add(e.id);
    }
  }
  s.cursor = from - 1;
  if (from <= s.floor) s.done = true;
}
let all = [...s.events],
  today = read("state.json", {});
for (let e of today.dayEvents || [])
  if (!all.some((x) => x.id === e.id)) all.push(e);
all.sort((a, b) => a.ts - b.ts);
let first = new Map();
for (let e of all)
  if (e.kind === "stake" && !first.has(e.user)) first.set(e.user, e.ts);
let p = Number(cur.market.metaPrice || 0),
  m = new Map(),
  wm = new Map();
for (let e of all) {
  let d = date(e.ts),
    x = m.get(d) || {
      date: d,
      w: new Set(),
      nw: new Set(),
      sc: 0,
      sm: 0,
      uc: 0,
      eoc: 0,
      ut: 0,
      stakes: [],
    };
  let w = wm.get(e.user) || {
    address: e.user,
    firstStakeTs: first.get(e.user) || null,
    stakeMeta: 0,
    stakeCount: 0,
    unstakeToken: 0,
    unstakeCount: 0,
    eventOnlyUnstakeCount: 0,
    lastTs: 0,
  };
  if (e.kind === "stake") {
    x.w.add(e.user);
    if (date(first.get(e.user)) === d) x.nw.add(e.user);
    x.sc++;
    x.sm += e.meta;
    x.stakes.push(e.meta * p);
    w.stakeMeta += e.meta;
    w.stakeCount++;
  } else {
    if (eventOnlyTransactions.has(e.tx)) {
      x.eoc++;
      w.eventOnlyUnstakeCount++;
    } else {
      x.uc++;
      x.ut += e.token;
      w.unstakeToken += e.token;
      w.unstakeCount++;
    }
  }
  w.lastTs = Math.max(w.lastTs, e.ts);
  wm.set(e.user, w);
  m.set(d, x);
}
let sentisPrice = Number(cur.market.sentisPrice || 0),
  daily = [...m.values()]
    .map((x) => ({
      date: x.date,
      stakeWallets: x.w.size,
      newWallets: x.nw.size,
      stakeCount: x.sc,
      stakeMeta: x.sm,
      stakeUsdAtCurrentPrice: x.sm * p,
      avgPerStakeWallet: x.w.size ? (x.sm * p) / x.w.size : 0,
      medianStakeTxUsd: med(x.stakes),
      unstakeCount: x.uc,
      eventOnlyUnstakeCount: x.eoc,
      unstakeToken: x.ut,
      unstakeUsdAtCurrentPrice: x.ut * sentisPrice,
      netUsdAtCurrentPrice: x.sm * p - x.ut * sentisPrice,
    }))
    .sort((a, b) => a.date.localeCompare(b.date)),
  completeDaily = daily.filter((x) => x.date !== cur.date),
  vs = completeDaily.map((x) => x.stakeUsdAtCurrentPrice),
  ws = completeDaily.map((x) => x.stakeWallets),
  l3 = avg(vs.slice(-3)),
  p3 = avg(vs.slice(-6, -3)),
  l7 = avg(vs.slice(-7)),
  p7 = avg(vs.slice(-14, -7)),
  wr = avg(ws.slice(-3)),
  wp = avg(ws.slice(-6, -3)),
  fr = p3 ? l3 / p3 : null,
  fr7 = p7 ? l7 / p7 : null,
  risk =
    fr7 == null
      ? "数据不足"
      : fr7 < 0.7
        ? "红色：最近7个完整日新增资金较前7日下降30%以上"
        : fr7 < 0.9
          ? "黄色：新增资金动能明显放缓"
          : fr7 > 1.15
            ? "绿色：新增资金动能仍在增强"
            : "黄色：新增资金大致持平";
let wallets = [...wm.values()]
    .map((w) => {
      let stakeUsd = w.stakeMeta * p,
        unstakeUsd = w.unstakeToken * sentisPrice;
      return {
        address: w.address,
        firstStakeTs: w.firstStakeTs,
        firstStakeDate: w.firstStakeTs ? date(w.firstStakeTs) : null,
        stakeCount: w.stakeCount,
        unstakeCount: w.unstakeCount,
        eventOnlyUnstakeCount: w.eventOnlyUnstakeCount,
        stakeMeta: w.stakeMeta,
        stakeUsd,
        unstakeUsd,
        netUsd: stakeUsd - unstakeUsd,
        capitalTier: tier(stakeUsd),
        lastTs: w.lastTs,
      };
    })
    .sort((a, b) => b.stakeUsd - a.stakeUsd),
  totalStake = sum(wallets.map((w) => w.stakeUsd)),
  tierNames = ["<$1k", "$1k–3k", "$3k–10k", "$10k–30k", "≥$30k"],
  tiers = tierNames.map((name) => {
    let a = wallets.filter((w) => w.capitalTier === name);
    return {
      name,
      wallets: a.length,
      capitalUsd: sum(a.map((w) => w.stakeUsd)),
      share: totalStake ? sum(a.map((w) => w.stakeUsd)) / totalStake : 0,
    };
  }),
  topShare = (n) =>
    totalStake
      ? sum(wallets.slice(0, n).map((w) => w.stakeUsd)) / totalStake
      : 0,
  now = Math.floor(Date.now() / 1000),
  DAY = 86400;
function ageCohort(days) {
  let a = wallets.filter(
    (w) => w.firstStakeTs && w.firstStakeTs <= now - days * DAY,
  );
  return {
    days,
    wallets: a.length,
    capitalUsd: sum(a.map((w) => w.stakeUsd)),
  };
}
let walletAgeCohorts = {
  atLeast30Days: ageCohort(30),
  atLeast60Days: ageCohort(60),
  atLeast90Days: ageCohort(90),
  note: "钱包年龄仅描述持有时间，不代表解押费率资格。30/60/90是用户选择的释放方案。",
};
let walletOut = {
  updatedAt: new Date().toISOString(),
  coverage: Math.max(
    0,
    Math.min(
      1,
      (cur.indexing.dayStartBlock - s.cursor) /
        (cur.indexing.dayStartBlock - s.floor),
    ),
  ),
  backfillDone: s.done,
  note: "资金层级仅按累计质押金额分组，不等同于FDAO官方V级会员。钱包年龄不代表解押费率资格。",
  summary: {
    wallets: wallets.length,
    totalStakeUsd: totalStake,
    avgStakeUsd: wallets.length ? totalStake / wallets.length : 0,
    medianStakeUsd: med(wallets.map((w) => w.stakeUsd)),
    top10Share: topShare(10),
    top50Share: topShare(50),
    top100Share: topShare(100),
  },
  capitalTiers: tiers,
  walletAgeCohorts,
  topWallets: wallets.slice(0, 100),
};
let out = {
  updatedAt: new Date().toISOString(),
  source: "NodeReal BSC eth_getLogs",
  backfillDone: s.done,
  coverage: walletOut.coverage,
  firstObservedDate: daily[0]?.date || null,
  firstObservedBlock: all[0]?.block || null,
  firstObservedTransaction: all[0]?.tx || null,
  contractDeploymentBlock: CONTRACT_DEPLOYMENT_BLOCK,
  totalObservedStakeWallets: new Set(
    all.filter((e) => e.kind === "stake").map((e) => e.user),
  ).size,
  trend: {
    last3AvgStakeUsd: l3,
    previous3AvgStakeUsd: p3,
    flowRatio: fr,
    last7AvgStakeUsd: l7,
    previous7AvgStakeUsd: p7,
    full7FlowRatio: fr7,
    last3AvgWallets: wr,
    previous3AvgWallets: wp,
    walletRatio: wp ? wr / wp : null,
    excludesCurrentPartialDay: true,
    risk,
  },
  daily,
};
write("history-state.json", s);
write("history-daily.json", out);
write("wallet-analytics.json", walletOut);
console.log(
  JSON.stringify(
    {
      ok: true,
      source: out.source,
      cursor: s.cursor,
      done: s.done,
      coverage: out.coverage,
      events: all.length,
      days: daily.length,
      wallets: wallets.length,
      risk,
    },
    null,
    2,
  ),
);
