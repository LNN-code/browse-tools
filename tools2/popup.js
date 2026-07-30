const DEFAULT_CONFIG = {
  siteKey: "",
  selector: "a[href]",
  detailContainerSelector: "",
  detailOpenMode: "sameTab",
  count: 10,
  startIndex: 0,
  beforeClickDelay: 800,
  afterLoadDelay: 1200,
  pinCurrentPage: false,
  saveToLocal: true,
  autoCommunicate: false,
  matchThreshold: 80
};

const LEGACY_LAST_CONFIG_KEY = "sda:lastConfig";
const SITE_CONFIGS_KEY = "sda:siteConfigs";
const RESUME_TEXT_KEY = "sda:resumeText";
const RESUME_META_KEY = "sda:resumeMeta";
const DEEPSEEK_KEY_KEY = "sda:deepseekApiKey";
const LAST_MATCH_RESULT_KEY = "sda:lastMatchResult";

const SITE_PROFILES = {
  zhipin: {
    hosts: ["zhipin.com", "bosszhipin.com"],
    label: "BOSS 直聘",
    preset: {
      siteKey: "zhipin",
      selector: ".job-card-wrapper, .job-card-box",
      detailContainerSelector: ".job-detail-container, .job-detail-box, .job-detail",
      detailOpenMode: "samePage"
    }
  },
  zhaopin: {
    hosts: ["zhaopin.com", "zhaopin.cn"],
    label: "智联招聘",
    preset: {
      siteKey: "zhaopin",
      selector: ".joblist-box__item, .joblist-box__iteminfo, .job-item, a[href*='jobs.zhaopin.com'], a[href*='/jobdetail/']",
      detailContainerSelector: ".job-detail, .job-detail-container, .job-detail__container, .position-detail, .job-intro, .detail-container, .summary-plane, .describtion, .description",
      detailOpenMode: "newTab"
    }
  }
};

const statusText = document.getElementById("statusText");
const configSummaryText = document.getElementById("configSummaryText");
const resumeStatusText = document.getElementById("resumeStatusText");
const messageText = document.getElementById("messageText");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const nextButton = document.getElementById("nextButton");
const scoreButton = document.getElementById("scoreButton");
const optionsButton = document.getElementById("optionsButton");
const refreshButton = document.getElementById("refreshButton");
const matchResult = document.getElementById("matchResult");

let activeTab = null;
let activeConfig = { ...DEFAULT_CONFIG };

document.addEventListener("DOMContentLoaded", init);
startButton.addEventListener("click", startRun);
stopButton.addEventListener("click", stopRun);
nextButton.addEventListener("click", nextItem);
scoreButton.addEventListener("click", scoreCurrentJob);
optionsButton.addEventListener("click", openOptions);
refreshButton.addEventListener("click", refreshState);

async function init() {
  nextButton.disabled = true;
  await refreshState();
}

async function refreshState() {
  try {
    activeTab = await getActiveTab();
    await refreshResumeSummary();
    await renderLastMatchResult();

    if (!activeTab?.id || !activeTab.url || isRestrictedUrl(activeTab.url)) {
      setStatus("当前页面不支持运行扩展。请切换到普通网页。");
      configSummaryText.textContent = "无法读取当前站点配置。";
      nextButton.disabled = true;
      return;
    }

    activeConfig = normalizeConfigForSite(await readLastConfig(activeTab.url), activeTab.url);
    renderConfigSummary(activeConfig, activeTab.url);

    await ensureContentScript(activeTab.id);
    const response = await sendMessage(activeTab.id, { type: "GET_STATUS", tabId: activeTab.id });
    if (response?.state?.config) {
      activeConfig = response.state.config;
      setStatus(formatStatus(response.state));
      renderConfigSummary(activeConfig, activeTab.url);
      nextButton.disabled = !response.state.running;
      return;
    }

    setStatus("未运行。点击开始将使用当前保存的设置。");
    nextButton.disabled = true;
  } catch (error) {
    setStatus("无法读取当前页面。请刷新页面后再试。");
    setMessage(error?.message ?? String(error));
  }
}

