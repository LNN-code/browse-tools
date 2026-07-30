const DOWNLOAD_DIRS = {
  zhipin: "boss-jobs",
  zhaopin: "zhaopin-jobs"
};

const RECENT_JOB_CONTEXT_KEY = "sda:recentJobContext";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_CONTEXT_CHARS = 18000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  if (message?.type === "SAVE_MARKDOWN") {
    saveMarkdown(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message ?? error)
        });
      });
    return true;
  }

  if (message?.type === "OPEN_DETAIL_TAB") {
    openDetailTab(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message ?? error)
        });
      });
    return true;
  }

  if (message?.type === "DETAIL_TAB_DONE") {
    finishDetailTab(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message ?? error)
        });
      });
    return true;
  }

  if (message?.type === "MATCH_JOB_WITH_RESUME") {
    matchJobWithResume(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message ?? error)
        });
      });
    return true;
  }

  return false;
});

async function saveMarkdown(message) {
  const filename = normalizeMarkdownFilename(message.filename);
  const content = String(message.content || "");
  if (!content.trim()) {
    throw new Error("Markdown 内容为空。");
  }

  const downloadDir = DOWNLOAD_DIRS[message.siteKey] || "job-details";
  const downloadPath = `${downloadDir}/${filename}`;

  if (message.saveToLocal === false) {
    if (isPlainObject(message.jobContext)) {
      await saveRecentJobContext({
        ...message.jobContext,
        markdownFilename: downloadPath,
        updatedAt: Date.now()
      });
    }

    return {
      ok: true,
      downloadId: null,
      filename: downloadPath,
      skipped: true
    };
  }

  const utf8Content = content.startsWith("\uFEFF") ? content : `\uFEFF${content}`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(utf8Content)}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename: downloadPath,
    conflictAction: "uniquify",
    saveAs: false
  });

  if (isPlainObject(message.jobContext)) {
    await saveRecentJobContext({
      ...message.jobContext,
      markdownFilename: downloadPath,
      updatedAt: Date.now()
    });
  }

  return {
    ok: true,
    downloadId,
    filename: downloadPath
  };
}

function normalizeMarkdownFilename(filename) {
  const clean = String(filename || "job-detail")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 160);

  const baseName = clean || "job-detail";
  return baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;
}

async function openDetailTab(message, sender) {
  const listTabId = sender.tab?.id;
  if (!Number.isInteger(listTabId)) {
    throw new Error("无法识别列表标签页。");
  }

  const url = String(message.url || "");
  if (!url) {
    throw new Error("详情链接为空。");
  }

  const listTab = await chrome.tabs.get(listTabId);
  const pinCurrentPage = message.listState?.config?.pinCurrentPage === true;
  const createOptions = {
    url,
    active: !pinCurrentPage,
    openerTabId: listTabId
  };
  if (typeof listTab.index === "number") {
    createOptions.index = listTab.index + 1;
  }

  const detailTab = await chrome.tabs.create(createOptions);

  const detailState = {
    ...(message.detailState || {}),
    running: true,
    tabId: detailTab.id,
    listTabId,
    mode: "detail",
    closeWhenDone: true,
    detailUrl: url,
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    [stateKey(detailTab.id)]: detailState,
    [stateKey(listTabId)]: {
      ...(message.listState || {}),
      running: true,
      tabId: listTabId,
      mode: "waitingDetailTab",
      detailTabId: detailTab.id,
      updatedAt: Date.now()
    }
  });

  wakeContentTab(detailTab.id).catch(() => {});

  return {
    ok: true,
    detailTabId: detailTab.id
  };
}

