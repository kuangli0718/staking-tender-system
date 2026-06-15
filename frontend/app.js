// UTF-8 rule:
// 1. All UI strings in this file must remain UTF-8 encoded.
// 2. Do not rewrite user-facing Chinese text unless explicitly requested.
console.log("app loaded");

const ARTIFACT_PATHS = [
  "/out/StakingTender.sol/StakingTender.json",
  "../out/StakingTender.sol/StakingTender.json",
  "./out/StakingTender.sol/StakingTender.json",
];

const DEPLOYMENT_RECORD_PATHS = [
  "/broadcast/DeployStakingTender.s.sol/31337/run-latest.json",
  "../broadcast/DeployStakingTender.s.sol/31337/run-latest.json",
  "./broadcast/DeployStakingTender.s.sol/31337/run-latest.json",
];

const FALLBACK_CONTRACT_ADDRESSES = ["0x5FbDB2315678afecb367f032d93F642f64180aa3"];

const state = {
  provider: null,
  signer: null,
  account: "",
  contract: null,
  abi: null,
  currentTaskId: 1n,
  contractAddress: "",
  currentRole: "publisher",
  currentTask: null,
  currentTaskView: null,
  bidderPanelRefreshKey: 0,
};

const TASK_I18N = {
  status: {
    None: "未开始",
    Bidding: "竞标中",
    Reveal: "揭标中",
    Selection: "筛选中",
    InProgress: "执行中",
    Delivered: "待验收",
    Completed: "已完成",
    Cancelled: "已取消",
    Expired: "已结束",
  },
  complexity: {
    Low: "低难度",
    Medium: "中等难度",
    High: "高难度",
  },
  projectType: {
    "Small project": "小型项目",
    "Medium project": "中型项目",
    "Large project": "大型项目",
    "Small task": "小型项目",
  },
  fallback: {
    status: "未知状态",
    complexity: "未知难度",
    projectType: "未分类项目",
  },
};

let ReactLib = null;
let bidderPanelRoot = null;
let BidderListPanelComponent = null;
let ethers = null;

const TASK_METADATA_STORAGE_KEY = "stakingTender.taskMetadataStore.v1";

function createEmptyTaskMetadataStore() {
  return {
    byTaskId: {},
    byDetailsHash: {},
  };
}

function loadTaskMetadataStore() {
  try {
    const raw = window.localStorage.getItem(TASK_METADATA_STORAGE_KEY);
    if (!raw) {
      return createEmptyTaskMetadataStore();
    }

    const parsed = JSON.parse(raw);
    return {
      byTaskId: parsed?.byTaskId ?? {},
      byDetailsHash: parsed?.byDetailsHash ?? {},
    };
  } catch {
    return createEmptyTaskMetadataStore();
  }
}

function saveTaskMetadataStore(store) {
  window.localStorage.setItem(TASK_METADATA_STORAGE_KEY, JSON.stringify(store));
}

function inferTaskTitle(description) {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "未命名任务";
  }

  const firstSentence = normalized.split(/[\n。！？!?]/).find(Boolean)?.trim() || normalized;
  return firstSentence.slice(0, 24);
}

function inferTaskTags(description) {
  const text = description.toLowerCase();
  const tags = [];

  if (text.includes("前端") || text.includes("react") || text.includes("vue") || text.includes("页面")) {
    tags.push("前端");
  }
  if (text.includes("solidity") || text.includes("合约") || text.includes("foundry")) {
    tags.push("智能合约");
  }
  if (text.includes("设计") || text.includes("ui") || text.includes("原型")) {
    tags.push("UI设计");
  }
  if (text.includes("测试") || text.includes("test")) {
    tags.push("测试");
  }
  if (!tags.length) {
    tags.push("综合任务");
  }

  return tags;
}

function inferTaskComplexity(description, rewardEth) {
  const text = description.toLowerCase();
  const keywordScore = ["架构", "协议", "复杂", "多页面", "测试", "solidity", "合约"].reduce(
    (score, keyword) => score + (text.includes(keyword) ? 1 : 0),
    0
  );

  if (rewardEth >= 1.5 || keywordScore >= 3) {
    return "High";
  }
  if (rewardEth >= 0.7 || keywordScore >= 1) {
    return "Medium";
  }
  return "Low";
}

function inferTaskEffort(complexity) {
  if (complexity === "High") return "Large project";
  if (complexity === "Medium") return "Medium project";
  return "Small project";
}