async function startRun() {
  if (!activeTab?.id) {
    return;
  }

  try {
    activeConfig = normalizeConfigForSite(await readLastConfig(activeTab.url), activeTab.url);
    if (activeConfig.autoCommunicate) {
      const data = await chrome.storage.local.get([DEEPSEEK_KEY_KEY, RESUME_TEXT_KEY]);
      if (!String(data[DEEPSEEK_KEY_KEY] || "").trim()) {
        throw new Error("开启自动沟通前，请先到设置页填写 DeepSeek API Key。");
      }
      if (!String(data[RESUME_TEXT_KEY] || "").trim()) {
        throw new Error("开启自动沟通前，请先到设置页上传或粘贴简历。");
      }
    }

    await ensureContentScript(activeTab.id);
    const response = await sendMessage(activeTab.id, {
      type: "START_RUN",
      tabId: activeTab.id,
      config: activeConfig
    });

    if (!response?.ok) {
      throw new Error(response?.error || "启动失败。");
    }

    setStatus("已启动。请保持当前标签页打开。");
    renderConfigSummary(activeConfig, activeTab.url);
    setMessage("页面右下角会显示执行进度。");
    nextButton.disabled = false;
  } catch (error) {
    setMessage(error?.message ?? String(error));
  }
}

async function stopRun() {
  if (!activeTab?.id) {
    return;
  }

  try {
    await ensureContentScript(activeTab.id);
    await sendMessage(activeTab.id, { type: "STOP_RUN", tabId: activeTab.id });
    setStatus("已停止。");
    setMessage("");
    nextButton.disabled = true;
  } catch (error) {
    setMessage(error?.message ?? String(error));
  }
}

async function nextItem() {
  if (!activeTab?.id) {
    return;
  }

  try {
    await ensureContentScript(activeTab.id);
    const response = await sendMessage(activeTab.id, { type: "NEXT_ITEM", tabId: activeTab.id });
    if (!response?.ok) {
      throw new Error(response?.error || "无法切换到下一条。");
    }

    setMessage(response?.message || "已切换到下一条。");
    setStatus(formatStatus(response.state || { running: true, mode: "list", completed: 0, config: activeConfig }));
  } catch (error) {
    setMessage(error?.message ?? String(error));
  }
}

async function scoreCurrentJob() {
  if (!activeTab?.id) {
    return;
  }

  scoreButton.disabled = true;
  scoreButton.textContent = "评分中...";
  setMessage("正在提取当前岗位并调用 DeepSeek。");
  matchResult.hidden = true;

  try {
    const data = await chrome.storage.local.get([DEEPSEEK_KEY_KEY, RESUME_TEXT_KEY]);
    const apiKey = String(data[DEEPSEEK_KEY_KEY] || "").trim();
    const resumeText = String(data[RESUME_TEXT_KEY] || "").trim();
    if (!apiKey) {
      throw new Error("请先到设置页填写 DeepSeek API Key。");
    }
    if (!resumeText) {
      throw new Error("请先到设置页上传或粘贴简历。");
    }

    await ensureContentScript(activeTab.id);
    const jobResponse = await sendMessage(activeTab.id, { type: "GET_JOB_CONTEXT", tabId: activeTab.id }).catch((error) => ({
      ok: false,
      error: error?.message || String(error)
    }));
    const response = await chrome.runtime.sendMessage({
      type: "MATCH_JOB_WITH_RESUME",
      apiKey,
      resumeText,
      jobContext: jobResponse?.ok ? jobResponse.context : null
    });

    if (!response?.ok) {
      throw new Error(response?.error || "评分失败。");
    }

    await chrome.storage.local.set({
      [LAST_MATCH_RESULT_KEY]: {
        result: response.result,
        jobContext: response.jobContext,
        updatedAt: Date.now()
      }
    });

    renderMatchResult(response.result, response.jobContext);
    setMessage("评分完成。");
  } catch (error) {
    setMessage(error?.message ?? String(error));
    renderError(error?.message ?? String(error));
  } finally {
    scoreButton.disabled = false;
    scoreButton.textContent = "评分当前岗位";
  }
}

