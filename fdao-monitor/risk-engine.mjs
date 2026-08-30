import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA_DIR = "fdao-monitor/data";
const FDAO = "0xc5424eb1061bd9e147788c527c95ac27710bfa41";
const SENTIS = "0x8fd0d741e09a98e82256c63f25f90301ea71a83e";
const USER = "0x0e39420fcdb05c5378c7d1f955dc546b5f5a85b6";
const KNOWN_TX =
  "0x34637cca993eab690939bd8692d6ee0db64abd6e5ecea9e9ac523db22d87778a";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const UNSTAKE_TOPICS = new Set([
  "0x9d4ddcf7be95a56327247eeb36efb79783c00d13defcd5a572d1e3e0d8bf57d5",
  "0x7baf0db25f935f5cb985caf351c40c4ecfd6a3b4ee3c8e3360183b8f051ed97e",
  "0xc4915ee1bfb9fe5fca0991eeb563dea7da3fe05fb9265ffc22a49c16cc9ff58e",
]);
const VIEW_STAKING_INFO = "0xb46fb85f";
const VIEW_UNSTAKE_FEE = "0x33da64cd";
const RPC =
  process.env.NODEREAL_RPC_URL ||
  process.env.BSC_PUBLIC_RPC_URL ||
  "https://bsc-dataseed-public.bnbchain.org";
const REFERENCE_SENTIS_USD = 0.2179;
const EXIT_OPTIONS = [
  { days: 30, feeRate: 0.3 },
  { days: 60, feeRate: 0.2 },
  { days: 90, feeRate: 0.1 },
];

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

const average = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
    : 0;
const sum = (values) =>
  values.reduce((total, value) => total + Number(value || 0), 0);
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const units = (value) => Number(BigInt(value || "0x0")) / 1e18;
const topicAddress = (value) => "0x" + value.slice(-40).toLowerCase();
const words = (data) => {
  const body = data.slice(2);
  const result = [];
  for (let offset = 0; offset < body.length; offset += 64) {
    result.push("0x" + body.slice(offset, offset + 64));
  }
  return result;
};

async function rpc(method, params, retries = 4) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message || "RPC error");
      return payload.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function receipts(transactionHashes) {
  const result = [];
  for (const transactionHash of transactionHashes) {
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
    if (receipt) result.push(receipt);
  }
  return result;
}

export function completePeriod(daily, currentDate, days) {
  const complete = daily.filter((item) => item.date !== currentDate);
  const recent = complete.slice(-days);
  const previous = complete.slice(-days * 2, -days);
  const recentInflow = average(
    recent.map((item) => item.stakeUsdAtCurrentPrice),
  );
  const previousInflow = average(
    previous.map((item) => item.stakeUsdAtCurrentPrice),
  );
  const recentWallets = average(recent.map((item) => item.newWallets));
  const previousWallets = average(previous.map((item) => item.newWallets));
  return {
    days,
    complete: recent.length === days && previous.length === days,
    recentRange: [recent[0]?.date || null, recent.at(-1)?.date || null],
    previousRange: [previous[0]?.date || null, previous.at(-1)?.date || null],
    recentAvgInflowUsd: recentInflow,
    previousAvgInflowUsd: previousInflow,
    inflowRatio: previousInflow ? recentInflow / previousInflow : null,
    recentAvgNewWallets: recentWallets,
    previousAvgNewWallets: previousWallets,
    newWalletRatio: previousWallets ? recentWallets / previousWallets : null,
    recentUnstakeUsd: sum(recent.map((item) => item.unstakeUsdAtCurrentPrice)),
    recentStakeUsd: sum(recent.map((item) => item.stakeUsdAtCurrentPrice)),
  };
}

export function parseUnstakeEvidence(receiptList) {
  const evidence = [];
  for (const receipt of receiptList) {
    for (const log of receipt.logs || []) {
      if (
        log.address.toLowerCase() !== FDAO ||
        !UNSTAKE_TOPICS.has(log.topics?.[0]?.toLowerCase())
      ) {
        continue;
      }
      const decoded = words(log.data);
      const grossSentis = units(decoded[2]);
      const feeSentis = units(decoded[3]);
      evidence.push({
        tx: receipt.transactionHash,
        wallet: topicAddress(log.topics[1]),
        lpAmount: units(decoded[0]),
        releaseDays: Number(BigInt(decoded[1])),
        grossSentis,
        feeSentis,
        netSentis: grossSentis - feeSentis,
        feeRate: grossSentis ? feeSentis / grossSentis : null,
        timestamp: Number(BigInt(decoded.at(-1))),
      });
    }
  }
  return evidence;
}

