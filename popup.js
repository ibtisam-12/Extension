const FIXED_WIDTH = 1920;
const FIXED_HEIGHT = 1080;
const statusDiv = document.getElementById("status");
const tabInfoDiv = document.getElementById("tabInfo");
const captureBtn = document.getElementById("captureBtn");

function isCaptureRestricted(url) {
  if (!url) return false;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url);
}

function describeTab(url) {
  if (!url) return { text: "Page URL unavailable — capture may still work on http/https sites.", warn: true };
  if (isCaptureRestricted(url)) {
    return {
      text: `Blocked: ${url}\nSwitch to a normal website (https://…) first, then click the extension again.`,
      warn: true
    };
  }
  return { text: `Ready: ${url}`, warn: false };
}

async function refreshTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const info = describeTab(tab?.url);
  tabInfoDiv.textContent = info.text;
  tabInfoDiv.className = info.warn ? "warn" : "";
  captureBtn.disabled = tab?.url ? isCaptureRestricted(tab.url) : false;
  return tab;
}

refreshTabInfo();

captureBtn.addEventListener("click", async () => {
  const tab = await refreshTabInfo();

  if (tab?.url && isCaptureRestricted(tab.url)) {
    statusDiv.textContent = "Open a normal website in this tab, then try again.";
    return;
  }

  statusDiv.textContent = "Capturing…";
  captureBtn.disabled = true;

  try {
    await captureFixedSize(tab.id);
  } finally {
    captureBtn.disabled = tab?.url ? isCaptureRestricted(tab.url) : false;
  }
});

async function captureFixedSize(tabId) {
  const target = { tabId };

  try {
    await chrome.debugger.attach(target, "1.3");

    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: FIXED_WIDTH,
      height: FIXED_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false
    });

    await new Promise(r => setTimeout(r, 300));

    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });

    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride");
    await chrome.debugger.detach(target);

    const dataUrl = `data:image/png;base64,${result.data}`;

    statusDiv.textContent = "Saved ✅";
    await chrome.downloads.download({
      url: dataUrl,
      filename: `fixed-screenshot-${Date.now()}.png`,
      saveAs: false
    });
  } catch (err) {
    console.error("Debugger capture failed:", err);
    const msg = String(err?.message || err);
    if (/chrome:\/\//i.test(msg) || /Cannot access/i.test(msg)) {
      statusDiv.textContent = "This page type cannot be captured. Use a normal website tab.";
    } else {
      statusDiv.textContent = `Capture failed: ${msg}`;
    }
    chrome.debugger.detach(target).catch(() => {});
  }
}
