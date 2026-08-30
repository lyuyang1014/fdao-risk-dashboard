const DATA = "./data/current.json";
const HIST = "./data/history-daily.json";
const WAL = "./data/wallet-analytics.json";
const REL = "./data/relationship-graph.json";
const RISK = "./data/risk-assessment.json";
const $ = (id) => document.getElementById(id);
const usd = (value) => {
  let number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const sign = number < 0 ? "−" : "";
  number = Math.abs(number);
  return (
    sign +
    "$" +
    (number >= 1e6
      ? (number / 1e6).toFixed(2) + "M"
      : number >= 1e3
        ? (number / 1e3).toFixed(1) + "K"
        : number.toFixed(0))
  );
};
const num = (value, digits = 0) =>
  Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
const pct = (value) =>
  Number.isFinite(Number(value)) ? (Number(value) * 100).toFixed(1) + "%" : "—";
const short = (address) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";

function chart(days) {
  const element = $("flowChart");
  if (!days.length) {
    element.innerHTML = '<span class="sub">历史回填中…</span>';
    return;
  }
  const recent = days.slice(-24);
  const max = Math.max(...recent.map((item) => item.stakeUsdAtCurrentPrice), 1);
  element.innerHTML = recent
    .map(
      (item) =>
        `<div class="bc" title="${item.date} ${usd(item.stakeUsdAtCurrentPrice)}"><div class="bar" style="height:${Math.max(2, (item.stakeUsdAtCurrentPrice / max) * 145)}px"></div><small>${item.date.slice(5)}</small></div>`,
    )
    .join("");
}