function inferRecommendedBidRange(rewardEth, complexity) {
  if (complexity === "High") {
    return `${Math.max(0.6, rewardEth * 0.65).toFixed(1)} - ${(rewardEth * 1.05).toFixed(1)} ETH`;
  }
  if (complexity === "Medium") {
    return `${Math.max(0.3, rewardEth * 0.5).toFixed(1)} - ${(rewardEth * 0.9).toFixed(1)} ETH`;
  }
  return `${Math.max(0.1, rewardEth * 0.35).toFixed(1)} - ${(rewardEth * 0.75).toFixed(1)} ETH`;
}

function buildTaskMetadataFromInput({ description, reward }) {
  const normalizedDescription = description.trim();
  const rewardEth = Number(ethers.formatEther(reward));
  const complexity = inferTaskComplexity(normalizedDescription, rewardEth);

  return {
    title: inferTaskTitle(normalizedDescription),
    description: normalizedDescription,
    tags: inferTaskTags(normalizedDescription),
    complexity,
    effort: inferTaskEffort(complexity),
    recommendedBidRange: inferRecommendedBidRange(rewardEth, complexity),
    source: "user-input",
  };
}

function persistTaskMetadata({ taskId, detailsHash, metadata }) {
  const store = loadTaskMetadataStore();
  const record = {
    ...metadata,
    taskId: taskId.toString(),
    detailsHash,
    updatedAt: Date.now(),
  };

  store.byTaskId[taskId.toString()] = record;
  if (detailsHash) {
    store.byDetailsHash[detailsHash] = record;
  }
  saveTaskMetadataStore(store);
}

const walletPill = document.querySelector("#wallet-pill");
const networkPill = document.querySelector("#network-pill");
const contractPill = document.querySelector("#contract-pill");
const accountDisplay = document.querySelector("#account-display");
const contractDisplay = document.querySelector("#contract-display");
const taskOutput = document.querySelector("#task-output");
const bidOutput = document.querySelector("#bid-output");
const activityLog = document.querySelector("#activity-log");
const marketList = document.querySelector("#market-list");
const bidderPanelMount = document.querySelector("#publisher-bidder-panel-root");

function el(id) {
  return document.getElementById(id);
}

function requiredEl(id) {
  const node = el(id);
  if (!node) {
    throw new Error(`missing DOM element: ${id}`);
  }
  return node;
}

async function ensureEthers() {
  if (ethers) {
    return ethers;
  }

  try {
    const module = await import("https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm");
    ethers = module.ethers;
    console.log("ethers loaded");
    return ethers;
  } catch (error) {
    console.error("failed to load ethers", error);
    throw new Error("无法加载 ethers.js，请检查浏览器网络、CDN 访问或刷新页面后重试。");
  }
}

function log(message, detail = "") {
  const wrapper = document.createElement("div");
  wrapper.className = "log-entry";
  wrapper.innerHTML = `
    <div class="log-meta">${new Date().toLocaleString()}</div>
    <div>${message}</div>
    ${detail ? `<div>${detail}</div>` : ""}
  `;
  activityLog.prepend(wrapper);
}