async function finishDetailTab(message, sender) {
  const detailTabId = sender.tab?.id ?? message.detailTabId;
  const listTabId = message.listTabId;
  if (!Number.isInteger(listTabId)) {
    throw new Error("无法识别列表标签页。");
  }

  const listKey = stateKey(listTabId);
  const data = await chrome.storage.local.get(listKey);
  const listState = data[listKey];
  const jobContext = isPlainObject(message.jobContext) ? message.jobContext : null;
  if (listState?.running) {
    const nextMode = listState.config?.pinCurrentPage === true ? "waitingNextItem" : "list";
    await chrome.storage.local.set({
      [listKey]: {
        ...listState,
        mode: nextMode,
        completed: message.completed ?? listState.completed ?? 0,
        detailTabId: null,
        lastDetailUrl: message.detailUrl || "",
        lastDetailTitle: message.lastDetailTitle || jobContext?.pageTitle || "",
        lastMarkdownFilename: message.markdownFilename || "",
        lastDetailContent: jobContext?.content || listState.lastDetailContent || "",
        lastDetailBodyText: jobContext?.bodyText || listState.lastDetailBodyText || "",
        lastJobTitle: jobContext?.jobTitle || listState.lastJobTitle || "",
        lastCompanyName: jobContext?.companyName || listState.lastCompanyName || "",
        lastSalaryText: jobContext?.salaryText || listState.lastSalaryText || "",
        updatedAt: Date.now()
      }
    });
  }

  if (jobContext) {
    await saveRecentJobContext({
      ...jobContext,
      sourceUrl: message.detailUrl || jobContext.sourceUrl || "",
      markdownFilename: message.markdownFilename || jobContext.markdownFilename || "",
      updatedAt: Date.now()
    });
  }

  if (Number.isInteger(detailTabId)) {
    await chrome.storage.local.remove(stateKey(detailTabId));
  }

  try {
    await chrome.tabs.update(listTabId, { active: true });
    const listTab = await chrome.tabs.get(listTabId);
    if (Number.isInteger(listTab.windowId)) {
      await chrome.windows.update(listTab.windowId, { focused: true });
    }
  } catch {}

  try {
    await chrome.tabs.sendMessage(listTabId, { type: "RESUME_RUN" });
  } catch {}

  if (Number.isInteger(detailTabId)) {
    try {
      await chrome.tabs.remove(detailTabId);
    } catch {}
  }

  return { ok: true };
}

async function saveRecentJobContext(context) {
  await chrome.storage.local.set({
    [RECENT_JOB_CONTEXT_KEY]: sanitizeJobContext(context)
  });
}

function sanitizeJobContext(context) {
  return {
    kind: String(context.kind || "detail"),
    sourceUrl: String(context.sourceUrl || ""),
    pageTitle: String(context.pageTitle || ""),
    extractedAt: String(context.extractedAt || new Date().toISOString()),
    jobTitle: String(context.jobTitle || "未知岗位"),
    companyName: String(context.companyName || "未知企业"),
    salaryText: String(context.salaryText || "未知薪资"),
    bodyText: String(context.bodyText || "").slice(0, MAX_CONTEXT_CHARS),
    content: String(context.content || "").slice(0, MAX_CONTEXT_CHARS),
    filename: String(context.filename || context.markdownFilename || ""),
    markdownFilename: String(context.markdownFilename || context.filename || ""),
    updatedAt: Number(context.updatedAt || Date.now())
  };
}

async function matchJobWithResume(message) {
  const apiKey = String(message.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("请先填写 DeepSeek API Key。");
  }

  const resumeText = normalizeLongText(message.resumeText);
  if (resumeText.length < 80) {
    throw new Error("简历内容太短，请先上传 PDF/MD 或粘贴完整简历。");
  }

  const jobContext = await resolveJobContext(message.jobContext);
  if (!jobContext) {
    throw new Error("未找到当前岗位信息。请先打开岗位详情页，或先运行一次浏览提取。");
  }

  const jobText = normalizeLongText(jobContext?.content || jobContext?.bodyText || "");
  if (jobText.length < 60) {
    throw new Error("岗位信息太短。请先打开岗位详情页，或运行一次浏览提取。");
  }

  const result = await callDeepSeekMatchAgent({
    apiKey,
    resumeText: trimContext(resumeText),
    jobContext: {
      ...jobContext,
      content: trimContext(jobText)
    }
  });

  return {
    ok: true,
    result,
    jobContext: sanitizeJobContext(jobContext)
  };
}

