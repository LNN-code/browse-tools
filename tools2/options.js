import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.mjs");

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
    label: "BOSS 直聘",
    preset: {
      siteKey: "zhipin",
      selector: ".job-card-wrapper, .job-card-box",
      detailContainerSelector: ".job-detail-container, .job-detail-box, .job-detail",
      detailOpenMode: "samePage"
    }
  },
  zhaopin: {
    label: "智联招聘",
    preset: {
      siteKey: "zhaopin",
      selector: ".joblist-box__item, .joblist-box__iteminfo, .job-item, a[href*='jobs.zhaopin.com'], a[href*='/jobdetail/']",
      detailContainerSelector: ".job-detail, .job-detail-container, .job-detail__container, .position-detail, .job-intro, .detail-container, .summary-plane, .describtion, .description",
      detailOpenMode: "newTab"
    }
  },
  generic: {
    label: "通用站点",
    preset: {
      ...DEFAULT_CONFIG
    }
  }
};

const fields = {
  selector: document.getElementById("selectorInput"),
  detailContainerSelector: document.getElementById("detailContainerInput"),
  count: document.getElementById("countInput"),
  startIndex: document.getElementById("startIndexInput"),
  beforeClickDelay: document.getElementById("beforeClickDelayInput"),
  afterLoadDelay: document.getElementById("afterLoadDelayInput"),
  saveToLocal: document.getElementById("saveToLocalInput"),
  autoCommunicate: document.getElementById("autoCommunicateInput"),
  matchThreshold: document.getElementById("matchThresholdInput")
};

const nextModeInputs = Array.from(document.querySelectorAll("input[name='nextMode']"));
const pageStatusText = document.getElementById("pageStatusText");
const resumeStatusText = document.getElementById("resumeStatusText");
const messageText = document.getElementById("messageText");
const saveButton = document.getElementById("saveButton");
const resetButton = document.getElementById("resetButton");
const clearResumeButton = document.getElementById("clearResumeButton");
const resumeFileInput = document.getElementById("resumeFileInput");
const resumeTextInput = document.getElementById("resumeTextInput");
const deepseekKeyInput = document.getElementById("deepseekKeyInput");
const profileButtons = Array.from(document.querySelectorAll("[data-profile]"));

const query = new URLSearchParams(location.search);
const targetTabId = Number.parseInt(query.get("targetTabId") || "", 10);
let selectedProfileKey = normalizeProfileKey(query.get("site")) || "generic";
let resumeSaveTimer = null;

document.addEventListener("DOMContentLoaded", init);
saveButton.addEventListener("click", saveAllSettings);
resetButton.addEventListener("click", resetCurrentProfile);
clearResumeButton.addEventListener("click", clearResume);
resumeFileInput.addEventListener("change", handleResumeFile);
resumeTextInput.addEventListener("input", scheduleResumeSave);
deepseekKeyInput.addEventListener("input", saveDeepSeekKey);
profileButtons.forEach((button) => {
  button.addEventListener("click", () => switchProfile(button.dataset.profile));
});

async function init() {
  await loadResumeState();
  await switchProfile(selectedProfileKey, { quiet: true });
  setMessage("设置会按站点分别保存。保存后会尝试同步到当前运行中的页面。");
}

async function switchProfile(profileKey, options = {}) {
  selectedProfileKey = normalizeProfileKey(profileKey) || "generic";
  setActiveProfile(selectedProfileKey);
  const config = await readConfigForProfile(selectedProfileKey);
  fillForm(config);
  pageStatusText.textContent = `正在编辑：${SITE_PROFILES[selectedProfileKey].label}`;
  if (!options.quiet) {
    setMessage(`已切换到 ${SITE_PROFILES[selectedProfileKey].label} 配置。`);
  }
}

async function saveAllSettings() {
  try {
    const config = readForm();
    await saveConfigForProfile(selectedProfileKey, config);
    await saveDeepSeekKey();
    await saveResumeText();
    const synced = await syncRunningConfig(config);
    setMessage(synced === false ? "设置已保存，但当前运行页面未同步。刷新弹窗或重新开始后会使用新设置。" : "设置已保存。");
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  }
}

async function resetCurrentProfile() {
  try {
    const preset = mergeConfig(SITE_PROFILES[selectedProfileKey]?.preset);
    fillForm(preset);
    await saveConfigForProfile(selectedProfileKey, readForm());
    const synced = await syncRunningConfig(readForm());
    setMessage(
      synced === false
        ? `${SITE_PROFILES[selectedProfileKey].label} 已恢复默认值，但当前运行页面未同步。`
        : `${SITE_PROFILES[selectedProfileKey].label} 已恢复默认值。`
    );
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  }
}