function setOutput(node, value) {
  node.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function shorten(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parseEthInput(id) {
  return ethers.parseEther(el(id).value.trim() || "0");
}

function textToBytes32(text, fieldName) {
  const raw = text.trim();
  if (!raw) {
    throw new Error(`${fieldName}不能为空`);
  }
  return ethers.id(raw);
}

function setCurrentTaskId(taskId) {
  state.currentTaskId = BigInt(taskId);
  el("shared-task-id").value = state.currentTaskId.toString();
  el("selected-task-id").value = state.currentTaskId.toString();
  state.currentTask = null;
  state.currentTaskView = null;
  refreshBidderPanelView();
}

function getPublisherTaskId() {
  setCurrentTaskId(el("shared-task-id").value.trim() || "1");
  return state.currentTaskId;
}

function getBidderTaskId() {
  setCurrentTaskId(el("selected-task-id").value.trim() || "1");
  return state.currentTaskId;
}

function requireContract() {
  if (!state.contract) {
    throw new Error("请先连接钱包，再点击“加载平台”。");
  }
  return state.contract;
}

function setContractAddress(address) {
  state.contractAddress = address;
  contractDisplay.value = address;
  contractPill.textContent = `合约已连接：${shorten(address)}`;
  contractPill.classList.remove("muted");
}

function setRole(role) {
  state.currentRole = role;
  el("publisher-view").classList.toggle("hidden", role !== "publisher");
  el("bidder-view").classList.toggle("hidden", role !== "bidder");
  el("show-publisher").classList.toggle("active", role === "publisher");
  el("show-bidder").classList.toggle("active", role === "bidder");
}

async function initBidderPanel() {
  if (!bidderPanelMount || bidderPanelRoot || BidderListPanelComponent) {
    return;
  }

  try {
    const [{ default: ReactModule }, { createRoot }, panelModule] = await Promise.all([
      import("https://esm.sh/react@18.3.1"),
      import("https://esm.sh/react-dom@18.3.1/client"),
      import("./react/BidderListPanel.js"),
    ]);

    ReactLib = ReactModule;
    bidderPanelRoot = createRoot(bidderPanelMount);
    BidderListPanelComponent = panelModule.BidderListPanel;
    console.log("bidder panel loaded");
  } catch (error) {
    console.error("failed to load bidder panel", error);
    log("投标人面板加载失败", "附加列表面板未加载，但基础按钮和合约交互仍可使用。");
  }
}

function refreshBidderPanelView() {
  if (!bidderPanelRoot || !ReactLib || !BidderListPanelComponent) {
    return;
  }

  bidderPanelRoot.render(
    ReactLib.createElement(BidderListPanelComponent, {
      taskId: state.currentTaskId,
      contract: state.contract,
      task: state.currentTask,
      refreshKey: state.bidderPanelRefreshKey,
      onRefresh: async () => {
        await runAction("刷新投标人列表", refreshTask);
      },
      onSelectWinner: async (bidderAddress) => {
        el("winner-address").value = bidderAddress;
        await runAction("选择中标人", () => selectWinnerForAddress(bidderAddress));
      },
    })
  );
}

function formatTask(task) {
  return {
    发布者: task.publisher,
    报酬ETH: ethers.formatEther(task.reward),
    发布押金ETH: ethers.formatEther(task.publisherStake),
    当前状态: getStatusText(task.status),
    中标人: task.selectedBidder,
    总投标数: Number(task.bidCount),
    已揭标数: Number(task.revealCount),
    竞标截止: new Date(Number(task.biddingDeadline) * 1000).toLocaleString(),
    揭标截止: new Date(Number(task.revealDeadline) * 1000).toLocaleString(),
    选标截止: new Date(Number(task.selectionDeadline) * 1000).toLocaleString(),
    执行截止: new Date(Number(task.deliveryDeadline) * 1000).toLocaleString(),
    验收截止: new Date(Number(task.reviewDeadline) * 1000).toLocaleString(),
    任务说明哈希: task.detailsHash,
    成果哈希: task.resultHash,
  };
}

function formatTaskView(taskView) {
  return {
    任务编号: taskView.id,
    任务标题: taskView.title,
    任务描述: taskView.description,
    当前状态: taskView.status,
    报酬ETH: taskView.reward,
    发布押金ETH: taskView.stake,
    总投标数: taskView.bidCount,
    已揭标数: taskView.revealCount,
    竞标截止: taskView.biddingDeadline,
    揭标截止: taskView.revealDeadline,
    选标截止: taskView.selectionDeadline,
    执行截止: taskView.deliveryDeadline,
    验收截止: taskView.reviewDeadline,
    任务说明哈希: taskView.detailsHash,
  };
}

function formatBid(bid) {
  return {
    能力证明哈希: bid.qualificationHash ?? bid[1],
    承诺值: bid.commitment ?? bid[0],
    投标押金ETH: ethers.formatEther(bid.bidderStake ?? bid[2]),
    揭标报价ETH: ethers.formatEther(bid.revealedPrice ?? bid[3]),
    是否已提交暗标: Boolean(bid.committed ?? bid[4]),
    是否已揭标: Boolean(bid.revealed ?? bid[5]),
    是否已中标: Boolean(bid.selected ?? bid[6]),
    是否已结算: Boolean(bid.processed ?? bid[7]),
  };
}

function explainError(error) {
  const message = [
    error?.shortMessage,
    error?.info?.error?.message,
    error?.reason,
    error?.message,
  ]
    .filter(Boolean)
    .join(" | ");

  if (message.includes("InvalidTimeline")) return "任务时间设置不合法，请检查各阶段时长。";
  if (message.includes("InvalidFunding")) return "金额不合法，请检查报酬、押金和账户余额。";
  if (message.includes("DeadlineNotReached")) return "当前还没到这个步骤的时间点，请稍后再试。";
  if (message.includes("DeadlinePassed")) return "这个步骤已经超过截止时间。";
  if (message.includes("Unauthorized")) return "当前钱包不是这一步应该使用的账户，请切换钱包后重试。";
  if (message.includes("missing revert data")) return "钱包没有返回更明确的错误，通常是账户、时间或金额不对。";
  return message || "未知错误";
}

async function runAction(label, fn) {
  try {
    const result = await fn();
    log(`${label}成功`, result ? String(result) : "");
    return result;
  } catch (error) {
    log(`${label}失败`, explainError(error));
    throw error;
  }
}

async function fetchJsonFromCandidates(paths, failureMessage) {
  let lastError = "";

  for (const path of paths) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        lastError = `${path} -> ${response.status}`;
        continue;
      }
      return { path, json: await response.json() };
    } catch (error) {
      lastError = `${path} -> ${error.message}`;
    }
  }

  throw new Error(`${failureMessage} ${lastError}`.trim());
}