export function assessRisk({
  custodyCoverage,
  period7,
  rewardHighUsd,
  cumulativeExitRatio,
  relationshipAvailable,
}) {
  const signals = [];
  const add = (id, level, value, threshold, explanation) =>
    signals.push({ id, level, value, threshold, explanation });

  add(
    "custody_coverage",
    custodyCoverage < 0.75 ? "red" : custodyCoverage < 0.9 ? "orange" : "green",
    custodyCoverage,
    "orange < 90%; red < 75%",
    "FDAO持有的LP按池子流动性折算后，对合约显示TVL的覆盖程度。",
  );
  add(
    "seven_day_inflow_momentum",
    period7.inflowRatio == null
      ? "unknown"
      : period7.inflowRatio < 0.7
        ? "red"
        : period7.inflowRatio < 0.9
          ? "orange"
          : "green",
    period7.inflowRatio,
    "orange < 90%; red < 70%",
    "最近7个完整日的日均新增，对比之前7个完整日。",
  );
  add(
    "seven_day_wallet_momentum",
    period7.newWalletRatio == null
      ? "unknown"
      : period7.newWalletRatio < 0.75
        ? "red"
        : period7.newWalletRatio < 0.9
          ? "orange"
          : "green",
    period7.newWalletRatio,
    "orange < 90%; red < 75%",
    "最近7个完整日的新钱包日均数，对比之前7日。",
  );
  const rewardCoverage = rewardHighUsd
    ? period7.recentAvgInflowUsd / rewardHighUsd
    : null;
  add(
    "high_reward_coverage",
    rewardCoverage == null
      ? "unknown"
      : rewardCoverage < 0.75
        ? "red"
        : rewardCoverage < 1
          ? "orange"
          : rewardCoverage < 1.25
            ? "yellow"
            : "green",
    rewardCoverage,
    "orange < 1.0x; red < 0.75x",
    "最近7日日均新增资金，覆盖1.2%高档理论日奖励的倍数。",
  );
  add(
    "real_exit_ratio",
    cumulativeExitRatio > 0.25
      ? "red"
      : cumulativeExitRatio > 0.1
        ? "orange"
        : "green",
    cumulativeExitRatio,
    "orange > 10%; red > 25%",
    "链上累计发起解押价值，占累计质押价值的比例。",
  );
  add(
    "relationship_opacity",
    relationshipAvailable ? "green" : "yellow",
    relationshipAvailable,
    "A/B级关系树存在",
    "没有链上推荐树时，无法提前识别头部团队同步撤退。",
  );

  const red = signals.filter((signal) => signal.level === "red").length;
  const orange = signals.filter((signal) => signal.level === "orange").length;
  const level =
    red >= 2 ? "red" : red >= 1 || orange >= 2 ? "orange" : "yellow";
  const action =
    level === "red"
      ? "优先降低风险：不要等待账面收益回本，评估启动退出。"
      : level === "orange"
        ? "停止追加，准备退出方案；任一核心指标进入红色就优先执行退出。"
        : "暂时观察，不追加本金；每天检查新增、真实解押和LP覆盖。";
  return { level, action, rewardCoverage, signals };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = readJson("current.json", null);
  const history = readJson("history-daily.json", { daily: [] });
  const historyState = readJson("history-state.json", { events: [] });
  const todayState = readJson("state.json", { dayEvents: [] });
  const walletAnalytics = readJson("wallet-analytics.json", { summary: {} });
  const relationship = readJson("relationship-graph.json", {
    teamMetrics: { available: false },
  });
  if (!current) throw new Error("current.json is required");

  const events = [...historyState.events, ...(todayState.dayEvents || [])];
  const unstakeEvents = events.filter((event) => event.kind === "unstake");
  const unstakeTransactions = [
    ...new Set(
      unstakeEvents
        .map((event) => event.tx || event.id?.split(":")[0])
        .filter((transactionHash) => /^0x[0-9a-f]{64}$/i.test(transactionHash)),
    ),
  ];
  const missingUnstakeTransactionHashes = unstakeEvents.length
    ? unstakeEvents.length - unstakeTransactions.length
    : 0;
  const [knownTransaction, knownReceipt, stakingInfo, unstakeReceipts] =
    await Promise.all([
      rpc("eth_getTransactionByHash", [KNOWN_TX]),
      rpc("eth_getTransactionReceipt", [KNOWN_TX]),
      rpc("eth_call", [
        { to: FDAO, from: USER, data: VIEW_STAKING_INFO },
        "latest",
      ]),
      receipts(unstakeTransactions),
    ]);

  const stakingWords = words(stakingInfo);
  const stakedLpWei = BigInt(stakingWords[0]);
  const stakedLp = units(stakingWords[0]);
  const rewardMeta = units(stakingWords[1]);
  const feeQuotes = await Promise.all(
    EXIT_OPTIONS.map(async (option) => ({
      ...option,
      feeSentis: units(
        await rpc("eth_call", [
          {
            to: FDAO,
            from: USER,
            data: VIEW_UNSTAKE_FEE + word(option.days) + word(stakedLpWei),
          },
          "latest",
        ]),
      ),
    })),
  );

  const sentisTransfer = (knownReceipt.logs || [])
    .filter(
      (log) =>
        log.address.toLowerCase() === SENTIS &&
        log.topics?.[0] === TRANSFER_TOPIC &&
        log.topics.length >= 3,
    )
    .map((log) => ({
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      amount: units(log.data),
    }))
    .find((transfer) => transfer.from === USER && transfer.to === FDAO);
  const costSentis = sentisTransfer?.amount || 0;
  const referenceCostUsd = costSentis * REFERENCE_SENTIS_USD;
  const sentisUsd = Number(current.market.sentisPrice || 0);
  const exitOptions = feeQuotes.map((quote) => {
    const grossSentis = quote.feeRate ? quote.feeSentis / quote.feeRate : 0;
    const netSentis = grossSentis - quote.feeSentis;
    const currentNetUsd = netSentis * sentisUsd;
    return {
      releaseDays: quote.days,
      feeRate: quote.feeRate,
      chainQuotedFeeSentis: quote.feeSentis,
      chainImpliedGrossSentis: grossSentis,
      netSentisBeforePossibleBurn: netSentis,
      currentNetUsdBeforePossibleBurn: currentNetUsd,
      pnlUsdVsReference: currentNetUsd - referenceCostUsd,
      pnlPctVsReference: referenceCostUsd
        ? currentNetUsd / referenceCostUsd - 1
        : null,
      breakEvenSentisUsd: netSentis ? referenceCostUsd / netSentis : null,
    };
  });

  const unstakeEvidence = parseUnstakeEvidence(unstakeReceipts);
  const cumulativeStakeUsd = sum(
    (history.daily || []).map((item) => item.stakeUsdAtCurrentPrice),
  );
  const cumulativeUnstakeUsd = sum(
    (history.daily || []).map((item) => item.unstakeUsdAtCurrentPrice),
  );
  const period3 = completePeriod(history.daily || [], current.date, 3);
  const period7 = completePeriod(history.daily || [], current.date, 7);
  const period14 = completePeriod(history.daily || [], current.date, 14);
  const fdaoCustodiedLiquidityUsd =
    Number(current.market.liquidity || 0) *
    Number(current.protocol.custodyPct || 0);
  const custodyCoverage = current.protocol.tvl
    ? fdaoCustodiedLiquidityUsd / current.protocol.tvl
    : 0;
  const assessment = assessRisk({
    custodyCoverage,
    period7,
    rewardHighUsd: current.pressure.rewardHigh,
    cumulativeExitRatio: cumulativeStakeUsd
      ? cumulativeUnstakeUsd / cumulativeStakeUsd
      : 0,
    relationshipAvailable: Boolean(relationship.teamMetrics?.available),
  });

  const report = {
    updatedAt: new Date().toISOString(),
    methodologyVersion: 1,
    chainScope: "BNB Smart Chain",
    scale: {
      exitPoolLiquidityUsd: current.market.liquidity,
      fdaoLpCustodyShare: current.protocol.custodyPct,
      fdaoCustodiedLiquidityUsd,
      contractReportedTvlUsd: current.protocol.tvl,
      custodyCoverage,
      observedCumulativeStakeUsd: walletAnalytics.summary?.totalStakeUsd || 0,
      observedWallets: walletAnalytics.summary?.wallets || 0,
      note: "Contract-reported TVL is chain-readable but contract-controlled accounting; FDAO-custodied LP value is independently derived from LP balance and pool liquidity.",
    },
    growth: {
      completeThrough: period7.recentRange[1],
      period3,
      period7,
      period14,
      excludesCurrentPartialDay: true,
    },
    exits: {
      observedUnstakeTransactions: unstakeTransactions.length,
      decodedUnstakeEvents: unstakeEvidence.length,
      missingUnstakeTransactionHashes,
      cumulativeStakeUsdAtCurrentPrice: cumulativeStakeUsd,
      cumulativeUnstakeUsdAtCurrentPrice: cumulativeUnstakeUsd,
      cumulativeUnstakeToStakeRatio: cumulativeStakeUsd
        ? cumulativeUnstakeUsd / cumulativeStakeUsd
        : 0,
      chainFeeEvidence: EXIT_OPTIONS.map((option) => {
        const matching = unstakeEvidence.filter(
          (event) => event.releaseDays === option.days,
        );
        return {
          releaseDays: option.days,
          expectedFeeRate: option.feeRate,
          observedEvents: matching.length,
          observedMinFeeRate: matching.length
            ? Math.min(...matching.map((event) => event.feeRate))
            : null,
          observedMaxFeeRate: matching.length
            ? Math.max(...matching.map((event) => event.feeRate))
            : null,
          grossSentis: sum(matching.map((event) => event.grossSentis)),
          feeSentis: sum(matching.map((event) => event.feeSentis)),
        };
      }),
      correction:
        "30/60/90 are release choices with observed 30%/20%/10% fees, not wallet-age eligibility milestones. Existing events prove 90-day choices occurred before wallets were 90 days old.",
    },
    userPosition: {
      wallet: USER,
      knownTransaction: KNOWN_TX,
      transactionFrom: knownTransaction?.from?.toLowerCase() || null,
      chainVerifiedCost: {
        token: "SENTIS",
        amount: costSentis,
        source:
          "SENTIS Transfer from the user wallet to FDAO in the known receipt",
      },
      usdCostBasis: {
        amount: referenceCostUsd,
        sentisUsd: REFERENCE_SENTIS_USD,
        source: "user-provided wallet screenshot near the transaction time",
        chainVerified: false,
      },
      current: {
        stakedLp,
        rewardMeta,
        sentisUsd,
        metaUsd: current.market.metaPrice,
      },
      exitOptions,
      caveat:
        "The fee quote is read directly from viewUnStakeLPFee. The site also states a 2% burn; final cash received remains a range until a completed release withdrawal is decoded on-chain.",
    },
    assessment,
    sellTriggers: [
      {
        level: "orange",
        rule: "7个完整日新增资金低于前7日90%，或日均新增不足高档理论奖励，或LP资产覆盖低于90%。",
        action: "停止追加，准备90日低费退出方案。",
      },
      {
        level: "red",
        rule: "任一核心指标进入红色即触发退出优先级；任意两项同时进入红色，总灯升级为红色。",
        action: "优先降低风险，不等待账面回本；两项同时出现时按紧急情况处理。",
      },
    ],
    limitations: [
      "Official referral and team trees remain off-chain or behind authenticated project APIs.",
      "USD entry cost is not immutable on-chain because SENTIS was not a stablecoin; the displayed USD P/L uses the user's contemporaneous screenshot price.",
      "A final 2% burn and release withdrawals still need transaction-level reconciliation before net proceeds are exact.",
    ],
  };
  writeJson("risk-assessment.json", report);
  console.log(
    JSON.stringify(
      {
        ok: true,
        level: report.assessment.level,
        custodyCoverage,
        full7InflowRatio: period7.inflowRatio,
        full7WalletRatio: period7.newWalletRatio,
        unstakeEvents: unstakeEvidence.length,
        userExitOptions: exitOptions,
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
