const statusDiv  = document.getElementById("status");
const tabInfoDiv = document.getElementById("tabInfo");
const resultsDiv = document.getElementById("results");
const captureBtn = document.getElementById("captureBtn");
const taskInput  = document.getElementById("taskInput");

function isCaptureRestricted(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url);
}

function describeTab(url) {
  if (!url) return { text: "Page URL unavailable — capture may still work on http/https sites.", warn: true };
  if (isCaptureRestricted(url)) {
    return {
      text: `Blocked: ${url}\nSwitch to a normal website (https://…) first.`,
      warn: true
    };
  }
  return { text: `Ready: ${url}`, warn: false };
}

function formatAction(action, index) {
  switch (action.action) {
    case "click":     return `${index + 1}. Click #${action.element_id} at (${action.x}, ${action.y})`;
    case "type":      return `${index + 1}. Type "${action.text}" at (${action.x}, ${action.y})`;
    case "scroll":    return `${index + 1}. Scroll ${action.direction || "down"} ${action.amount || 400}px`;
    case "press_key": return `${index + 1}. Press ${action.key}`;
    default:          return `${index + 1}. ${action.action}`;
  }
}

function showParseResults(data) {
  if (!data?.summary && !data?.decision) { resultsDiv.hidden = true; return; }
  resultsDiv.hidden = false;
  const lines = [];
  if (data.summary) lines.push(data.summary);
  if (data.decision?.summary) lines.push(`\nPlan: ${data.decision.summary}`);
  if (data.decision?.actions?.length) {
    lines.push("\nActions:");
    data.decision.actions.forEach((action, i) => {
      lines.push(formatAction(action, i));
      if (action.reasoning) lines.push(`   -> ${action.reasoning}`);
    });
  }
  resultsDiv.textContent = lines.join("\n");
}

function applyStatus(payload) {
  if (!payload) return;
  statusDiv.textContent = payload.message;
  if (payload.phase === "done")  showParseResults(payload.data);
  if (payload.phase === "error") resultsDiv.hidden = true;
}

async function refreshTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const info = describeTab(tab?.url);
  tabInfoDiv.textContent = info.text;
  tabInfoDiv.className   = info.warn ? "warn" : "";
  captureBtn.disabled    = tab?.url ? isCaptureRestricted(tab.url) : false;
  return tab;
}

async function initPopup() {
  await refreshTabInfo();

  // Restore last known status from session (task may have run while popup was closed)
  const { lastCaptureStatus, captureInProgress: inProgress } =
    await chrome.storage.session.get(["lastCaptureStatus", "captureInProgress"]);

  if (inProgress) {
    captureBtn.disabled = true;
    statusDiv.textContent = lastCaptureStatus?.message || "Task in progress…";
  } else {
    applyStatus(lastCaptureStatus);
  }
}

// Listen for live updates if popup happens to be open during a task
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "CAPTURE_STATUS") return;
  applyStatus(msg);
  // Re-enable button once task finishes
  if (msg.phase === "done" || msg.phase === "error") {
    refreshTabInfo();
  }
});

initPopup();

captureBtn.addEventListener("click", async () => {
  const tab = await refreshTabInfo();

  if (!tab?.id) { statusDiv.textContent = "No active tab found."; return; }
  if (tab.url && isCaptureRestricted(tab.url)) {
    statusDiv.textContent = "Open a normal website in this tab, then try again.";
    return;
  }

  const userTask = taskInput?.value?.trim() || "Click the most relevant button";

  resultsDiv.hidden = true;
  statusDiv.textContent = "Starting…";
  captureBtn.disabled = true;

  try {
    // Save task to session storage, then close popup so it won't appear in screenshot.
    // background.js picks it up via storage.onChanged once popup window is gone.
    await chrome.storage.session.set({ pendingTask: { tabId: tab.id, userTask } });
    window.close();
  } catch (err) {
    statusDiv.textContent = `Could not start task: ${err?.message || err}`;
    captureBtn.disabled = false;
  }
});