async function connectWallet() {
  await ensureEthers();
  if (!window.ethereum) {
    throw new Error("浏览器没有检测到 MetaMask 或兼容钱包。");
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();

  const network = await state.provider.getNetwork();
  accountDisplay.value = state.account;
  walletPill.textContent = `已连接：${shorten(state.account)}`;
  walletPill.classList.remove("muted");
  networkPill.textContent = `Chain ID：${network.chainId.toString()}`;

  if (!state.contract) {
    try {
      await loadContract(true);
    } catch {
      // user can click manually
    }
  }
}

async function fetchDeploymentAddress() {
  await ensureEthers();
  try {
    const { json: deployment } = await fetchJsonFromCandidates(
      DEPLOYMENT_RECORD_PATHS,
      "读取最新部署记录失败。"
    );

    const fromReturns = deployment?.returns?.deployed?.value;
    if (fromReturns && ethers.isAddress(fromReturns)) {
      if (state.provider) {
        const code = await state.provider.getCode(fromReturns);
        if (code && code !== "0x") return fromReturns;
      } else {
        return fromReturns;
      }
    }

    const transaction = deployment?.transactions?.find((item) => item.contractName === "StakingTender");
    if (transaction?.contractAddress && ethers.isAddress(transaction.contractAddress)) {
      if (state.provider) {
        const code = await state.provider.getCode(transaction.contractAddress);
        if (code && code !== "0x") return transaction.contractAddress;
      } else {
        return transaction.contractAddress;
      }
    }
  } catch {
    // fallback below
  }

  if (state.provider) {
    for (const address of FALLBACK_CONTRACT_ADDRESSES) {
      const code = await state.provider.getCode(address);
      if (code && code !== "0x") return address;
    }
  }

  throw new Error("没有找到可用的合约地址。请先部署合约，再从项目根目录启动前端。");
}

async function loadContract(silent = false) {
  await ensureEthers();
  if (!state.signer) {
    await connectWallet();
  }

  const contractAddress = await fetchDeploymentAddress();
  const { json: artifact } = await fetchJsonFromCandidates(
    ARTIFACT_PATHS,
    "读取合约说明书失败。请确认你是从 staking-tender-system 根目录启动的静态服务。"
  );

  state.abi = artifact.abi;
  state.contract = new ethers.Contract(contractAddress, state.abi, state.signer);

  const code = await state.provider.getCode(contractAddress);
  if (!code || code === "0x") {
    throw new Error("当前链上没有这份 StakingTender 合约。请先启动 Anvil 并重新部署合约。");
  }

  try {
    await state.contract.nextTaskId();
  } catch {
    throw new Error("当前 ABI 与链上的合约不匹配。请重新部署最新合约后再加载平台。");
  }

  setContractAddress(contractAddress);
  refreshBidderPanelView();

  if (!silent) {
    log("平台加载成功", `合约地址 ${contractAddress}`);
  }
}

async function buildDeadlinesFromChain() {
  await ensureEthers();
  if (!state.provider) {
    await connectWallet();
  }

  const latestBlock = await state.provider.getBlock("latest");
  const chainNow = Number(latestBlock.timestamp);
  const browserNow = Math.floor(Date.now() / 1000);
  const baseNow = Math.max(chainNow, browserNow) + 5;
  const biddingMinutes = Number(el("create-bidding-minutes").value || 0);
  const revealMinutes = Number(el("create-reveal-minutes").value || 0);
  const executionMinutes = Number(el("create-execution-minutes").value || 0);
  const reviewMinutes = Number(el("create-review-minutes").value || 0);

  if (!Number.isFinite(biddingMinutes) || biddingMinutes <= 0) {
    throw new Error("竞标期必须大于 0 分钟");
  }
  if (!Number.isFinite(revealMinutes) || revealMinutes <= 0) {
    throw new Error("揭标期必须大于 0 分钟");
  }
  if (!Number.isFinite(executionMinutes) || executionMinutes <= 0) {
    throw new Error("执行期必须大于 0 分钟");
  }
  if (!Number.isFinite(reviewMinutes) || reviewMinutes <= 0) {
    throw new Error("验收期必须大于 0 分钟");
  }

  const bidding = Math.floor(biddingMinutes * 60);
  const reveal = Math.floor(revealMinutes * 60);
  const execution = Math.floor(executionMinutes * 60);
  const review = Math.floor(reviewMinutes * 60);
  const selectionWindow = 60;

  return {
    biddingDeadline: baseNow + bidding,
    revealDeadline: baseNow + bidding + reveal,
    selectionDeadline: baseNow + bidding + reveal + selectionWindow,
    deliveryDeadline: baseNow + bidding + reveal + selectionWindow + execution,
    reviewDeadline: baseNow + bidding + reveal + selectionWindow + execution + review,
  };
}

async function refreshTask() {
  await ensureEthers();
  const contract = requireContract();
  const taskId = getPublisherTaskId();
  const task = await contract.tasks(taskId);
  const effectiveStatus = await getTaskDisplayStatus(contract, taskId, task);
  const taskView = buildTaskViewModel(taskId, task, effectiveStatus);
  state.currentTask = task;
  state.currentTaskView = taskView;
  state.bidderPanelRefreshKey += 1;
  setOutput(taskOutput, formatTaskView(taskView));
  refreshBidderPanelView();
}

function getStatusLabel(status) {
  const statuses = {
    0: "None",
    1: "Bidding",
    2: "Reveal",
    3: "Selection",
    4: "InProgress",
    5: "Delivered",
    6: "Completed",
    7: "Cancelled",
    8: "Expired",
  };
  return statuses[Number(status)] || "Unknown";
}

function getStatusText(status) {
  const rawStatus = typeof status === "string" ? status : getStatusLabel(status);
  return TASK_I18N.status[rawStatus] || TASK_I18N.fallback.status;
}

function getComplexityText(level) {
  return TASK_I18N.complexity[level] || TASK_I18N.fallback.complexity;
}

function getProjectTypeText(type) {
  return TASK_I18N.projectType[type] || TASK_I18N.fallback.projectType;
}

function getTaskMetadata(taskId, task) {
  const store = loadTaskMetadataStore();
  const taskIdKey = taskId.toString();
  let storedMetadata = store.byTaskId[taskIdKey] ?? null;

  if ((!storedMetadata || !storedMetadata.description) && task.detailsHash) {
    const hashMetadata = store.byDetailsHash[task.detailsHash] ?? null;
    if (hashMetadata?.description) {
      storedMetadata = {
        ...storedMetadata,
        ...hashMetadata,
        taskId: taskIdKey,
      };
      store.byTaskId[taskIdKey] = storedMetadata;
      saveTaskMetadataStore(store);
    }
  }

  const rewardEth = Number(ethers.formatEther(task.reward));
  const bidCount = Number(task.bidCount);
  const complexity =
    storedMetadata?.complexity ||
    (rewardEth >= 1.5 || bidCount >= 4 ? "High" : rewardEth >= 0.7 || bidCount >= 2 ? "Medium" : "Low");
  const complexityScore = complexity === "High" ? 82 : complexity === "Medium" ? 58 : 28;
  const effort = storedMetadata?.effort || inferTaskEffort(complexity);
  const recommendedBidRange = storedMetadata?.recommendedBidRange || inferRecommendedBidRange(rewardEth, complexity);
  const tags =
    Array.isArray(storedMetadata?.tags) && storedMetadata.tags.length
      ? storedMetadata.tags
      : ["综合任务", complexity === "High" ? "高投入" : "可快速评估"];

  return {
    title: storedMetadata?.title || `任务 #${taskIdKey}`,
    description: storedMetadata?.description || "暂无任务描述，请查看任务详情",
    tags,
    complexity,
    complexityScore,
    effort,
    recommendedBidRange,
    source: storedMetadata?.source || "fallback",
  };
}

function buildTaskViewModel(taskId, task, effectiveStatus, metadata = null) {
  const taskIdKey = taskId.toString();
  const resolvedMetadata = metadata ?? getTaskMetadata(taskId, task);
  const statusKey = getStatusLabel(effectiveStatus);
  const title =
    resolvedMetadata?.title && resolvedMetadata.title.trim()
      ? resolvedMetadata.title.trim()
      : `任务 #${taskIdKey}`;
  const rawDescription = resolvedMetadata?.description?.trim() || "";
  const description =
    rawDescription && rawDescription !== title ? rawDescription : "暂无任务描述，请查看任务详情";

  return {
    id: Number(taskId),
    title,
    description,
    reward: ethers.formatEther(task.reward),
    stake: ethers.formatEther(task.publisherStake),
    status: getStatusText(statusKey),
    statusKey,
    bidCount: Number(task.bidCount),
    revealCount: Number(task.revealCount),
    detailsHash: task.detailsHash,
    resultHash: task.resultHash,
    publisher: task.publisher,
    selectedBidder: task.selectedBidder,
    biddingDeadline: new Date(Number(task.biddingDeadline) * 1000).toLocaleString(),
    revealDeadline: new Date(Number(task.revealDeadline) * 1000).toLocaleString(),
    selectionDeadline: new Date(Number(task.selectionDeadline) * 1000).toLocaleString(),
    deliveryDeadline: new Date(Number(task.deliveryDeadline) * 1000).toLocaleString(),
    reviewDeadline: new Date(Number(task.reviewDeadline) * 1000).toLocaleString(),
    complexity: resolvedMetadata?.complexity,
    complexityScore: resolvedMetadata?.complexityScore,
    effort: resolvedMetadata?.effort,
    recommendedBidRange: resolvedMetadata?.recommendedBidRange,
    tags: resolvedMetadata?.tags ?? [],
  };
}

async function getTaskDisplayStatus(contract, taskId, task) {
  await ensureEthers();
  if (contract?.getTaskEffectiveStatus) {
    try {
      return await contract.getTaskEffectiveStatus(taskId);
    } catch {
      return task.status;
    }
  }
  return task.status;
}

function truncateText(text, maxLength = 96) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

async function refreshMarketplace() {
  await ensureEthers();
  const contract = requireContract();
  const nextTaskId = await contract.nextTaskId();
  const ids = [];

  for (let id = 1n; id < nextTaskId; id += 1n) {
    ids.push(id);
  }

  const taskCards = await Promise.all(
    ids.map(async (taskId) => {
      const task = await contract.tasks(taskId);
      if (task.publisher === ethers.ZeroAddress) {
        return null;
      }

      const effectiveStatus = await getTaskDisplayStatus(contract, taskId, task);
      const metadata = getTaskMetadata(taskId, task);
      const taskView = buildTaskViewModel(taskId, task, effectiveStatus, metadata);
      return buildTaskCard(taskView);
    })
  );

  marketList.innerHTML = "";
  const cards = taskCards.filter(Boolean);
  if (!cards.length) {
    marketList.innerHTML = `<div class="task-card empty-market"><div class="task-title">平台暂时没有可投标任务</div><div class="task-meta">先让招标人发布一个任务，或者稍后点击“刷新平台任务”再看一眼。</div></div>`;
    return;
  }

  cards.forEach((card) => marketList.appendChild(card));
}

function buildTaskCard(taskView) {
  const card = document.createElement("article");
  card.className = "task-card market-card";
  const statusKey = taskView.statusKey;
  const statusLabel = taskView.status;
  const complexityLabel = getComplexityText(taskView.complexity);
  const projectTypeLabel = getProjectTypeText(taskView.effort);
  const shortDescription = truncateText(taskView.description, 92);

  card.innerHTML = `
    <div class="task-card-head market-card-head">
      <div class="task-header-stack">
        <div class="task-kicker">任务 #${taskView.id}</div>
        <div class="task-title-row">
          <h3 class="task-title">${taskView.title}</h3>
          <span class="badge status-${statusKey.toLowerCase()}">${statusLabel}</span>
        </div>
        <div class="task-badges">
          <span class="badge complexity-${(taskView.complexity || "Low").toLowerCase()}">${complexityLabel}</span>
          <span class="badge muted">${projectTypeLabel}</span>
          <span class="badge muted">复杂度评分 ${taskView.complexityScore}/100</span>
        </div>
      </div>
      <button class="button ghost choose-task" data-task-id="${taskView.id}">选择这个任务</button>
    </div>

    <p class="task-description-preview">${shortDescription}</p>

    <div class="task-financial-grid">
      <div class="task-financial-item">
        <div class="task-financial-label">报酬</div>
        <div class="task-financial-value">${taskView.reward} ETH</div>
      </div>
      <div class="task-financial-item">
        <div class="task-financial-label">发布押金</div>
        <div class="task-financial-value">${taskView.stake} ETH</div>
      </div>
      <div class="task-financial-item">
        <div class="task-financial-label">当前投标数</div>
        <div class="task-financial-value">${taskView.bidCount}</div>
      </div>
      <div class="task-financial-item">
        <div class="task-financial-label">建议报价区间</div>
        <div class="task-financial-value">${taskView.recommendedBidRange}</div>
      </div>
    </div>

    <div class="task-tags">
      ${taskView.tags.map((tag) => `<span class="tag-chip">${tag}</span>`).join("")}
    </div>

    <details class="task-details-panel">
      <summary>查看详情</summary>
      <div class="task-details-grid">
        <div class="task-detail-block">
          <div class="task-detail-title">完整任务说明</div>
          <div class="task-detail-text">${taskView.description}</div>
        </div>
        <div class="task-detail-block">
          <div class="task-detail-title">任务判断提示</div>
          <ul class="task-detail-list">
            <li>当前状态：${statusLabel}</li>
            <li>预计投入：${projectTypeLabel}</li>
            <li>推荐出价：${taskView.recommendedBidRange}</li>
            <li>揭标截止：${taskView.revealDeadline}</li>
          </ul>
        </div>
        <div class="task-detail-block subtle-block">
          <div class="task-detail-title">链上数据与前端说明的分工</div>
          <div class="task-detail-text">链上真实数据包含报酬、押金、投标数和状态。标题、描述、标签、复杂度与建议报价区间属于前端元数据层，当前用于帮助投标人更快理解任务。</div>
          <div class="task-detail-foot mono mini">detailsHash: ${taskView.detailsHash}</div>
        </div>
      </div>
    </details>
  `;

  card.querySelector(".choose-task").addEventListener("click", () => {
    console.log("clicked: choose-task");
    setCurrentTaskId(taskView.id);
    setRole("bidder");
    log("已选择任务", `任务 ID ${taskView.id}，可以直接在右侧开始投标。`);
  });

  return card;
}
async function readMyBid() {
  await ensureEthers();
  const contract = requireContract();
  if (!state.account) {
    await connectWallet();
  }

  const taskId = getBidderTaskId();
  const bid = await contract.getBid(taskId, state.account);
  setOutput(bidOutput, formatBid(bid));
}

async function createTask() {
  await ensureEthers();
  const contract = requireContract();
  const reward = parseEthInput("create-reward");
  const publisherStake = parseEthInput("create-publisher-stake");
  const descriptionText = el("task-description").value.trim();
  const descriptionHash = textToBytes32(descriptionText, "任务说明");
  const metadata = buildTaskMetadataFromInput({
    description: descriptionText,
    reward,
  });
  persistTaskMetadata({
    detailsHash: descriptionHash,
    metadata,
  });
  const deadlines = await buildDeadlinesFromChain();
  const totalValue = reward + publisherStake;

  const tx = await contract.createTask(
    descriptionHash,
    reward,
    publisherStake,
    deadlines.biddingDeadline,
    deadlines.revealDeadline,
    deadlines.selectionDeadline,
    deadlines.deliveryDeadline,
    deadlines.reviewDeadline,
    { value: totalValue }
  );

  const receipt = await tx.wait();

  for (const logItem of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(logItem);
      if (parsed?.name === "TaskCreated") {
        setCurrentTaskId(parsed.args.taskId);
        persistTaskMetadata({
          taskId: parsed.args.taskId,
          detailsHash: descriptionHash,
          metadata,
        });
        break;
      }
    } catch {
      // ignore unrelated logs
    }
  }

  await refreshTask();
  await refreshMarketplace();
  return `任务 ID ${state.currentTaskId.toString()}`;
}

