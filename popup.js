const statusDiv = document.getElementById("status");
const tabInfoDiv = document.getElementById("tabInfo");
const resultsDiv = document.getElementById("results");
const captureBtn = document.getElementById("captureBtn");

// Chrome blocks debugger capture on internal browser / extension pages.
function isCaptureRestricted(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url);
}

function describeTab(url) {
  if (!url) {
    return { text: "Page URL unavailable — capture may still work on http/https sites.", warn: true };
  }
  if (isCaptureRestricted(url)) {
    return {
      text: `Blocked: ${url}\nSwitch to a normal website (https://…) first, then click the extension again.`,
      warn: true
    };
  }
  return { text: `Ready: ${url}`, warn: false };
}

function showParseResults(data) {
  if (!data?.summary) {
    resultsDiv.hidden = true;
    return;
  }
  resultsDiv.hidden = false;
  resultsDiv.textContent = data.summary;
}

function applyStatus(payload) {
  if (!payload) return;
  statusDiv.textContent = payload.message;
  if (payload.phase === "done") {
    showParseResults(payload.data);
    refreshTabInfo().then((tab) => {
      captureBtn.disabled = tab?.url ? isCaptureRestricted(tab.url) : false;
    });
  }
  if (payload.phase === "error") {
    resultsDiv.hidden = true;
    refreshTabInfo().then((tab) => {
      captureBtn.disabled = tab?.url ? isCaptureRestricted(tab.url) : false;
    });
  }
}

async function refreshTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const info = describeTab(tab?.url);
  tabInfoDiv.textContent = info.text;
  tabInfoDiv.className = info.warn ? "warn" : "";
  captureBtn.disabled = tab?.url ? isCaptureRestricted(tab.url) : false;
  return tab;
}

// Restore last run status if popup was closed mid-capture.
async function restoreLastStatus() {
  const { lastCaptureStatus, captureInProgress: inProgress } =
    await chrome.storage.session.get(["lastCaptureStatus", "captureInProgress"]);
  applyStatus(lastCaptureStatus);
  if (inProgress) captureBtn.disabled = true;
}

async function initPopup() {
  await refreshTabInfo();
  await restoreLastStatus();
}

// Live updates from background while popup stays open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CAPTURE_STATUS") applyStatus(msg);
});

initPopup();

captureBtn.addEventListener("click", async () => {
  const tab = await refreshTabInfo();

  if (!tab?.id) {
    statusDiv.textContent = "No active tab found.";
    return;
  }

  if (tab.url && isCaptureRestricted(tab.url)) {
    statusDiv.textContent = "Open a normal website in this tab, then try again.";
    return;
  }

  resultsDiv.hidden = true;
  statusDiv.textContent = "Starting capture…";
  captureBtn.disabled = true;

  try {
    // Work continues in background.js even if this popup closes.
    const res = await chrome.runtime.sendMessage({ type: "START_CAPTURE", tabId: tab.id });
    if (res && !res.started) {
      statusDiv.textContent = res.reason || "Capture already running.";
      const freshTab = await refreshTabInfo();
      captureBtn.disabled = freshTab?.url ? isCaptureRestricted(freshTab.url) : false;
    }
  } catch (err) {
    statusDiv.textContent = `Could not start capture: ${err?.message || err}`;
    const freshTab = await refreshTabInfo();
    captureBtn.disabled = freshTab?.url ? isCaptureRestricted(freshTab.url) : false;
  }
});
