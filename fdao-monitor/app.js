const DATA = "./data/current.json";
const HIST = "./data/history-daily.json";
const WAL = "./data/wallet-analytics.json";
const REL = "./data/relationship-graph.json";
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

async function load() {
  try {
    const timestamp = Date.now();
    const [currentResponse, historyResponse, walletResponse, relationResponse] =
      await Promise.all([
        fetch(`${DATA}?t=${timestamp}`, { cache: "no-store" }),
        fetch(`${HIST}?t=${timestamp}`, { cache: "no-store" }),
        fetch(`${WAL}?t=${timestamp}`, { cache: "no-store" }),
        fetch(`${REL}?t=${timestamp}`, { cache: "no-store" }),
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
      const maturity = wallets.maturity || {};
      $("m30").textContent = usd(maturity.next7d30?.capitalUsd);
      $("m30w").textContent = `${num(maturity.next7d30?.wallets)}个钱包`;
      $("m60").textContent = usd(maturity.next7d60?.capitalUsd);
      $("m60w").textContent = `${num(maturity.next7d60?.wallets)}个钱包`;
      $("m90").textContent = usd(maturity.next7d90?.capitalUsd);
      $("m90w").textContent = `${num(maturity.next7d90?.wallets)}个钱包`;
      $("m90_30").textContent = usd(maturity.next30d90?.capitalUsd);
      $("m90_30w").textContent = `${num(maturity.next30d90?.wallets)}个钱包`;
      const near =
        (maturity.next7d60?.capitalUsd || 0) +
        (maturity.next7d90?.capitalUsd || 0);
      let message = wallets.backfillDone
        ? ""
        : "历史还没100%，以下到期额只是下限。 ";
      if (near > current.today.stakeUsd * 3) {
        message +=
          "🔴 未来7天进入60/90日低费区间的本金，明显高于今天新增资金，退出压力值得重点警惕。";
      } else if (near > current.today.stakeUsd) {
        message +=
          "🟠 未来7天低费到期本金已高于今天新增，后续要看是否真的开始解押。";
      } else {
        message +=
          "🟡 目前已识别的未来7天低费到期本金，还没有明显压过今天新增资金。";
      }
      $("maturityExplain").textContent = message;
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
    chart(historyData.daily || []);
    $("totalWallets").textContent = num(historyData.totalObservedStakeWallets);
    $("avg3").textContent = usd(historyData.trend?.last3AvgStakeUsd);
    $("prev3").textContent = usd(historyData.trend?.previous3AvgStakeUsd);
    $("flowRatio").textContent =
      historyData.trend?.flowRatio == null
        ? "—"
        : pct(historyData.trend.flowRatio);
    $("trendRisk").textContent = historyData.trend?.risk || "历史回填中";
    const ratio = historyData.trend?.flowRatio;
    let headline = "当前仍属于高收益、高依赖新增资金的结构。";
    if (ratio != null && ratio < 0.6) {
      headline =
        "🔴 新增质押动能较前一阶段下降40%以上，而奖励仍持续释放：这是重要的早期风险信号。";
    } else if (ratio != null && ratio < 0.85) {
      headline =
        "🟠 新增质押明显放缓；如果同时出现到期本金增加、退出增加或LP下降，风险会快速上升。";
    } else if (current.today.netUsd > 0) {
      headline =
        "🟡 当前仍有净新增资金进入，但高收益主要不是手续费创造，安全性依赖新人和人均投入持续。";
    }
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