async function commitBid() {
  await ensureEthers();
  const contract = requireContract();
  const taskId = getBidderTaskId();
  const quote = parseEthInput("commit-quote");
  const stake = parseEthInput("commit-stake");
  const salt = ethers.id(el("commit-salt").value.trim());
  const proofHash = textToBytes32(el("proof-text").value, "能力证明说明");
  const commitment = await contract.buildCommitment(quote, salt);

  const tx = await contract.commitBid(taskId, commitment, proofHash, { value: stake });
  await tx.wait();
  await readMyBid();
  await refreshMarketplace();
}

async function revealBid() {
  await ensureEthers();
  const contract = requireContract();
  const taskId = getBidderTaskId();
  const quote = parseEthInput("reveal-quote");
  const salt = ethers.id(el("reveal-salt").value.trim());

  const tx = await contract.revealBid(taskId, quote, salt);
  await tx.wait();
  await readMyBid();
  await refreshMarketplace();
}

async function selectWinnerForAddress(bidder) {
  await ensureEthers();
  const contract = requireContract();
  const taskId = getPublisherTaskId();
  if (!ethers.isAddress(bidder)) {
    throw new Error("请输入合法的中标人地址。");
  }

  const tx = await contract.selectWinner(taskId, bidder);
  await tx.wait();
  await refreshTask();
  await refreshMarketplace();
}