function openOptions() {
  const siteKey = getSiteKey(activeTab?.url || "") || "generic";
  const params = new URLSearchParams({
    site: siteKey
  });
  if (Number.isInteger(activeTab?.id)) {
    params.set("targetTabId", String(activeTab.id));
  }
  chrome.tabs.create({
    url: chrome.runtime.getURL(`options.html?${params.toString()}`)
  });
}

async function refreshResumeSummary() {
  const data = await chrome.storage.local.get([RESUME_TEXT_KEY, RESUME_META_KEY, DEEPSEEK_KEY_KEY]);
  const length = String(data[RESUME_TEXT_KEY] || "").trim().length;
  const hasKey = Boolean(String(data[DEEPSEEK_KEY_KEY] || "").trim());
  const name = data[RESUME_META_KEY]?.name ? ` · ${data[RESUME_META_KEY].name}` : "";
  const resumeText = length ? `简历：已导入 ${length.toLocaleString()} 字${name}` : "简历：未导入";
  const keyText = hasKey ? "DeepSeek Key：已保存" : "DeepSeek Key：未填写";
  resumeStatusText.textContent = `${resumeText}；${keyText}`;
}

async function renderLastMatchResult() {
  const data = await chrome.storage.local.get(LAST_MATCH_RESULT_KEY);
  if (data[LAST_MATCH_RESULT_KEY]?.result) {
    renderMatchResult(data[LAST_MATCH_RESULT_KEY].result, data[LAST_MATCH_RESULT_KEY].jobContext);
  }
}

function renderConfigSummary(config, url = "") {
  const siteKey = config.siteKey || getSiteKey(url) || "";
  const siteLabel = SITE_PROFILES[siteKey]?.label || "通用站点";
  const nextMode = config.pinCurrentPage ? "手动下一条" : "自动下一条";
  const saveMode = config.saveToLocal === false ? "不保存本地" : "保存本地";
  const autoChat = config.autoCommunicate ? `达标自动沟通，阈值 ${config.matchThreshold}` : "不自动沟通";
  configSummaryText.textContent = `${siteLabel}；${nextMode}；${config.count} 条，从第 ${(config.startIndex ?? 0) + 1} 条开始；${saveMode}；${autoChat}`;
}

async function readLastConfig(url = "") {
  const data = await chrome.storage.local.get([LEGACY_LAST_CONFIG_KEY, SITE_CONFIGS_KEY]);
  const savedConfig = data[LEGACY_LAST_CONFIG_KEY];
  const savedSiteConfigs = isPlainObject(data[SITE_CONFIGS_KEY]) ? data[SITE_CONFIGS_KEY] : {};
  const siteKey = getSiteKey(url);
  const sitePreset = getSitePreset(url);

  if (siteKey && savedSiteConfigs[siteKey]) {
    return mergeConfig(sitePreset, savedSiteConfigs[siteKey]);
  }

  if (sitePreset) {
    if (savedConfig && isGenericListSelector(savedConfig.selector)) {
      return mergeConfig(savedConfig, sitePreset);
    }
    if (savedConfig && shouldUseLegacyConfigForSite(savedConfig, siteKey)) {
      return mergeConfig(sitePreset, savedConfig);
    }
    return mergeConfig(sitePreset);
  }

  return mergeConfig(savedConfig);
}

