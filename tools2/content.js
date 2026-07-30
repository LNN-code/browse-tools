(() => {
  if (window.__sdaBrowserLoaded) {
    return;
  }
  window.__sdaBrowserLoaded = true;

  const OVERLAY_ID = "sda-browser-overlay";
  const HIGHLIGHT_CLASS = "sda-target-highlight";
  const STATE_PREFIX = "sda:state:";
  const RESUME_TEXT_KEY = "sda:resumeText";
  const DEEPSEEK_KEY_KEY = "sda:deepseekApiKey";
  const LAST_MATCH_RESULT_KEY = "sda:lastMatchResult";

  const DEFAULT_CONFIG = {
    siteKey: "",
    selector: "a[href]",
    detailContainerSelector: "",
    detailOpenMode: "sameTab",
    count: 10,
    startIndex: 0,
    beforeClickDelay: 800,
    afterLoadDelay: 1200,
    afterBottomDelay: 1200,
    navigationWait: 2500,
    listWaitMs: 20000,
    pinCurrentPage: false,
    saveToLocal: true,
    autoCommunicate: false,
    matchThreshold: 80
  };

  const SITE_PRESETS = {
    zhipin: {
      siteKey: "zhipin",
      selector: ".job-card-wrapper, .job-card-box",
      detailContainerSelector: ".job-detail-container, .job-detail-box, .job-detail",
      detailOpenMode: "samePage"
    },
    zhaopin: {
      siteKey: "zhaopin",
      selector: ".joblist-box__item, .joblist-box__iteminfo, .job-item, a[href*='jobs.zhaopin.com'], a[href*='/jobdetail/']",
      detailContainerSelector: ".job-detail, .job-detail-container, .job-detail__container, .position-detail, .job-intro, .detail-container, .summary-plane, .describtion, .description",
      detailOpenMode: "newTab"
    }
  };

  const SALARY_PATTERN = /(?:\d+(?:\.\d+)?\s*[kK万千]?[\-－—~到至]\s*\d+(?:\.\d+)?\s*[kK万千]?|薪资面议|面议)(?:\s*[·x×]\s*\d+薪)?/;

  let activeTimer = null;
  let urlWatcher = null;
  let cachedTabId = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === "PING") {
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "START_RUN") {
        const config = normalizeConfig(message.config);
        const state = {
          running: true,
          tabId: message.tabId,
          mode: "list",
          config,
          completed: 0,
          currentIndex: config.startIndex,
          listUrl: location.href,
          waitingPageUrl: "",
          alertedPageUrl: "",
          updatedAt: Date.now()
        };

        cachedTabId = message.tabId;
        await setState(state);
        renderOverlay(state, "已启动，准备扫描当前页面列表。");
        scheduleRun(250);
        sendResponse({ ok: true, state });
        return;
      }

      if (message?.type === "STOP_RUN") {
        cachedTabId = message.tabId ?? cachedTabId;
        await stopRun("已停止。");
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "GET_STATUS") {
        cachedTabId = message.tabId ?? cachedTabId;
        const state = await getState();
        sendResponse({ ok: true, state });
        return;
      }

      if (message?.type === "UPDATE_CONFIG") {
        cachedTabId = message.tabId ?? cachedTabId;
        const state = await getState();
        const config = normalizeConfig(message.config);
        if (state?.running) {
          const nextState = {
            ...state,
            config,
            mode: state.mode === "waitingNextItem" && config.pinCurrentPage !== true ? "list" : state.mode,
            updatedAt: Date.now()
          };
          await setState(nextState);
          renderOverlay(nextState, nextState.mode === "list" && state.mode === "waitingNextItem" ? "配置已更新，准备自动进入下一条。" : "配置已更新。");
          if (nextState.mode === "list" && state.mode === "waitingNextItem") {
            scheduleRun(250);
          }
          sendResponse({ ok: true, state: nextState });
          return;
        }

        sendResponse({ ok: true, state: null });
        return;
      }

      if (message?.type === "GET_JOB_CONTEXT") {
        cachedTabId = message.tabId ?? cachedTabId;
        const state = await getState();
        const context = await buildJobContext(state);
        if (!context) {
          sendResponse({ ok: false, error: "未提取到岗位信息。请先打开岗位详情页，或先运行一次浏览流程。" });
          return;
        }

        sendResponse({ ok: true, context });
        return;
      }

      if (message?.type === "RESUME_RUN") {
        const state = await getState();
        if (state?.running) {
          if (state.mode === "waitingNextItem") {
            renderOverlay(state, "当前条已完成，请点击下一条。");
          } else {
            renderOverlay(state, "详情标签页已完成，继续列表下一条。");
            scheduleRun(300);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "NEXT_ITEM") {
        const state = await getState();
        const response = await continueToNextItem(state);
        sendResponse(response);
        return;
      }

      sendResponse({ ok: false, error: "未知消息。" });
    })().catch((error) => {
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

    return true;
  });

  bootstrap();

  async function bootstrap() {
    cachedTabId = await getTabId();
    let state = await getState();
    if (!state?.running) {
      return;
    }
    state = await migrateStateConfig(state);

    if (state.mode === "waitingNextPage") {
      if (state.waitingPageUrl && state.waitingPageUrl !== location.href) {
        await setState({
          ...state,
          mode: "list",
          currentIndex: 0,
          listUrl: location.href,
          waitingPageUrl: "",
          alertedPageUrl: "",
          updatedAt: Date.now()
        });
      } else {
        renderOverlay(state, "当前页已浏览完，请手动跳转到下一页。跳转后会继续执行。");
        startUrlWatcher();
        return;
      }
    }

    if (state.mode === "waitingNextItem") {
      renderOverlay(state, "当前条已完成，请点击下一条。");
      return;
    }

    renderOverlay(state, getModeText(state));
    scheduleRun(600);
  }

  function normalizeConfig(config = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    const sitePreset = getSitePreset();
    let selector = String(merged.selector || DEFAULT_CONFIG.selector).trim();
    let detailContainerSelector = String(merged.detailContainerSelector || "").trim();
    let detailOpenMode = String(merged.detailOpenMode || DEFAULT_CONFIG.detailOpenMode).trim();

    if (sitePreset && isGenericListSelector(selector)) {
      selector = sitePreset.selector;
    }

    if (sitePreset && !detailContainerSelector) {
      detailContainerSelector = sitePreset.detailContainerSelector;
    }

    if (sitePreset && detailOpenMode === DEFAULT_CONFIG.detailOpenMode) {
      detailOpenMode = sitePreset.detailOpenMode;
    }

    return {
      siteKey: merged.siteKey || sitePreset?.siteKey || getSiteKey() || "",
      selector: selector || DEFAULT_CONFIG.selector,
      detailContainerSelector,
      detailOpenMode,
      count: clampInt(merged.count, 1, 999, DEFAULT_CONFIG.count),
      startIndex: clampInt(merged.startIndex, 0, 998, DEFAULT_CONFIG.startIndex),
      beforeClickDelay: clampInt(merged.beforeClickDelay, 0, 10000, DEFAULT_CONFIG.beforeClickDelay),
      afterLoadDelay: clampInt(merged.afterLoadDelay, 0, 15000, DEFAULT_CONFIG.afterLoadDelay),
      afterBottomDelay: clampInt(merged.afterBottomDelay, 0, 15000, DEFAULT_CONFIG.afterBottomDelay),
      navigationWait: DEFAULT_CONFIG.navigationWait,
      listWaitMs: clampInt(merged.listWaitMs, 1000, 60000, DEFAULT_CONFIG.listWaitMs),
      pinCurrentPage: Boolean(merged.pinCurrentPage),
      saveToLocal: merged.saveToLocal !== false,
      autoCommunicate: Boolean(merged.autoCommunicate),
      matchThreshold: clampInt(merged.matchThreshold, 0, 100, DEFAULT_CONFIG.matchThreshold)
    };
  }

  function getSitePreset() {
    const siteKey = getSiteKey();
    return siteKey ? SITE_PRESETS[siteKey] : null;
  }

  function getSiteKey() {
    if (/(^|\.)zhipin\.com$/i.test(location.hostname) || /(^|\.)bosszhipin\.com$/i.test(location.hostname)) {
      return "zhipin";
    }

    if (/(^|\.)zhaopin\.(com|cn)$/i.test(location.hostname)) {
      return "zhaopin";
    }

    return null;
  }

  function isGenericListSelector(selector) {
    const normalized = String(selector || "").trim().toLowerCase().replace(/\s+/g, "");
    return normalized === "" || normalized === "a" || normalized === "a[href]" || normalized === "a[href]:not([target])";
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  async function getTabId() {
    if (Number.isInteger(cachedTabId)) {
      return cachedTabId;
    }

    const response = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" });
    cachedTabId = response?.tabId ?? null;
    return cachedTabId;
  }

  async function storageKey() {
    const tabId = await getTabId();
    if (!Number.isInteger(tabId)) {
      throw new Error("无法识别当前标签页。");
    }
    return `${STATE_PREFIX}${tabId}`;
  }

  async function getState() {
    const key = await storageKey();
    const data = await chrome.storage.local.get(key);
    return data[key] ?? null;
  }

  async function setState(state) {
    const key = await storageKey();
    await chrome.storage.local.set({
      [key]: {
        ...state,
        updatedAt: Date.now()
      }
    });
  }

  async function migrateStateConfig(state) {
    const normalizedConfig = normalizeConfig(state.config);
    if (JSON.stringify(normalizedConfig) === JSON.stringify(state.config)) {
      return state;
    }

    const migrated = {
      ...state,
      config: normalizedConfig,
      updatedAt: Date.now()
    };
    await setState(migrated);
    return migrated;
  }

  async function clearState() {
    const key = await storageKey();
    await chrome.storage.local.remove(key);
  }

  function scheduleRun(delay = 0) {
    window.clearTimeout(activeTimer);
    activeTimer = window.setTimeout(() => {
      runLoop().catch((error) => {
        renderOverlay(null, `执行出错：${error?.message ?? error}`);
      });
    }, delay);
  }

  async function runLoop() {
    await waitForDocumentReady();

    let state = await getState();
    if (!state?.running) {
      removeOverlay();
      return;
    }
    state = await migrateStateConfig(state);

    if (state.completed >= state.config.count) {
      await setState({ ...state, running: false, mode: "done" });
      renderOverlay({ ...state, running: false, mode: "done" }, `已完成 ${state.completed}/${state.config.count} 条浏览。`);
      notifyPage(`已完成 ${state.completed} 条详情浏览。`);
      return;
    }

    if (state.mode === "detail") {
      await handleDetailPage(state);
      return;
    }

    if (state.mode === "returning") {
      renderOverlay(state, "已返回列表，准备继续下一条。");
      await delay(state.config.afterLoadDelay);
      const latest = await getState();
      if (!latest?.running) {
        return;
      }
      await setState({
        ...latest,
        mode: "list",
        listUrl: location.href,
        updatedAt: Date.now()
      });
      scheduleRun(250);
      return;
    }

    if (state.mode === "waitingDetailTab") {
      renderOverlay(state, "详情新标签页正在浏览，完成后会自动回到列表。");
      scheduleRun(2000);
      return;
    }

    if (state.mode === "waitingNextItem") {
      renderOverlay(state, "当前条已完成，请点击下一条。");
      return;
    }

    if (state.mode === "waitingNextPage") {
      if (state.waitingPageUrl && state.waitingPageUrl !== location.href) {
        await setState({
          ...state,
          mode: "list",
          currentIndex: 0,
          listUrl: location.href,
          waitingPageUrl: "",
          alertedPageUrl: "",
          updatedAt: Date.now()
        });
        scheduleRun(500);
        return;
      }

      renderOverlay(state, "当前页已浏览完，请手动跳转到下一页。跳转后会继续执行。");
      startUrlWatcher();
      return;
    }

    await handleListPage(state);
  }

  async function handleListPage(state) {
    state = await migrateStateConfig(state);
    renderOverlay(state, "正在等待左侧列表项加载。");
    await delay(state.config.afterLoadDelay);

    const latest = await getState();
    if (!latest?.running) {
      return;
    }

    const targets = await waitForTargets(latest.config.selector, latest.config.listWaitMs);
    const stateAfterWait = await getState();
    if (!stateAfterWait?.running) {
      return;
    }
    if (!targets.length) {
      renderOverlay(latest, `没有找到左侧列表项：${latest.config.selector}`);
      return;
    }

    if (stateAfterWait.currentIndex >= targets.length) {
      const waitingState = {
        ...stateAfterWait,
        mode: "waitingNextPage",
        waitingPageUrl: location.href,
        alertedPageUrl: location.href,
        updatedAt: Date.now()
      };
      await setState(waitingState);
      renderOverlay(waitingState, "当前页已浏览完，请手动跳转到下一页。跳转后会继续执行。");
      notifyPage("当前页面可识别的列表项已浏览完，请手动跳转到下一页。");
      startUrlWatcher();
      return;
    }

    const target = targets[stateAfterWait.currentIndex];
    const href = getHref(target);
    const itemNumber = stateAfterWait.currentIndex + 1;
    const listMetadata = extractListMetadata(target);
    const nextState = {
      ...stateAfterWait,
      mode: "detail",
      currentIndex: stateAfterWait.currentIndex + 1,
      listUrl: location.href,
      lastTargetText: getElementLabel(target),
      lastTargetHref: href,
      lastJobTitle: listMetadata.jobTitle,
      lastCompanyName: listMetadata.companyName,
      lastSalaryText: listMetadata.salaryText,
      markdownSaved: false,
      autoCommunicationChecked: false,
      autoCommunicateMatched: false,
      autoCommunicateDone: false,
      autoCommunicateScore: null,
      autoCommunicateMessage: "",
      autoCommunicateError: "",
      samePageDetail: false,
      listScrollX: window.scrollX,
      listScrollY: window.scrollY,
      detailStartedAt: Date.now(),
      updatedAt: Date.now()
    };

    renderOverlay(nextState, `准备打开第 ${itemNumber} 条：${nextState.lastTargetText || "未命名详情"}`);
    highlightTarget(target);
    await delay(stateAfterWait.config.beforeClickDelay);

    if (stateAfterWait.config.detailOpenMode === "newTab") {
      await openDetailInNewTab(nextState, href);
      return;
    }

    const beforeUrl = location.href;
    await setState(nextState);
    clickLikeUser(target);
    await delay(latest.config.navigationWait);

    const afterClickState = await getState();
    if (!afterClickState?.running || afterClickState.mode !== "detail") {
      return;
    }

    const samePageDetail = location.href === beforeUrl || collectTargets(afterClickState.config.selector).length > 0;
    await setState({
      ...afterClickState,
      samePageDetail,
      detailUrl: location.href,
      updatedAt: Date.now()
    });

    if (location.href !== beforeUrl) {
      scheduleRun(300);
      return;
    }

    renderOverlay(afterClickState, "已点击列表项，准备浏览右侧详情。");
    scheduleRun(300);
  }

  async function openDetailInNewTab(nextState, href) {
    if (!href) {
      await setState({
        ...nextState,
        mode: "list",
        currentIndex: Math.max(0, nextState.currentIndex),
        updatedAt: Date.now()
      });
      renderOverlay(nextState, "未找到详情链接，已跳过该条。");
      scheduleRun(500);
      return;
    }

    const listState = {
      ...nextState,
      mode: "waitingDetailTab",
      detailUrl: href,
      updatedAt: Date.now()
    };
    const detailState = {
      ...nextState,
      tabId: null,
      mode: "detail",
      detailUrl: href,
      listTabId: await getTabId(),
      closeWhenDone: true,
      updatedAt: Date.now()
    };

    await setState(listState);
    renderOverlay(listState, "已打开详情新标签页，等待提取岗位信息。");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "OPEN_DETAIL_TAB",
        url: href,
        listState,
        detailState
      });

      if (response?.ok) {
        await setState({
          ...listState,
          detailTabId: response.detailTabId,
          updatedAt: Date.now()
        });
        return;
      }

      throw new Error(response?.error || "未知错误");
    } catch (error) {
      await setState({
        ...nextState,
        mode: "list",
        updatedAt: Date.now()
      });
      renderOverlay(nextState, `打开详情新标签页失败：${error?.message ?? error}`);
      scheduleRun(800);
    }
  }

  async function handleDetailPage(state) {
    renderOverlay(state, "详情页已打开，准备提取岗位信息。");
    await delay(state.config.afterLoadDelay);

    const latest = await getState();
    if (!latest?.running || latest.mode !== "detail") {
      return;
    }

    let stateAfterSave = await saveDetailMarkdownOnce(latest);
    if (!stateAfterSave?.running || stateAfterSave.mode !== "detail") {
      return;
    }

    if (stateAfterSave.markdownSaved) {
      stateAfterSave = await autoCommunicateIfMatched(stateAfterSave);
      if (!stateAfterSave?.running || stateAfterSave.mode !== "detail") {
        return;
      }
    }

    if (!stateAfterSave.markdownSaved) {
      renderOverlay(stateAfterSave, `详情未提取，已暂停：${stateAfterSave.markdownError || "未提取到详情正文"}`);
      return;
    }

    renderOverlay(stateAfterSave, stateAfterSave.markdownSkipped ? "岗位信息已提取，准备处理下一条。" : "岗位信息已保存，准备处理下一条。");

    stateAfterSave = await autoCommunicateIfMatched(stateAfterSave);
    if (!stateAfterSave?.running || stateAfterSave.mode !== "detail") {
      return;
    }

    const completed = stateAfterSave.completed + 1;
    const returningState = {
      ...stateAfterSave,
      completed,
      mode: "returning",
      updatedAt: Date.now()
    };
    await setState(returningState);

    if (stateAfterSave.closeWhenDone && Number.isInteger(stateAfterSave.listTabId)) {
      await finishNewTabDetail(returningState);
      return;
    }

    const listStillVisible = collectTargets(stateAfterSave.config.selector).length > 0;
    const shouldReturn = !stateAfterSave.samePageDetail && !listStillVisible && location.href !== stateAfterSave.listUrl;

    if (!shouldReturn) {
      restoreListViewport(stateAfterSave);
      const nextMode = shouldPauseForNextItem(stateAfterSave) ? "waitingNextItem" : "list";
      const nextState = {
        ...returningState,
        mode: nextMode,
        listUrl: location.href,
        samePageDetail: false,
        updatedAt: Date.now()
      };
      await setState(nextState);
      renderOverlay(nextState, nextMode === "waitingNextItem" ? "当前条已完成，请点击下一条。" : "岗位信息已提取，准备点击下一条。");
      if (nextMode === "list") {
        scheduleRun(500);
      }
      return;
    }

    renderOverlay(returningState, "岗位信息已提取，准备返回列表。");
    await delay(stateAfterSave.config.afterBottomDelay);

    const beforeBackUrl = location.href;
    history.back();
    await delay(1800);

    const stateAfterBack = await getState();
    if (!stateAfterBack?.running || stateAfterBack.mode !== "returning") {
      return;
    }

    if (location.href === beforeBackUrl && stateAfterBack.listUrl && stateAfterBack.listUrl !== beforeBackUrl) {
      location.assign(stateAfterBack.listUrl);
      return;
    }

    const nextMode = shouldPauseForNextItem(stateAfterBack) ? "waitingNextItem" : "list";
    const nextState = {
      ...stateAfterBack,
      mode: nextMode,
      listUrl: location.href,
      updatedAt: Date.now()
    };
    await setState(nextState);
    renderOverlay(nextState, nextMode === "waitingNextItem" ? "当前条已完成，请点击下一条。" : "已返回列表页，准备点击下一条。");
    if (nextMode === "list") {
      scheduleRun(500);
    }
  }

  async function finishNewTabDetail(state) {
    renderOverlay(state, state.config?.saveToLocal === false ? "岗位信息已提取，准备关闭当前标签页。" : "岗位信息已保存，准备关闭当前标签页。");
    const response = await chrome.runtime.sendMessage({
      type: "DETAIL_TAB_DONE",
      listTabId: state.listTabId,
      completed: state.completed,
      detailUrl: location.href,
      markdownFilename: state.markdownFilename || "",
      lastDetailTitle: state.lastDetailTitle || document.title,
      jobContext: state.lastDetailContent ? buildStoredJobContext(state) : null
    });

    if (!response?.ok) {
      renderOverlay(state, `关闭详情标签页失败：${response?.error || "未知错误"}`);
    }
  }

  function collectTargets(selector) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }

    const seen = new Set();
    return nodes
      .filter((node) => !nodes.some((other) => other !== node && other.contains(node)))
      .filter((node) => {
        if (seen.has(node)) {
          return false;
        }
        seen.add(node);
        return isVisible(node);
      });
  }

  function waitForTargets(selector, timeoutMs) {
    const immediate = collectTargets(selector);
    if (immediate.length) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      const finish = (targets) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(pollTimer);
        observer?.disconnect();
        resolve(targets);
      };

      const check = () => {
        const targets = collectTargets(selector);
        if (targets.length) {
          finish(targets);
        }
      };

      const timer = window.setTimeout(() => finish([]), timeoutMs);
      const pollTimer = window.setInterval(check, 500);

      observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    });
  }

  function isVisible(node) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getHref(node) {
    const anchor = node.matches?.("a[href]") ? node : node.querySelector?.("a[href]") ?? node.closest?.("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href || isJavaScriptHref(href)) {
      return "";
    }

    try {
      return new URL(href, location.href).href;
    } catch {
      return "";
    }
  }

  function isJavaScriptHref(href) {
    return String(href).trim().toLowerCase().startsWith("javascript:");
  }

  function getElementLabel(node) {
    const text = (node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "").trim();
    return text.replace(/\s+/g, " ").slice(0, 80);
  }

  function extractListMetadata(node) {
    const lines = getTextLines(node);
    const salaryText = findSalaryText(lines.join(" ")) || "";
    const jobTitle = cleanTitle(
      firstTextBySelectors(node, [
        ".job-name",
        ".job-title",
        ".jobinfo__name",
        ".joblist-box__iteminfo .jobinfo__name",
        ".job-card-left .name",
        ".job-card-body .name",
        "h3",
        "h4"
      ]) || deriveJobTitleFromLines(lines, salaryText)
    );
    const companyName = cleanName(
      firstTextBySelectors(node, [
        ".company-name",
        ".companyinfo__name",
        ".company-info .name",
        ".company-text",
        ".job-card-company",
        ".job-card-footer .name"
      ]) || deriveCompanyFromLines(lines, jobTitle, salaryText)
    );

    return {
      jobTitle,
      companyName,
      salaryText
    };
  }

  async function saveDetailMarkdownOnce(state, options = {}) {
    if (state.markdownSaved && !options.force) {
      return state;
    }

    renderOverlay(state, state.config?.saveToLocal === false ? "正在提取详情内容。" : "正在提取详情并保存 Markdown。");
    const snapshot = await waitForDetailSnapshot(state, 8000);
    const latest = await getState();
    if (!latest?.running || latest.mode !== "detail") {
      return latest;
    }

    if (!snapshot?.content?.trim()) {
      renderOverlay(latest, "未提取到详情正文，已停止当前条。");
      await setState({
        ...latest,
        markdownSaved: false,
        markdownError: "未提取到详情正文",
        updatedAt: Date.now()
      });
      return getState();
    }

    try {
      if (latest.config?.saveToLocal === false) {
        const response = await chrome.runtime.sendMessage({
          type: "SAVE_MARKDOWN",
          siteKey: latest.config.siteKey || getSiteKey(),
          filename: snapshot.filename,
          content: snapshot.content,
          saveToLocal: false,
          jobContext: {
            kind: "extracted-detail",
            sourceUrl: location.href,
            pageTitle: document.title,
            extractedAt: new Date().toISOString(),
            jobTitle: snapshot.jobTitle,
            companyName: snapshot.companyName,
            salaryText: snapshot.salaryText,
            bodyText: snapshot.bodyText,
            content: snapshot.content,
            filename: snapshot.filename
          }
        });

        if (!response?.ok) {
          throw new Error(response?.error || "保存失败。");
        }

        const savedState = {
          ...latest,
          markdownSaved: true,
          markdownSkipped: true,
          markdownFilename: response.filename || snapshot.filename,
          lastDetailContent: snapshot.content,
          lastDetailBodyText: snapshot.bodyText,
          lastDetailUrl: location.href,
          lastDetailTitle: document.title,
          lastJobTitle: snapshot.jobTitle || latest.lastJobTitle || "",
          lastCompanyName: snapshot.companyName || latest.lastCompanyName || "",
          lastSalaryText: snapshot.salaryText || latest.lastSalaryText || "",
          markdownError: "",
          updatedAt: Date.now()
        };
        await setState(savedState);
        return savedState;
      }

      const response = await chrome.runtime.sendMessage({
        type: "SAVE_MARKDOWN",
        siteKey: latest.config.siteKey || getSiteKey(),
        filename: snapshot.filename,
        content: snapshot.content,
        jobContext: {
          kind: "saved-detail",
          sourceUrl: location.href,
          pageTitle: document.title,
          extractedAt: new Date().toISOString(),
          jobTitle: snapshot.jobTitle,
          companyName: snapshot.companyName,
          salaryText: snapshot.salaryText,
          bodyText: snapshot.bodyText,
          content: snapshot.content,
          filename: snapshot.filename
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "保存失败。");
      }

      const savedState = {
        ...latest,
        markdownSaved: true,
        markdownSkipped: false,
        markdownFilename: response.filename,
        lastDetailContent: snapshot.content,
        lastDetailBodyText: snapshot.bodyText,
        lastDetailUrl: location.href,
        lastDetailTitle: document.title,
        lastJobTitle: snapshot.jobTitle || latest.lastJobTitle || "",
        lastCompanyName: snapshot.companyName || latest.lastCompanyName || "",
        lastSalaryText: snapshot.salaryText || latest.lastSalaryText || "",
        markdownError: "",
        updatedAt: Date.now()
      };
      await setState(savedState);
      return savedState;
    } catch (error) {
      const message = String(error?.message ?? error);
      const failedState = {
        ...latest,
        markdownSaved: false,
        markdownError: message,
        updatedAt: Date.now()
      };
      await setState(failedState);
      renderOverlay(failedState, `Markdown 保存失败：${message}`);
      await delay(1000);
      return failedState;
    }
  }

  async function autoCommunicateIfMatched(state) {
    if (!state?.config?.autoCommunicate || state.autoCommunicationChecked || !state.markdownSaved) {
      return state;
    }

    const threshold = clampInt(state.config.matchThreshold, 0, 100, DEFAULT_CONFIG.matchThreshold);
    const checkedBase = {
      ...state,
      autoCommunicationChecked: true,
      autoCommunicateMatched: false,
      autoCommunicateDone: false,
      autoCommunicateScore: null,
      autoCommunicateThreshold: threshold,
      autoCommunicateMessage: "",
      autoCommunicateError: "",
      updatedAt: Date.now()
    };

    try {
      const data = await chrome.storage.local.get([DEEPSEEK_KEY_KEY, RESUME_TEXT_KEY]);
      const apiKey = String(data[DEEPSEEK_KEY_KEY] || "").trim();
      const resumeText = normalizeStoredText(data[RESUME_TEXT_KEY]);
      if (!apiKey) {
        return persistAutoCommunicationSkip(checkedBase, "缺少 DeepSeek API Key。");
      }
      if (resumeText.length < 80) {
        return persistAutoCommunicationSkip(checkedBase, "简历内容太短或未导入。");
      }

      const jobContext = state.lastDetailContent ? buildStoredJobContext(state) : await buildJobContext(state);
      if (!jobContext?.content && !jobContext?.bodyText) {
        return persistAutoCommunicationSkip(checkedBase, "未找到可评分的岗位信息。");
      }

      renderOverlay(state, `正在自动评分，达标线 ${threshold} 分。`);
      const response = await chrome.runtime.sendMessage({
        type: "MATCH_JOB_WITH_RESUME",
        apiKey,
        resumeText,
        jobContext
      });

      if (!response?.ok) {
        throw new Error(response?.error || "自动评分失败。");
      }

      const latestAfterMatch = await getState();
      if (!latestAfterMatch?.running || latestAfterMatch.mode !== "detail") {
        return latestAfterMatch;
      }

      const score = clampInt(response.result?.score, 0, 100, 0);
      const matched = score >= threshold;
      await chrome.storage.local.set({
        [LAST_MATCH_RESULT_KEY]: {
          result: response.result,
          jobContext: response.jobContext || jobContext,
          updatedAt: Date.now()
        }
      });

      let scoredState = {
        ...latestAfterMatch,
        autoCommunicationChecked: true,
        autoCommunicateMatched: matched,
        autoCommunicateDone: false,
        autoCommunicateScore: score,
        autoCommunicateThreshold: threshold,
        autoCommunicateMessage: response.result?.summary || "",
        autoCommunicateError: "",
        lastMatchResult: response.result,
        updatedAt: Date.now()
      };
      await setState(scoredState);

      if (!matched) {
        renderOverlay(scoredState, `匹配分 ${score}，低于 ${threshold}，跳过沟通。`);
        await delay(700);
        return scoredState;
      }

      renderOverlay(scoredState, `匹配分 ${score}，已达到 ${threshold}，准备点击立即沟通。`);
      const clickResult = await clickImmediateCommunicateAndStay();
      const latest = await getState();
      if (!latest?.running || latest.mode !== "detail") {
        return latest;
      }

      scoredState = {
        ...latest,
        autoCommunicationChecked: true,
        autoCommunicateMatched: true,
        autoCommunicateDone: clickResult.clicked && !clickResult.error,
        autoCommunicateScore: score,
        autoCommunicateThreshold: threshold,
        autoCommunicateMessage: clickResult.message,
        autoCommunicateError: clickResult.error || "",
        lastMatchResult: response.result,
        updatedAt: Date.now()
      };
      await setState(scoredState);
      renderOverlay(scoredState, clickResult.message || (clickResult.error ? `自动沟通失败：${clickResult.error}` : "自动沟通已处理。"));
      await delay(800);
      return scoredState;
    } catch (error) {
      const message = String(error?.message ?? error);
      const latest = await getState().catch(() => null);
      if (!latest?.running || latest.mode !== "detail") {
        return latest || state;
      }

      const failedState = {
        ...latest,
        autoCommunicationChecked: true,
        autoCommunicateMatched: false,
        autoCommunicateDone: false,
        autoCommunicateScore: null,
        autoCommunicateThreshold: threshold,
        autoCommunicateMessage: "",
        autoCommunicateError: message,
        updatedAt: Date.now()
      };
      await setState(failedState);
      renderOverlay(failedState, `自动沟通已跳过：${message}`);
      await delay(1000);
      return failedState;
    }
  }

  async function persistAutoCommunicationSkip(state, reason) {
    const latest = await getState().catch(() => null);
    if (!latest?.running || latest.mode !== "detail") {
      return latest || state;
    }

    const skippedState = {
      ...latest,
      autoCommunicationChecked: true,
      autoCommunicateMatched: false,
      autoCommunicateDone: false,
      autoCommunicateScore: null,
      autoCommunicateThreshold: state.autoCommunicateThreshold,
      autoCommunicateMessage: "",
      autoCommunicateError: reason,
      updatedAt: Date.now()
    };
    await setState(skippedState);
    renderOverlay(skippedState, `自动沟通已跳过：${reason}`);
    await delay(800);
    return skippedState;
  }

  async function clickImmediateCommunicateAndStay() {
    const communicateButton = findClickableByTexts(["立即沟通"]);
    if (!communicateButton) {
      return {
        clicked: false,
        stayed: false,
        error: "未找到“立即沟通”按钮。",
        message: "达标，但未找到“立即沟通”按钮。"
      };
    }

    clickLikeUser(communicateButton);
    await delay(900);

    const stayButton = await waitForClickableByTexts(["留在此页", "留着此页", "留在本页", "留在当前页"], 8000);
    if (stayButton) {
      clickLikeUser(stayButton);
      await delay(700);
      return {
        clicked: true,
        stayed: true,
        message: "已点击立即沟通，并选择留在此页。"
      };
    }

    return {
      clicked: true,
      stayed: false,
      message: "已点击立即沟通，未检测到“留在此页”弹窗。"
    };
  }

  async function waitForClickableByTexts(texts, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const node = findClickableByTexts(texts);
      if (node) {
        return node;
      }
      await delay(250);
    }

    return null;
  }

  function findClickableByTexts(texts) {
    const normalizedTexts = texts.map(normalizeActionText).filter(Boolean);
    if (!normalizedTexts.length) {
      return null;
    }

    const clickableSelector = [
      "button",
      "a",
      "[role='button']",
      "input[type='button']",
      "input[type='submit']",
      ".btn",
      ".boss-btn",
      ".op-btn",
      ".op-btn-chat",
      ".btn-startchat",
      ".start-chat-btn",
      ".job-detail-op a",
      ".job-detail-op button"
    ].join(",");
    const candidates = uniqueElements(Array.from(document.querySelectorAll(clickableSelector)));
    const best = rankActionCandidates(candidates, normalizedTexts)[0]?.element;
    if (best) {
      return best;
    }

    const textMatches = Array.from(document.querySelectorAll("body *"))
      .filter((element) => !isExtensionElement(element) && isVisible(element))
      .filter((element) => normalizedTexts.includes(normalizeActionText(getActionText(element))))
      .map((element) => element.closest(clickableSelector) || element);

    return rankActionCandidates(uniqueElements(textMatches), normalizedTexts)[0]?.element ?? null;
  }

  function rankActionCandidates(candidates, normalizedTexts) {
    return candidates
      .filter((element) => !isExtensionElement(element) && isVisible(element))
      .map((element) => {
        const text = normalizeActionText(getActionText(element));
        const rect = element.getBoundingClientRect();
        const exact = normalizedTexts.includes(text);
        const contains = normalizedTexts.some((targetText) => text.includes(targetText));
        const containedBy = normalizedTexts.some((targetText) => targetText.includes(text) && text.length >= 2);
        const score = exact ? 100 : contains ? 70 : containedBy ? 50 : -1;
        return {
          element,
          score,
          area: rect.width * rect.height
        };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.area - b.area);
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function getActionText(element) {
    return [
      element?.innerText,
      element?.textContent,
      element?.value,
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title")
    ].filter(Boolean).join(" ");
  }

  function normalizeActionText(text) {
    return String(text || "").replace(/\s+/g, "").trim();
  }

  function normalizeStoredText(text) {
    return String(text || "")
      .replace(/\u0000/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
  }

  function isExtensionElement(element) {
    return Boolean(element?.id === OVERLAY_ID || element?.closest?.(`#${OVERLAY_ID}`));
  }

  async function buildJobContext(state) {
    const activeState = state?.running ? await migrateStateConfig(state) : state;
    if (activeState?.lastDetailContent) {
      return buildStoredJobContext(activeState);
    }

    if (activeState?.running && activeState.mode === "list") {
      return buildListStateContext(activeState);
    }

    const snapshot = buildDetailSnapshot({
      config: normalizeConfig(activeState?.config || {}),
      lastJobTitle: activeState?.lastJobTitle || "",
      lastCompanyName: activeState?.lastCompanyName || "",
      lastSalaryText: activeState?.lastSalaryText || "",
      listUrl: activeState?.listUrl || location.href,
      detailUrl: activeState?.detailUrl || location.href
    });

    if (!snapshot?.content?.trim()) {
      return null;
    }

    return {
      kind: "detail-page",
      sourceUrl: location.href,
      pageTitle: activeState?.lastDetailTitle || document.title,
      extractedAt: new Date().toISOString(),
      ...snapshot
    };
  }

  function buildStoredJobContext(state) {
    const jobTitle = cleanTitle(state.lastJobTitle || "未知岗位", state.lastSalaryText);
    const companyName = cleanName(state.lastCompanyName || "未知企业");
    const salaryText = cleanName(state.lastSalaryText || "未知薪资");

    return {
      kind: "stored-detail",
      sourceUrl: state.lastDetailUrl || state.detailUrl || state.listUrl || location.href,
      pageTitle: state.lastDetailTitle || document.title,
      extractedAt: new Date().toISOString(),
      jobTitle,
      companyName,
      salaryText,
      bodyText: state.lastDetailBodyText || "",
      content: state.lastDetailContent || "",
      filename: state.markdownFilename || buildMarkdownFilename({ jobTitle, companyName, salaryText }),
      lastTargetText: state.lastTargetText || "",
      lastTargetHref: state.lastTargetHref || "",
      summary: [
        `# ${jobTitle}`,
        "",
        `- 企业：${companyName}`,
        `- 薪资：${salaryText}`,
        `- 来源：${state.lastDetailUrl || state.detailUrl || state.listUrl || location.href}`
      ].join("\n")
    };
  }

  function buildListStateContext(state) {
    const jobTitle = cleanTitle(state.lastJobTitle || state.lastTargetText || "未知岗位", state.lastSalaryText);
    const companyName = cleanName(state.lastCompanyName || "未知企业");
    const salaryText = cleanName(state.lastSalaryText || "未知薪资");
    const sourceUrl = state.lastTargetHref || state.detailUrl || state.listUrl || location.href;
    const summary = [
      `# ${jobTitle}`,
      "",
      `- 企业：${companyName}`,
      `- 薪资：${salaryText}`,
      `- 来源：${sourceUrl}`,
      "",
      "## 列表页提取",
      "",
      state.lastTargetText || ""
    ].join("\n");

    return {
      kind: "list-state",
      sourceUrl,
      pageTitle: document.title,
      extractedAt: new Date().toISOString(),
      jobTitle,
      companyName,
      salaryText,
      bodyText: state.lastTargetText || "",
      content: summary,
      filename: buildMarkdownFilename({ jobTitle, companyName, salaryText }),
      lastTargetText: state.lastTargetText || "",
      lastTargetHref: state.lastTargetHref || "",
      lastDetailTitle: state.lastDetailTitle || ""
    };
  }

  async function waitForDetailSnapshot(state, timeoutMs) {
    const startedAt = Date.now();
    let bestSnapshot = null;

    while (Date.now() - startedAt < timeoutMs) {
      const latest = await getState();
      if (!latest?.running || latest.mode !== "detail") {
        return null;
      }

      const snapshot = buildDetailSnapshot(latest);
      if (snapshot?.bodyText?.length > (bestSnapshot?.bodyText?.length ?? 0)) {
        bestSnapshot = snapshot;
      }

      if (snapshot?.bodyText?.length > 80 && snapshot.jobTitle && snapshot.salaryText) {
        return snapshot;
      }

      await delay(350);
    }

    return bestSnapshot;
  }

  function buildDetailSnapshot(state) {
    const root = findDetailRoot(state.config);
    if (!root) {
      return buildFallbackDetailSnapshot(state);
    }

    const lines = getTextLines(root).filter((line) => !isChromeLine(line));
    const metadata = extractDetailMetadata(root, lines, state);
    const bodyText = lines.join("\n\n").trim();
    const filename = buildMarkdownFilename(metadata);
    const content = [
      `# ${metadata.jobTitle}`,
      "",
      `- 企业：${metadata.companyName}`,
      `- 薪资：${metadata.salaryText}`,
      `- 来源：${location.href}`,
      `- 采集时间：${new Date().toLocaleString()}`,
      "",
      "## 职位详情",
      "",
      bodyText
    ].join("\n");

    return {
      ...metadata,
      bodyText,
      filename,
      content
    };
  }

  function buildFallbackDetailSnapshot(state) {
    const lines = getTextLines(document.body)
      .filter((line) => !isChromeLine(line))
      .filter((line) => !isLikelyNavigationLine(line));
    if (!lines.length && !state.lastJobTitle && !state.lastCompanyName) {
      return null;
    }

    const metadata = {
      jobTitle: cleanTitle(state.lastJobTitle || deriveJobTitleFromLines(lines, state.lastSalaryText) || "未知岗位", state.lastSalaryText),
      companyName: cleanName(state.lastCompanyName || deriveCompanyFromLines(lines, state.lastJobTitle, state.lastSalaryText) || "未知企业"),
      salaryText: cleanName(state.lastSalaryText || findSalaryText(lines.join(" ")) || "未知薪资")
    };
    const bodyText = lines.join("\n\n").trim() || "未提取到详情正文。";
    const filename = buildMarkdownFilename(metadata);
    const content = [
      `# ${metadata.jobTitle}`,
      "",
      `- 企业：${metadata.companyName}`,
      `- 薪资：${metadata.salaryText}`,
      `- 来源：${location.href}`,
      `- 采集时间：${new Date().toLocaleString()}`,
      "",
      "## 职位详情",
      "",
      bodyText
    ].join("\n");

    return {
      ...metadata,
      bodyText,
      filename,
      content
    };
  }

  function extractDetailMetadata(root, lines, state) {
    const salaryText = cleanName(
      firstTextBySelectors(root, [
        ".salary",
        ".job-salary",
        ".summary-plane__salary",
        ".job-detail__salary",
        ".jobinfo__salary",
        ".red",
        ".job-detail-header .salary",
        ".job-primary .salary"
      ]) || findSalaryText(lines.join(" ")) || state.lastSalaryText || "未知薪资"
    );
    const jobTitle = cleanTitle(
      firstTextBySelectors(root, [
        ".job-name",
        ".job-title",
        ".summary-plane__title",
        ".job-detail__title",
        ".jobinfo__name",
        ".job-detail-title",
        ".job-detail-header h1",
        ".job-detail-header h2",
        ".job-primary h1",
        ".job-primary h2",
        "h1",
        "h2"
      ]) || state.lastJobTitle || deriveJobTitleFromLines(lines, salaryText) || "未知岗位",
      salaryText
    );
    const companyName = cleanName(
      firstTextBySelectors(root, [
        ".company-name",
        ".companyinfo__name",
        ".company__name",
        ".company-info .name",
        ".company-info a",
        ".company-text",
        ".boss-company-name"
      ]) || state.lastCompanyName || deriveCompanyFromLines(lines, jobTitle, salaryText) || "未知企业"
    );

    return {
      jobTitle,
      companyName,
      salaryText
    };
  }

  function findDetailRoot(config) {
    const configured = findConfiguredDetailRoot(config.detailContainerSelector);
    if (configured) {
      return configured;
    }

    const scrollTarget = getScrollTarget(config);
    if (scrollTarget.element) {
      return scrollTarget.element;
    }

    return findRightSideDetailRoot() || findFullPageDetailRoot();
  }

  function findConfiguredDetailRoot(selector) {
    if (!selector) {
      return null;
    }

    try {
      return chooseBestDetailRoot(Array.from(document.querySelectorAll(selector)));
    } catch {
      return null;
    }
  }

  function findRightSideDetailRoot() {
    const candidates = Array.from(document.querySelectorAll("main, section, article, aside, div"))
      .filter((element) => {
        if (element.id === OVERLAY_ID || element.closest(`#${OVERLAY_ID}`)) {
          return false;
        }
        if (!isVisible(element)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const textLength = getTextLines(element).join("").length;
        return rect.left > window.innerWidth * 0.25 && rect.right > window.innerWidth * 0.45 && rect.width > 300 && rect.height > 220 && textLength > 80;
      });

    return chooseBestDetailRoot(candidates);
  }

  function findFullPageDetailRoot() {
    const candidates = Array.from(document.querySelectorAll("main, section, article, .content, .container, .detail, .job-detail, div"))
      .filter((element) => {
        if (element.id === OVERLAY_ID || element.closest(`#${OVERLAY_ID}`)) {
          return false;
        }
        if (!isVisible(element)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const textLength = getTextLines(element).join("").length;
        return rect.width > 320 && rect.height > 180 && textLength > 120;
      });

    return chooseBestDetailRoot(candidates);
  }

  function chooseBestDetailRoot(candidates) {
    return candidates
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const textLength = getTextLines(element).join("").length;
        const rightBias = Math.max(0, rect.left / Math.max(window.innerWidth, 1));
        return {
          element,
          score: textLength + rect.height * 0.2 + rightBias * 500
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.element ?? null;
  }

  function getTextLines(node) {
    const text = (node?.innerText || node?.textContent || "").trim();
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function firstTextBySelectors(root, selectors) {
    for (const selector of selectors) {
      const value = firstVisibleText(root, selector);
      if (value) {
        return value;
      }
    }

    return "";
  }

  function firstVisibleText(root, selector) {
    try {
      const nodes = Array.from(root.querySelectorAll(selector));
      const node = nodes.find(isVisible);
      return node ? cleanName(node.innerText || node.textContent || "") : "";
    } catch {
      return "";
    }
  }

  function findSalaryText(text) {
    return String(text || "").match(SALARY_PATTERN)?.[0]?.replace(/\s+/g, "") ?? "";
  }

  function deriveJobTitleFromLines(lines, salaryText) {
    const salaryLine = salaryText ? lines.find((line) => line.includes(salaryText)) : "";
    const firstLine = lines.find((line) => {
      if (line === salaryLine || findSalaryText(line) === line) {
        return false;
      }
      return !isJobTagLine(line) && !isLocationLine(line) && !isChromeLine(line);
    });

    return cleanTitle(firstLine || "", salaryText);
  }

  function deriveCompanyFromLines(lines, jobTitle, salaryText) {
    return lines.find((line) => {
      if (!line || line === jobTitle || line.includes(salaryText)) {
        return false;
      }
      if (isJobTagLine(line) || isLocationLine(line) || isChromeLine(line)) {
        return false;
      }
      return !SALARY_PATTERN.test(line);
    }) || "";
  }

  function cleanTitle(text, salaryText = "") {
    let clean = cleanName(text);
    const salary = salaryText || findSalaryText(clean);
    if (salary) {
      clean = clean.replace(salary, "");
    }
    return clean.replace(SALARY_PATTERN, "").replace(/[|｜].*$/g, "").trim();
  }

  function cleanName(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .trim();
  }

  function buildMarkdownFilename(metadata) {
    return [
      metadata.jobTitle || "未知岗位",
      metadata.companyName || "未知企业",
      metadata.salaryText || "未知薪资"
    ].map(cleanName).join("-");
  }

  function isJobTagLine(line) {
    return /^(经验不限|在校|应届|实习|兼职|全职|本科|大专|硕士|博士|学历不限|\d+\s*-\s*\d+年|\d+年以上|\d+年以内)$/i.test(line);
  }

  function isLocationLine(line) {
    return /^(北京|上海|广州|深圳|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|郑州|青岛|合肥|厦门|全国|远程)[·\-\s]/.test(line);
  }

  function isChromeLine(line) {
    return /^(收藏|立即沟通|微信扫码分享|举报|去App|与BOSS随时沟通|点击查看地图|在线)$/.test(line);
  }

  function isLikelyNavigationLine(line) {
    return /^(首页|职位推荐|贵阳站|政企招聘|校园招聘|高端职位|海外招聘|驻外专区|测评及培训|职Q社区|消息|我要招人|登录\/注册|登录|注册|搜索|清空筛选条件)$/.test(line);
  }

  function highlightTarget(node) {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((item) => item.classList.remove(HIGHLIGHT_CLASS));
    node.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => node.classList.remove(HIGHLIGHT_CLASS), 2500);
  }

  function clickLikeUser(node) {
    const target = node;
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    const anchor = target.matches?.("a[href]") ? target : target.closest?.("a[href]");
    const oldTarget = anchor?.getAttribute("target");
    if (anchor) {
      anchor.setAttribute("target", "_self");
    }

    target.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    target.dispatchEvent(new MouseEvent("mousemove", eventOptions));
    target.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    target.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));

    if (anchor) {
      if (oldTarget === null) {
        anchor.removeAttribute("target");
      } else {
        anchor.setAttribute("target", oldTarget);
      }
    }
  }

  function getScrollTarget(config) {
    const configured = findConfiguredScrollTarget(config.detailContainerSelector);
    if (configured) {
      return { element: configured };
    }

    const detected = findRightSideScrollableElement();
    if (detected) {
      return { element: detected };
    }

    return { element: null };
  }

  function findConfiguredScrollTarget(selector) {
    if (!selector) {
      return null;
    }

    try {
      const candidates = Array.from(document.querySelectorAll(selector));
      return candidates.find(isScrollableElement) ?? null;
    } catch {
      return null;
    }
  }

  function findRightSideScrollableElement() {
    const candidates = Array.from(document.querySelectorAll("main, section, article, aside, div"))
      .filter((element) => {
        if (element.id === OVERLAY_ID || element.closest(`#${OVERLAY_ID}`)) {
          return false;
        }
        if (!isVisible(element) || !isScrollableElement(element)) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.right > window.innerWidth * 0.45 && rect.width > 260 && rect.height > 220;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const overflow = element.scrollHeight - element.clientHeight;
        const rightBias = Math.max(0, rect.left / Math.max(window.innerWidth, 1));
        return {
          element,
          score: overflow + rect.height * 0.35 + rightBias * 500
        };
      })
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.element ?? null;
  }

  function isScrollableElement(element) {
    if (!element || element === document.body || element === document.documentElement) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const canScroll = /(auto|scroll|overlay)/.test(overflowY);
    return canScroll && element.scrollHeight > element.clientHeight + 8;
  }

  function restoreListViewport(state) {
    const target = getScrollTarget(state.config);
    if (target.element) {
      return;
    }

    window.scrollTo({
      left: state.listScrollX ?? 0,
      top: state.listScrollY ?? 0,
      behavior: "smooth"
    });
  }

  function renderOverlay(state, text) {
    const activeState = state ?? {};
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.innerHTML = `
        <div class="sda-title">
          <span>自动浏览搜索详情</span>
          <div class="sda-actions">
            <button class="sda-continue" type="button">继续</button>
            <button class="sda-stop" type="button">停止</button>
          </div>
        </div>
        <div class="sda-status"></div>
        <div class="sda-progress"></div>
      `;
      document.documentElement.appendChild(overlay);
      overlay.querySelector(".sda-continue").addEventListener("click", () => {
        continueAfterManualPageChange().catch((error) => {
          renderOverlay(null, `继续失败：${error?.message ?? error}`);
        });
      });
      overlay.querySelector(".sda-stop").addEventListener("click", () => {
        stopRun("已停止。").catch(() => {});
      });
    }

    overlay.querySelector(".sda-continue").style.display = activeState.mode === "waitingNextPage" ? "inline-block" : "none";
    overlay.querySelector(".sda-status").textContent = text || getModeText(activeState);
    overlay.querySelector(".sda-progress").textContent = formatProgress(activeState);
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function formatProgress(state) {
    if (!state?.config) {
      return "";
    }

    return `进度：${state.completed ?? 0}/${state.config.count}，当前页序号：${(state.currentIndex ?? 0) + 1}`;
  }

  function getModeText(state) {
    switch (state?.mode) {
      case "list":
        return "正在列表页准备打开下一条。";
      case "detail":
        return "正在详情页浏览。";
      case "returning":
        return "正在返回列表页。";
      case "waitingDetailTab":
        return "正在等待详情新标签页完成。";
      case "waitingNextItem":
        return "当前条已完成，请点击下一条。";
      case "waitingNextPage":
        return "当前页已浏览完，请手动跳转到下一页。";
      case "done":
        return "浏览任务已完成。";
      default:
        return "准备执行。";
    }
  }

  async function stopRun(text) {
    window.clearTimeout(activeTimer);
    window.clearInterval(urlWatcher);
    urlWatcher = null;
    await clearState();
    renderOverlay({ mode: "stopped" }, text);
    window.setTimeout(removeOverlay, 1600);
  }

  function startUrlWatcher() {
    window.clearInterval(urlWatcher);
    let lastUrl = location.href;
    urlWatcher = window.setInterval(async () => {
      if (location.href === lastUrl) {
        return;
      }
      lastUrl = location.href;
      const state = await getState();
      if (!state?.running || state.mode !== "waitingNextPage") {
        return;
      }
      await setState({
        ...state,
        mode: "list",
        currentIndex: 0,
        listUrl: location.href,
        waitingPageUrl: "",
        alertedPageUrl: "",
        updatedAt: Date.now()
      });
      window.clearInterval(urlWatcher);
      urlWatcher = null;
      scheduleRun(600);
    }, 500);
  }

  async function continueAfterManualPageChange() {
    const state = await getState();
    if (!state?.running) {
      return;
    }

    await setState({
      ...state,
      mode: "list",
      currentIndex: 0,
      listUrl: location.href,
      waitingPageUrl: "",
      alertedPageUrl: "",
      updatedAt: Date.now()
    });
    window.clearInterval(urlWatcher);
    urlWatcher = null;
    renderOverlay(state, "已继续，准备扫描当前页面列表。");
    scheduleRun(400);
  }

  async function continueToNextItem(state) {
    const currentState = state ?? (await getState());
    if (!currentState?.running) {
      return { ok: false, error: "当前没有正在运行的任务。" };
    }

    if (currentState.mode !== "waitingNextItem" && currentState.mode !== "list") {
      return { ok: false, error: "当前状态不能手动切换到下一条。请先完成当前条目。" };
    }

    const nextState = {
      ...currentState,
      mode: "list",
      listUrl: location.href,
      waitingPageUrl: "",
      alertedPageUrl: "",
      updatedAt: Date.now()
    };
    await setState(nextState);
    renderOverlay(nextState, "已切换到下一条，准备继续扫描。");
    scheduleRun(180);

    return {
      ok: true,
      message: "已切换到下一条。",
      state: nextState
    };
  }

  function shouldPauseForNextItem(state) {
    return state?.config?.pinCurrentPage === true;
  }

  function notifyPage(message) {
    window.setTimeout(() => {
      try {
        window.alert(message);
      } catch {
        renderOverlay(null, message);
      }
    }, 50);
  }

  function waitForDocumentReady() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }
})();