async function selectWinner() {
  const bidder = el("winner-address").value.trim();
  await selectWinnerForAddress(bidder);
}

async function submitWork() {
  await ensureEthers();
  const contract = requireContract();
  const taskId = getBidderTaskId();
  const submissionHash = textToBytes32(el("submission-text").value, "成果说明");

  const tx = await contract.submitWork(taskId, submissionHash);
  await tx.wait();
  await refreshMarketplace();
}

async function simpleTaskAction(methodName) {
  await ensureEthers();
  const contract = requireContract();
  const taskId = state.currentRole === "publisher" ? getPublisherTaskId() : getBidderTaskId();
  const tx = await contract[methodName](taskId);
  await tx.wait();
  await refreshTask().catch(() => {});
  await refreshMarketplace().catch(() => {});
}

function wireEvents() {
  const bindButton = (id, label, handler) => {
    const button = requiredEl(id);
    button.addEventListener("click", async () => {
      console.log(`clicked: ${id}`);
      await runAction(label, handler);
    });
  };

  bindButton("connect-wallet", "连接钱包", connectWallet);
  bindButton("load-contract", "加载平台", loadContract);
  bindButton("refresh-market", "刷新平台任务", refreshMarketplace);
  bindButton("refresh-market-inline", "刷新平台任务", refreshMarketplace);

  bindButton("show-publisher", "切换到招标人视图", async () => setRole("publisher"));
  bindButton("show-bidder", "切换到投标人视图", async () => setRole("bidder"));

  requiredEl("shared-task-id").addEventListener("change", () => {
    console.log("changed: shared-task-id");
    setCurrentTaskId(el("shared-task-id").value || "1");
  });
  requiredEl("selected-task-id").addEventListener("change", () => {
    console.log("changed: selected-task-id");
    setCurrentTaskId(el("selected-task-id").value || "1");
  });

  bindButton("create-task", "发布招标任务", createTask);
  bindButton("refresh-task", "刷新任务信息", refreshTask);
  bindButton("select-winner", "选择中标人", selectWinner);
  bindButton("approve-work", "验收通过", async () => simpleTaskAction("approveWork"));

  bindButton("commit-bid", "提交投标", commitBid);
  bindButton("read-my-bid", "查看我的投标", readMyBid);
  bindButton("reveal-bid", "揭标", revealBid);
  bindButton("submit-work", "提交成果", submitWork);

  bindButton("claim-refund", "领取落标押金", async () => simpleTaskAction("claimBidRefund"));
  bindButton("claim-review-timeout", "验收超时索赔", async () => simpleTaskAction("claimReviewTimeout"));
  bindButton("claim-execution-default", "执行超时索赔", async () => simpleTaskAction("claimExecutionDefault"));
  bindButton("reclaim-idle-task", "回收闲置任务", async () => simpleTaskAction("reclaimIdleTask"));
  bindButton("cancel-task", "取消任务", async () => simpleTaskAction("cancelTask"));

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts.length) {
        walletPill.textContent = "钱包未连接";
        accountDisplay.value = "";
        return;
      }
      state.account = accounts[0];
      accountDisplay.value = state.account;
      walletPill.textContent = `已连接：${shorten(state.account)}`;
      log("账户已切换", "建议重新点击一次“连接钱包”和“加载平台”。");
    });
  }
}

async function initializeApp() {
  console.log("initializing app");
  await initBidderPanel();
  wireEvents();
  setCurrentTaskId(1n);
  setOutput(taskOutput, "这里会显示招标人当前任务的链上状态。");
  setOutput(bidOutput, "这里会显示当前钱包在所选任务下的投标记录。");
  marketList.innerHTML = `<div class="task-card empty-market"><div class="task-title">请先连接钱包并加载平台</div><div class="task-meta">完成后点击“刷新平台任务”，这里会显示带任务说明和复杂度提示的投标市场列表。</div></div>`;
  log("页面已就绪", "建议顺序：连接钱包 -> 加载平台 -> 选择身份 -> 开始操作。");
  console.log("app initialized");
}

document.addEventListener("DOMContentLoaded", () => {
  initializeApp().catch((error) => {
    console.error("app init failed", error);
  });
});

window.addEventListener("error", (event) => {
  console.error("window error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("unhandled rejection", event.reason);
});