function mergeConfig(...configs) {
  return configs.reduce(
    (merged, config) => (isPlainObject(config) ? { ...merged, ...config } : merged),
    { ...DEFAULT_CONFIG }
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldUseLegacyConfigForSite(config, siteKey) {
  const selector = String(config?.selector || "").toLowerCase();
  if (siteKey === "zhipin") {
    return true;
  }
  if (siteKey === "zhaopin") {
    return selector.includes("zhaopin") || selector.includes("joblist-box");
  }
  return false;
}

function normalizeConfigForSite(config, url = "") {
  const sitePreset = getSitePreset(url);
  if (!sitePreset) {
    return config;
  }

  return {
    ...config,
    siteKey: sitePreset.siteKey || config.siteKey,
    selector: isGenericListSelector(config.selector) ? sitePreset.selector : config.selector,
    detailContainerSelector: config.detailContainerSelector || sitePreset.detailContainerSelector,
    detailOpenMode: config.detailOpenMode === DEFAULT_CONFIG.detailOpenMode ? sitePreset.detailOpenMode : config.detailOpenMode
  };
}

function getSiteKey(url) {
  try {
    const { hostname } = new URL(url);
    const normalizedHost = hostname.toLowerCase();

    return Object.entries(SITE_PROFILES).find(([, profile]) =>
      profile.hosts.some((host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`))
    )?.[0] ?? null;
  } catch {
    return null;
  }
}

function getSitePreset(url) {
  const siteKey = getSiteKey(url);
  if (!siteKey) {
    return null;
  }

  return {
    ...SITE_PROFILES[siteKey].preset
  };
}

function isGenericListSelector(selector) {
  const normalized = String(selector || "").trim().toLowerCase().replace(/\s+/g, "");
  return normalized === "" || normalized === "a" || normalized === "a[href]" || normalized === "a[href]:not([target])";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"]
    });
    await sendMessage(tabId, { type: "PING" });
  }
}

function sendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function isRestrictedUrl(url) {
  return /^(chrome|edge|brave|opera|vivaldi|about|devtools):\/\//i.test(url);
}

function formatStatus(state) {
  if (!state?.running) {
    return "未运行。点击开始将使用当前保存的设置。";
  }

  const nextMode = state.config?.pinCurrentPage ? "手动下一条" : "自动下一条";
  return `运行中：${state.completed}/${state.config.count}，${formatMode(state.mode)}，${nextMode}`;
}

function formatMode(mode) {
  const labels = {
    list: "列表页",
    detail: "详情页",
    returning: "返回中",
    waitingDetailTab: "等待详情标签",
    waitingNextItem: "等待下一条",
    waitingNextPage: "等待手动翻页",
    done: "已完成"
  };

  return labels[mode] ?? "准备中";
}

function renderMatchResult(result, jobContext = null) {
  const score = Number.parseInt(result?.score, 10);
  const safeScore = Number.isFinite(score) ? score : 0;
  const title = [jobContext?.jobTitle, jobContext?.companyName].filter(Boolean).join(" · ");
  matchResult.hidden = false;
  matchResult.classList.remove("error");
  matchResult.innerHTML = [
    `<div class="score">${escapeHtml(String(safeScore))}<span class="muted">/100</span></div>`,
    `<div><strong>${escapeHtml(result?.level || "未分级")}</strong>${title ? ` <span class="muted">${escapeHtml(title)}</span>` : ""}</div>`,
    `<p>${escapeHtml(result?.summary || "DeepSeek 已返回评分。")}</p>`,
    renderList("优势", result?.strengths),
    renderList("差距", result?.gaps),
    renderList("建议", result?.suggestions),
    renderTags(result?.evidence)
  ].filter(Boolean).join("");
}

function renderError(message) {
  matchResult.hidden = false;
  matchResult.classList.add("error");
  matchResult.textContent = message;
}

function renderList(title, items) {
  const list = normalizeArray(items);
  if (!list.length) {
    return "";
  }

  return [
    `<div><strong>${escapeHtml(title)}</strong></div>`,
    `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
  ].join("");
}

function renderTags(items) {
  const list = normalizeArray(items);
  if (!list.length) {
    return "";
  }

  return `<div class="tags">${list.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>`;
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  const text = String(value || "").trim();
  return text ? [text] : [];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(text) {
  statusText.textContent = text;
}

function setMessage(text) {
  messageText.textContent = text;
}