function renderRelationships(report) {
  if (!report) {
    $("relationshipExplain").textContent = "关系证据尚未生成，后台会继续重试。";
    return;
  }
  const evidence = report.evidenceSummary || {};
  $("relationCoverage").textContent = pct(report.coverage);
  $("gradeA").textContent = num(evidence.gradeAConfirmedEdges);
  $("gradeB").textContent = num(evidence.gradeBRewardEdges);
  $("gradeC").textContent = num(evidence.gradeCBehaviorClusters);
  const complete = report.backfillDone ? "已检查全部首入钱包" : "仍在分批检查";
  if (evidence.gradeAConfirmedEdges || evidence.gradeBRewardEdges) {
    $("relationshipExplain").textContent =
      `${complete}。当前已有可用于构树的 A/B 级关系；团队数据只采用这些关系，C级行为不会混入。`;
  } else {
    $("relationshipExplain").innerHTML =
      `<b>${complete}，但链上没有找到可确认的“钱包→推荐人”。</b> 已检查 ${num(evidence.sampledFirstStakeTransactions)} 笔首入交易：参数中没有推荐地址，回执也没有向可变上级支付的推荐奖励。项目网站把绑定码、邀请记录和等级放在登录后的后台接口，因此目前不能诚实计算团队规模、头部团队占比或官方V级。`;
  }
  $("selfThresholdBox").innerHTML = (
    report.levelDistribution?.selfThresholdsOnly || []
  )
    .map(
      (item) =>
        `<div class="line"><span>${item.level} 个人门槛 ${usd(item.selfUsd)}</span><b>${num(item.walletsMeetingSelfThreshold)} 个钱包达到个人金额</b></div>`,
    )
    .join("");
  $("behaviorClusters").innerHTML =
    (report.behaviorClusters || [])
      .slice(0, 20)
      .map(
        (cluster) =>
          `<tr><td>${cluster.detail}</td><td>${num(cluster.walletCount)}</td><td>${num(cluster.stakeMeta, 2)}</td><td>${cluster.wallets.slice(0, 3).map(short).join("、")}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="4">暂未发现达到保守阈值的同批行为</td></tr>';
}

function renderRisk(report) {
  if (!report) {
    $("riskAction").textContent = "风险模型尚未生成，后台会继续重试。";
    return;
  }
  $("scaleLiquidity").textContent = usd(report.scale.exitPoolLiquidityUsd);
  $("scaleCustody").textContent = usd(report.scale.fdaoCustodiedLiquidityUsd);
  $("scaleTvl").textContent = usd(report.scale.contractReportedTvlUsd);
  $("scaleCoverage").textContent = pct(report.scale.custodyCoverage);
  $("scaleExplain").innerHTML =
    `链上退出池约 <b>${usd(report.scale.exitPoolLiquidityUsd)}</b>；FDAO持有其中约 <b>${pct(report.scale.fdaoLpCustodyShare)}</b> 的LP，折算可对应约 <b>${usd(report.scale.fdaoCustodiedLiquidityUsd)}</b>。合约自己显示TVL为 <b>${usd(report.scale.contractReportedTvlUsd)}</b>，LP资产覆盖约 <b>${pct(report.scale.custodyCoverage)}</b>。覆盖率不是“马上亏损率”，但低于100%说明显示TVL不能全部等同于可退出资产。`;

  const position = report.userPosition;
  $("positionCost").textContent =
    `${num(position.chainVerifiedCost.amount, 2)} SENTIS`;
  $("positionCostUsd").textContent = usd(position.usdCostBasis.amount);
  $("positionLp").textContent = num(position.current.stakedLp, 2);
  $("positionReward").textContent =
    `${num(position.current.rewardMeta, 2)} META`;
  $("exitOptions").innerHTML = (position.exitOptions || [])
    .map((option) => {
      const pnlClass = option.pnlUsdVsReference >= 0 ? "good" : "bad";
      const pnlSign = option.pnlUsdVsReference >= 0 ? "+" : "";
      return `<tr><td>${option.releaseDays}天</td><td>${pct(option.feeRate)}</td><td>${num(option.netSentisBeforePossibleBurn, 2)}</td><td>${usd(option.currentNetUsdBeforePossibleBurn)}</td><td class="${pnlClass}">${pnlSign}${usd(option.pnlUsdVsReference)} · ${pnlSign}${pct(option.pnlPctVsReference)}</td><td>$${num(option.breakEvenSentisUsd, 4)}</td></tr>`;
    })
    .join("");
  const option90 = position.exitOptions?.find(
    (option) => option.releaseDays === 90,
  );
  $("positionExplain").innerHTML = option90
    ? `链上报价目前显示：选择90天释放、扣除10%链上手续费后，约为 <b>${num(option90.netSentisBeforePossibleBurn, 2)} SENTIS</b>，按现价约 <b>${usd(option90.currentNetUsdBeforePossibleBurn)}</b>，对比截图参考成本约 <b class="${option90.pnlUsdVsReference >= 0 ? "good" : "bad"}">${usd(option90.pnlUsdVsReference)}</b>。SENTIS约需达到 <b>$${num(option90.breakEvenSentisUsd, 4)}</b> 才能覆盖该参考成本。*项目页面另称最终有2%销毁，实际到账可能再低一些，仍需用完成释放的链上交易确认。`
    : "等待90天释放方案的链上报价。";

  const levelLabels = {
    red: "🔴 红色",
    orange: "🟠 橙色",
    yellow: "🟡 黄色",
    green: "🟢 绿色",
  };
  $("riskLevel").textContent = levelLabels[report.assessment.level] || "—";
  $("riskInflow").textContent = pct(report.growth.period7.inflowRatio);
  $("riskWallets").textContent = pct(report.growth.period7.newWalletRatio);
  $("riskRewardCover").textContent =
    `${num(report.assessment.rewardCoverage, 2)}×`;
  $("riskAction").innerHTML =
    `<b>${levelLabels[report.assessment.level] || ""}：</b>${report.assessment.action} 当前真实解押仍很少，但LP资产覆盖与高档奖励承接已经进入橙色区间。`;
  const signalNames = {
    custody_coverage: "LP资产覆盖",
    seven_day_inflow_momentum: "7日新增资金",
    seven_day_wallet_momentum: "7日新钱包",
    high_reward_coverage: "新增覆盖高档奖励",
    real_exit_ratio: "真实解押比例",
    relationship_opacity: "团队关系透明度",
  };
  $("riskSignals").innerHTML = (report.assessment.signals || [])
    .map(
      (signal) =>
        `<div class="line"><span>${signalNames[signal.id] || signal.id}：${signal.explanation}</span><b class="${signal.level === "green" ? "good" : signal.level === "red" ? "bad" : "warn"}">${levelLabels[signal.level] || signal.level}</b></div>`,
    )
    .join("");
}

async function load() {
  try {
    const timestamp = Date.now();
    const [
      currentResponse,
      historyResponse,
      walletResponse,
      relationResponse,
      riskResponse,
    ] = await Promise.all([
      fetch(`${DATA}?t=${timestamp}`, { cache: "no-store" }),
      fetch(`${HIST}?t=${timestamp}`, { cache: "no-store" }),
      fetch(`${WAL}?t=${timestamp}`, { cache: "no-store" }),
      fetch(`${REL}?t=${timestamp}`, { cache: "no-store" }),
      fetch(`${RISK}?t=${timestamp}`, { cache: "no-store" }),
    ]);
    if (!currentResponse.ok) throw new Error("实时数据读取失败");
    const current = await currentResponse.json();
    const historyData = historyResponse.ok
      ? await historyResponse.json()
      : { daily: [], trend: {} };
    const wallets = walletResponse.ok ? await walletResponse.json() : null;
    const relationships = relationResponse.ok
      ? await relationResponse.json()
      : null;
    const riskAssessment = riskResponse.ok ? await riskResponse.json() : null;

    $("price").textContent = "$" + current.market.metaPrice.toFixed(4);
    $("liq").textContent = usd(current.market.liquidity);
    $("tvl").textContent = usd(current.protocol.tvl);
    $("vol").textContent = usd(current.market.volume24);
    $("trades").textContent =
      `买 ${num(current.market.buys)} / 卖 ${num(current.market.sells)} 笔`;
    $("wallets").textContent = num(current.today.uniqueStakeWallets);
    $("stakeUsd").textContent = usd(current.today.stakeUsd);
    $("avgWalletToday").textContent = current.today.uniqueStakeWallets
      ? usd(current.today.stakeUsd / current.today.uniqueStakeWallets)
      : "—";
    $("exitUsd").textContent = usd(current.today.unstakeUsd);
    $("apy").textContent = current.protocol.apy.toFixed(2) + "%";
    $("reward").textContent =
      usd(current.pressure.rewardLow) + "–" + usd(current.pressure.rewardHigh);
    $("fee").textContent = usd(current.pressure.feeMax);
    $("feeCover").textContent = pct(current.pressure.feeCoverLow);
    const age = (Date.now() - Date.parse(current.updatedAt)) / 60000;
    $("freshness").textContent =
      `后台 ${Math.max(0, Math.floor(age))} 分钟前更新`;
    const todayCoverage = current.indexing?.dayBackfillDone
      ? 1
      : Number(current.indexing?.todayCoverage || 0);
    const historyCoverage = historyData.backfillDone
      ? 1
      : Number(historyData.coverage || 0);
    $("backfill").textContent =
      `今日扫描 ${Math.round(todayCoverage * 100)}% · 历史 ${Math.round(historyCoverage * 100)}%`;
    $("backfill").className =
      "pill " + (todayCoverage >= 1 && historyCoverage >= 1 ? "good" : "warn");
    const scanNote =
      todayCoverage >= 1
        ? "今天已完整扫描"
        : `今天仅扫描 ${(todayCoverage * 100).toFixed(1)}%，以下人数/金额仍是下限`;
    $("todayExplain").innerHTML =
      `<b>${scanNote}</b>。目前发现 <b>${num(current.today.uniqueStakeWallets)}</b> 个质押钱包，新增质押约 <b>${usd(current.today.stakeUsd)}</b>，平均每钱包 <b>${current.today.uniqueStakeWallets ? usd(current.today.stakeUsd / current.today.uniqueStakeWallets) : "—"}</b>，退出约 <b>${usd(current.today.unstakeUsd)}</b>。`;

    if (wallets) {
      $("waWallets").textContent = num(wallets.summary.wallets);
      $("waAvg").textContent = usd(wallets.summary.avgStakeUsd);
      $("waMedian").textContent = usd(wallets.summary.medianStakeUsd);
      $("waTop10").textContent = pct(wallets.summary.top10Share);
      $("walletExplain").textContent =
        `当前已回填地址中，平均累计投入 ${usd(wallets.summary.avgStakeUsd)}，中位数 ${usd(wallets.summary.medianStakeUsd)}。Top 10 地址贡献 ${pct(wallets.summary.top10Share)}，Top 50 贡献 ${pct(wallets.summary.top50Share)}。${wallets.backfillDone ? "历史已完整，可直接用来判断集中度。" : "历史尚未100%，集中度和首次进入时间仍会继续修正。"}`;
      $("tierBox").innerHTML = (wallets.capitalTiers || [])
        .map(
          (item) =>
            `<div class="line"><span>${item.name}：${num(item.wallets)}个地址</span><b>${usd(item.capitalUsd)} · ${pct(item.share)}</b></div>`,
        )
        .join("");
      $("topWallets").innerHTML =
        (wallets.topWallets || [])
          .slice(0, 30)
          .map(
            (item) =>
              `<tr><td>${short(item.address)}</td><td>${item.firstStakeDate || "—"}</td><td>${usd(item.stakeUsd)}</td><td>${item.stakeCount}</td><td>${usd(item.unstakeUsd)}</td><td>${usd(item.netUsd)}</td><td>${item.capitalTier}</td></tr>`,
          )
          .join("") || '<tr><td colspan="7">等待数据</td></tr>';
    }

    renderRelationships(relationships);
    renderRisk(riskAssessment);
    chart(historyData.daily || []);
    $("totalWallets").textContent = num(historyData.totalObservedStakeWallets);
    $("avg7").textContent = usd(
      riskAssessment?.growth?.period7?.recentAvgInflowUsd ??
        historyData.trend?.last7AvgStakeUsd,
    );
    $("prev7").textContent = usd(
      riskAssessment?.growth?.period7?.previousAvgInflowUsd ??
        historyData.trend?.previous7AvgStakeUsd,
    );
    $("flowRatio").textContent =
      (riskAssessment?.growth?.period7?.inflowRatio ??
        historyData.trend?.full7FlowRatio) == null
        ? "—"
        : pct(
            riskAssessment?.growth?.period7?.inflowRatio ??
              historyData.trend.full7FlowRatio,
          );
    $("trendRisk").textContent = historyData.trend?.risk || "历史回填中";
    let headline = riskAssessment
      ? `${riskAssessment.assessment.level === "red" ? "🔴" : riskAssessment.assessment.level === "orange" ? "🟠" : "🟡"} ${riskAssessment.assessment.action}`
      : "当前仍属于高收益、高依赖新增资金的结构。";
    if (todayCoverage < 1) headline += " 今日扫描尚未100%。";
    $("headline").textContent = headline;
    $("safetyExplain").textContent = headline;
    $("sustain").innerHTML =
      `当前TVL ${usd(current.protocol.tvl)}，按0.6%–1.2%/日对应约 ${usd(current.pressure.rewardLow)}–${usd(current.pressure.rewardHigh)} 的日奖励压力；2%交易手续费的极乐观上限仅 ${usd(current.pressure.feeMax)}，覆盖低档奖励约 ${pct(current.pressure.feeCoverLow)}。`;
    $("history").innerHTML =
      (historyData.daily || [])
        .slice()
        .reverse()
        .map(
          (item) =>
            `<tr><td>${item.date}</td><td>${item.stakeWallets}</td><td>${item.newWallets}</td><td>${usd(item.avgPerStakeWallet)}</td><td>${usd(item.medianStakeTxUsd)}</td><td>${usd(item.stakeUsdAtCurrentPrice)}</td><td>${item.unstakeCount}</td><td>${usd(item.unstakeUsdAtCurrentPrice)}</td><td class="${item.netUsdAtCurrentPrice >= 0 ? "good" : "bad"}">${usd(item.netUsdAtCurrentPrice)}</td></tr>`,
        )
        .join("") || '<tr><td colspan="9">历史正在回填</td></tr>';
  } catch (error) {
    $("headline").textContent = "数据读取异常：" + error.message;
  }
}

$("refresh").onclick = load;
load();
setInterval(load, 60000);