function readForm() {
  const profile = SITE_PROFILES[selectedProfileKey] || SITE_PROFILES.generic;
  const profilePreset = profile.preset || DEFAULT_CONFIG;
  return {
    siteKey: selectedProfileKey === "generic" ? "" : selectedProfileKey,
    selector: fields.selector.value.trim() || DEFAULT_CONFIG.selector,
    detailContainerSelector: fields.detailContainerSelector.value.trim(),
    detailOpenMode: profilePreset.detailOpenMode || DEFAULT_CONFIG.detailOpenMode,
    count: readInt(fields.count.value, 1, 999, DEFAULT_CONFIG.count),
    startIndex: readInt(fields.startIndex.value, 1, 999, 1) - 1,
    beforeClickDelay: readInt(fields.beforeClickDelay.value, 0, 10000, DEFAULT_CONFIG.beforeClickDelay),
    afterLoadDelay: readInt(fields.afterLoadDelay.value, 0, 15000, DEFAULT_CONFIG.afterLoadDelay),
    pinCurrentPage: getNextMode() === "manual",
    saveToLocal: Boolean(fields.saveToLocal.checked),
    autoCommunicate: Boolean(fields.autoCommunicate.checked),
    matchThreshold: readInt(fields.matchThreshold.value, 0, 100, DEFAULT_CONFIG.matchThreshold)
  };
}

function fillForm(config = DEFAULT_CONFIG) {
  fields.selector.value = config.selector ?? DEFAULT_CONFIG.selector;
  fields.detailContainerSelector.value = config.detailContainerSelector ?? DEFAULT_CONFIG.detailContainerSelector;
  fields.count.value = config.count ?? DEFAULT_CONFIG.count;
  fields.startIndex.value = (config.startIndex ?? DEFAULT_CONFIG.startIndex) + 1;
  fields.beforeClickDelay.value = config.beforeClickDelay ?? DEFAULT_CONFIG.beforeClickDelay;
  fields.afterLoadDelay.value = config.afterLoadDelay ?? DEFAULT_CONFIG.afterLoadDelay;
  fields.saveToLocal.checked = config.saveToLocal ?? DEFAULT_CONFIG.saveToLocal;
  fields.autoCommunicate.checked = Boolean(config.autoCommunicate ?? DEFAULT_CONFIG.autoCommunicate);
  fields.matchThreshold.value = config.matchThreshold ?? DEFAULT_CONFIG.matchThreshold;
  setNextMode(config.pinCurrentPage ? "manual" : "auto");
}

async function readConfigForProfile(profileKey) {
  const data = await chrome.storage.local.get([LEGACY_LAST_CONFIG_KEY, SITE_CONFIGS_KEY]);
  if (profileKey === "generic") {
    return mergeConfig(data[LEGACY_LAST_CONFIG_KEY]);
  }

  const savedSiteConfigs = isPlainObject(data[SITE_CONFIGS_KEY]) ? data[SITE_CONFIGS_KEY] : {};
  return mergeConfig(SITE_PROFILES[profileKey]?.preset, savedSiteConfigs[profileKey]);
}

async function saveConfigForProfile(profileKey, config) {
  const configToStore = pickConfigFields(config);
  if (profileKey === "generic") {
    await chrome.storage.local.set({ [LEGACY_LAST_CONFIG_KEY]: configToStore });
    return;
  }

  const data = await chrome.storage.local.get(SITE_CONFIGS_KEY);
  const savedSiteConfigs = isPlainObject(data[SITE_CONFIGS_KEY]) ? data[SITE_CONFIGS_KEY] : {};
  await chrome.storage.local.set({
    [SITE_CONFIGS_KEY]: {
      ...savedSiteConfigs,
      [profileKey]: configToStore
    }
  });
}

function pickConfigFields(config) {
  return {
    siteKey: config.siteKey ?? DEFAULT_CONFIG.siteKey,
    selector: config.selector ?? DEFAULT_CONFIG.selector,
    detailContainerSelector: config.detailContainerSelector ?? DEFAULT_CONFIG.detailContainerSelector,
    detailOpenMode: config.detailOpenMode ?? DEFAULT_CONFIG.detailOpenMode,
    count: config.count ?? DEFAULT_CONFIG.count,
    startIndex: config.startIndex ?? DEFAULT_CONFIG.startIndex,
    beforeClickDelay: config.beforeClickDelay ?? DEFAULT_CONFIG.beforeClickDelay,
    afterLoadDelay: config.afterLoadDelay ?? DEFAULT_CONFIG.afterLoadDelay,
    pinCurrentPage: Boolean(config.pinCurrentPage ?? DEFAULT_CONFIG.pinCurrentPage),
    saveToLocal: config.saveToLocal ?? DEFAULT_CONFIG.saveToLocal,
    autoCommunicate: Boolean(config.autoCommunicate ?? DEFAULT_CONFIG.autoCommunicate),
    matchThreshold: config.matchThreshold ?? DEFAULT_CONFIG.matchThreshold
  };
}