async function resolveJobContext(jobContext) {
  if (isPlainObject(jobContext) && String(jobContext.content || jobContext.bodyText || "").trim()) {
    return sanitizeJobContext(jobContext);
  }

  const data = await chrome.storage.local.get(RECENT_JOB_CONTEXT_KEY);
  if (isPlainObject(data[RECENT_JOB_CONTEXT_KEY])) {
    return sanitizeJobContext(data[RECENT_JOB_CONTEXT_KEY]);
  }

  return null;
}

async function callDeepSeekMatchAgent({ apiKey, resumeText, jobContext }) {
  const body = {
    model: DEEPSEEK_MODEL,
    temperature: 0.2,
    max_tokens: 2400,
    thinking: {
      type: "disabled"
    },
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你是一个招聘岗位匹配评分 Agent。",
          "你会基于岗位信息和候选人简历进行匹配度评估。",
          "只返回 JSON，不要 Markdown，不要额外解释。",
          "评分需要严格、可执行，并重点关注岗位职责、硬技能、项目经验、行业/业务背景、年限层级和风险点。",
          "JSON 字段必须包含：score, level, summary, strengths, gaps, suggestions, evidence。",
          "score 是 0-100 的整数；level 是 强匹配、较匹配、一般、弱匹配 四选一。",
          "strengths、gaps、suggestions、evidence 都是字符串数组，每个数组 3-6 项。",
          "输出示例：{\"score\":82,\"level\":\"较匹配\",\"summary\":\"整体匹配度较高，具备相关经验。\",\"strengths\":[\"...\"],\"gaps\":[\"...\"],\"suggestions\":[\"...\"],\"evidence\":[\"...\"]}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "请根据以下岗位信息和简历做匹配评分。",
          "",
          "【岗位元信息】",
          `岗位：${jobContext.jobTitle || "未知岗位"}`,
          `企业：${jobContext.companyName || "未知企业"}`,
          `薪资：${jobContext.salaryText || "未知薪资"}`,
          `来源：${jobContext.sourceUrl || "未知来源"}`,
          "",
          "【岗位信息】",
          jobContext.content,
          "",
          "【候选人简历】",
          resumeText
        ].join("\n")
      }
    ]
  };

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `DeepSeek 请求失败：HTTP ${response.status}`;
    throw new Error(message);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek 未返回评分内容。");
  }

  return normalizeMatchResult(parseJsonObject(content));
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {}

  const match = String(content || "").match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("DeepSeek 返回内容不是有效 JSON。");
  }

  return JSON.parse(match[0]);
}

function normalizeMatchResult(result) {
  const score = Number.parseInt(result?.score, 10);
  const normalizedScore = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;

  return {
    score: normalizedScore,
    level: String(result?.level || levelFromScore(normalizedScore)),
    summary: String(result?.summary || ""),
    strengths: normalizeStringArray(result?.strengths),
    gaps: normalizeStringArray(result?.gaps),
    suggestions: normalizeStringArray(result?.suggestions),
    evidence: normalizeStringArray(result?.evidence)
  };
}

function levelFromScore(score) {
  if (score >= 85) {
    return "强匹配";
  }
  if (score >= 70) {
    return "较匹配";
  }
  if (score >= 55) {
    return "一般";
  }
  return "弱匹配";
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8);
  }

  const text = String(value || "").trim();
  return text ? [text] : [];
}

function normalizeLongText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function trimContext(text) {
  const normalized = normalizeLongText(text);
  if (normalized.length <= MAX_CONTEXT_CHARS) {
    return normalized;
  }

  const headLength = Math.floor(MAX_CONTEXT_CHARS * 0.72);
  const tailLength = MAX_CONTEXT_CHARS - headLength;
  return [
    normalized.slice(0, headLength),
    "",
    "……中间内容已截断……",
    "",
    normalized.slice(-tailLength)
  ].join("\n");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateKey(tabId) {
  return `sda:state:${tabId}`;
}

async function wakeContentTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "RESUME_RUN" });
    return;
  } catch {}

  await waitForTabReady(tabId, 15000);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch {}

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"]
    });
  } catch {}

  try {
    await chrome.tabs.sendMessage(tabId, { type: "RESUME_RUN" });
  } catch {}
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        finish();
      }
    }).catch(finish);
  });
}
