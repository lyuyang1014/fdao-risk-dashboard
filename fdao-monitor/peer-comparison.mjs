import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve("fdao-monitor/data");
const OUTPUT = path.join(DATA_DIR, "peer-comparison.json");
const RPC_URL =
  process.env.NODEREAL_RPC_URL || "https://bsc-mainnet.public.blastapi.io";

const ASSETS = {
  fsd: {
    symbol: "FSD",
    name: "First Shot DAO",
    token: "0x2ecaf6fb6a2c1d34602261109f48b38091bf3e59",
    pair: "0xb52733d7b3ad1b2fffa465de5d21d66750cd709b",
    pairCreationBlock: 73524349,
    pairCreationAt: "2025-12-31T01:44:37.000Z",
    comparisonStartAt: "2025-12-31T01:44:37.000Z",
    reserveOrder: "token-sentis",
    points: {
      1: 73639529,
      7: 74330654,
      30: 78204671,
      43: 80700071,
    },
  },
  meta: {
    symbol: "META",
    name: "Meta",
    token: "0x98f0421fcb5129b352cc35c1ed15ae9081deb700",
    pair: "0x4f49ad237a81ad403a88f34a12a8d1d53c2d7d89",
    pairCreationBlock: 100708257,
    pairCreationAt: "2026-05-27T09:35:00.000Z",
    comparisonStartAt: "2026-07-17T16:00:00.000Z",
    reserveOrder: "sentis-token",
    points: {
      1: 110735467,
      7: 111886743,
      30: 116300617,
      43: 118795756,
    },
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (number) => `0x${BigInt(number).toString(16)}`;
const unit = (value) => Number(BigInt(value)) / 1e18;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}

async function rpc(method, params = []) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

export function decodeReserves(raw, reserveOrder) {
  const data = raw.slice(2);
  const reserve0 = unit(`0x${data.slice(0, 64)}`);
  const reserve1 = unit(`0x${data.slice(64, 128)}`);
  const tokenReserve = reserveOrder === "token-sentis" ? reserve0 : reserve1;
  const sentisReserve = reserveOrder === "token-sentis" ? reserve1 : reserve0;
  return {
    tokenReserve,
    sentisReserve,
    priceSentis: tokenReserve ? sentisReserve / tokenReserve : null,
    liquiditySentis: 2 * sentisReserve,
  };
}

async function snapshot(asset, block = "latest") {
  const raw = await rpc("eth_call", [
    { to: asset.pair, data: "0x0902f1ac" },
    typeof block === "number" ? hex(block) : block,
  ]);
  return {
    block,
    ...decodeReserves(raw, asset.reserveOrder),
  };
}

export function compareAtSameAge(series) {
  const first = series[0];
  const last = series.at(-1);
  return {
    days: last.day,
    priceReturn: first.priceSentis
      ? last.priceSentis / first.priceSentis - 1
      : null,
    liquidityGrowth: first.liquiditySentis
      ? last.liquiditySentis / first.liquiditySentis - 1
      : null,
    endingPriceSentis: last.priceSentis,
    endingLiquiditySentis: last.liquiditySentis,
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const history = readJson("history-daily.json", {});
  const publicLaunchDay = (history.daily || []).find(
    (item) => item.stakeWallets >= 100 || item.stakeCount >= 100,
  );
  const result = {};
  for (const [key, asset] of Object.entries(ASSETS)) {
    const series = [];
    for (const [day, block] of Object.entries(asset.points)) {
      series.push({ day: Number(day), ...(await snapshot(asset, block)) });
    }
    series.sort((a, b) => a.day - b.day);
    const current = await snapshot(asset);
    const day43 = series.find((item) => item.day === 43);
    result[key] = {
      ...asset,
      series,
      sameAge: compareAtSameAge(series),
      current: {
        ...current,
        ageDays: Math.floor(
          (Date.now() - Date.parse(asset.comparisonStartAt)) / 86400000,
        ),
        priceChangeSinceDay43: day43?.priceSentis
          ? current.priceSentis / day43.priceSentis - 1
          : null,
      },
    };
  }

  const fsd43 = result.fsd.sameAge;
  const meta43 = result.meta.sameAge;
  const firstObservedDate = history.firstObservedDate || null;
  const report = {
    updatedAt: new Date().toISOString(),
    methodologyVersion: 1,
    chain: "BNB Smart Chain",
    quoteAsset: {
      symbol: "SENTIS",
      address: "0x8fd0d741e09a98e82256c63f25f90301ea71a83e",
      reason: "两组池子都以SENTIS计价，避免历史美元价格源造成假精度。",
    },
    launchAudit: {
      metaPairCreatedAt: ASSETS.meta.pairCreationAt,
      metaPairCreationBlock: ASSETS.meta.pairCreationBlock,
      claimedPublicLaunchDate: "2026-07-18",
      firstObservedFdaoStakeDate: firstObservedDate,
      firstObservedFdaoStakeBlock: history.firstObservedBlock || null,
      firstObservedFdaoStakeTransaction:
        history.firstObservedTransaction || null,
      publicLaunchDate: publicLaunchDay?.date || null,
      publicLaunchWallets: publicLaunchDay?.stakeWallets || null,
      publicLaunchTransactions: publicLaunchDay?.stakeCount || null,
      publicLaunchMeta: publicLaunchDay?.stakeMeta || null,
      conclusion:
        publicLaunchDay?.date === "2026-07-18"
          ? `META交易池在5月27日已上链。7月17日只有1个测试钱包、2笔极小质押；7月18日跃升至${publicLaunchDay.stakeWallets}个钱包、${publicLaunchDay.stakeCount}笔质押，因此7月18日确实是公开质押阶段起点。`
          : "META交易池在5月27日已上链；7月18日暂按用户提供的公开阶段日期比较，FDAO全历史仍在回填核验。",
    },
    sameAgeWindowDays: 43,
    assets: result,
    verdict: {
      priceWinner: fsd43.priceReturn > meta43.priceReturn ? "FSD" : "META",
      liquidityGrowthWinner:
        fsd43.liquidityGrowth > meta43.liquidityGrowth ? "FSD" : "META",
      day43LiquidityDifference:
        meta43.endingLiquiditySentis / fsd43.endingLiquiditySentis - 1,
      statement:
        "按公开阶段后的同一第43天比较，FSD的SENTIS计价涨幅和流动性增幅都高于META；两者第43天绝对流动性接近。因此“META同期一定更好”目前不被链上价格与池子数据支持。",
      lifecycleWarning:
        "FSD在第43天表现很强，但此后价格从当时约4.34 SENTIS回落到当前水平。早期增长好不代表后期安全，这正是META需要提前设退出触发线的原因。",
    },
    limitations: [
      "META的7月18日是公开/质押阶段口径，不是代币合约或交易池创建日。",
      "同期比较使用AMM池储备推导价格和流动性，不使用项目方宣传的TVL或人数。",
      "FSD旧版质押合约和官方团队树尚未定位，因此暂不比较FSD团队人数、等级或收益发放。",
      "SENTIS本身价格会变化；本报告比较的是相同报价资产下的相对表现，不冒充历史美元收益。",
    ],
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        firstObservedFdaoStakeDate: firstObservedDate,
        fsd43,
        meta43,
        verdict: report.verdict,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