async function syncRunningConfig(config) {
  if (!Number.isInteger(targetTabId)) {
    return null;
  }

  try {
    await ensureContentScript(targetTabId);
    await sendMessage(targetTabId, {
      type: "UPDATE_CONFIG",
      tabId: targetTabId,
      config
    });
    return true;
  } catch (error) {
    console.warn("Sync running config failed:", error);
    return false;
  }
}

async function handleResumeFile() {
  const file = resumeFileInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    setMessage(`正在读取：${file.name}`);
    const text = await readResumeFile(file);
    if (!text.trim()) {
      throw new Error("没有从文件中提取到文本。");
    }

    resumeTextInput.value = text;
    await saveResumeText({
      name: file.name,
      type: file.type || inferFileType(file.name),
      size: file.size,
      updatedAt: Date.now()
    });
    updateResumeStatus();
    setMessage(`已导入简历：${file.name}`);
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  } finally {
    resumeFileInput.value = "";
  }
}

async function readResumeFile(file) {
  const extension = getFileExtension(file.name);
  if (extension === "pdf" || file.type === "application/pdf") {
    return extractPdfText(await file.arrayBuffer());
  }

  if (["md", "markdown", "txt"].includes(extension) || /^text\//i.test(file.type || "")) {
    return file.text();
  }

  throw new Error("仅支持 PDF、MD、Markdown、TXT 简历文件。");
}

async function extractPdfText(arrayBuffer) {
  const documentTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
    wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/")
  });
  const pdf = await documentTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .trim();
    if (pageText) {
      pages.push(`## 第 ${pageNumber} 页\n\n${pageText}`);
    }
  }

  await pdf.destroy();
  return pages.join("\n\n").trim();
}

function scheduleResumeSave() {
  window.clearTimeout(resumeSaveTimer);
  resumeSaveTimer = window.setTimeout(() => {
    saveResumeText().catch((error) => setMessage(error?.message ?? String(error), true));
  }, 450);
}

async function saveResumeText(meta = null) {
  const resumeText = resumeTextInput.value.trim();
  const existing = meta ? null : await chrome.storage.local.get(RESUME_META_KEY);
  const existingMeta = isPlainObject(existing?.[RESUME_META_KEY]) ? existing[RESUME_META_KEY] : null;
  const data = {
    [RESUME_TEXT_KEY]: resumeText
  };

  if (meta) {
    data[RESUME_META_KEY] = meta;
  } else {
    data[RESUME_META_KEY] = {
      ...(existingMeta || {}),
      source: existingMeta?.source || "paste",
      size: resumeText.length,
      updatedAt: Date.now()
    };
  }

  await chrome.storage.local.set(data);
  updateResumeStatus(data[RESUME_META_KEY]);
}

async function saveDeepSeekKey() {
  await chrome.storage.local.set({
    [DEEPSEEK_KEY_KEY]: deepseekKeyInput.value.trim()
  });
}

async function loadResumeState() {
  const data = await chrome.storage.local.get([
    RESUME_TEXT_KEY,
    RESUME_META_KEY,
    DEEPSEEK_KEY_KEY
  ]);
  resumeTextInput.value = data[RESUME_TEXT_KEY] || "";
  deepseekKeyInput.value = data[DEEPSEEK_KEY_KEY] || "";
  updateResumeStatus(data[RESUME_META_KEY]);
}

async function clearResume() {
  resumeTextInput.value = "";
  await chrome.storage.local.remove([RESUME_TEXT_KEY, RESUME_META_KEY, LAST_MATCH_RESULT_KEY]);
  updateResumeStatus();
  setMessage("已清空简历和上次评分结果。");
}

function updateResumeStatus(meta = null) {
  const length = resumeTextInput.value.trim().length;
  if (!length) {
    resumeStatusText.textContent = "未导入简历";
    return;
  }

  const name = meta?.name ? ` · ${meta.name}` : "";
  resumeStatusText.textContent = `已导入 ${length.toLocaleString()} 字${name}`;
}

function setActiveProfile(profileKey) {
  profileButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.profile === profileKey);
  });
}

function normalizeProfileKey(profileKey) {
  const key = String(profileKey || "").trim();
  return SITE_PROFILES[key] ? key : "";
}

function getNextMode() {
  return nextModeInputs.find((input) => input.checked)?.value || "auto";
}

function setNextMode(mode) {
  nextModeInputs.forEach((input) => {
    input.checked = input.value === mode;
  });
}

function mergeConfig(...configs) {
  return configs.reduce(
    (merged, config) => (isPlainObject(config) ? { ...merged, ...config } : merged),
    { ...DEFAULT_CONFIG }
  );
}

function readInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getFileExtension(filename) {
  return String(filename || "").split(".").pop().toLowerCase();
}

function inferFileType(filename) {
  const extension = getFileExtension(filename);
  if (extension === "pdf") {
    return "application/pdf";
  }
  if (extension === "md" || extension === "markdown") {
    return "text/markdown";
  }
  return "text/plain";
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

function setMessage(text, isError = false) {
  messageText.textContent = text;
  messageText.classList.toggle("error", Boolean(isError));
}
