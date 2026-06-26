// Background service worker: capture + download + OmniParser survive popup close.

const FIXED_WIDTH = 1920;
const FIXED_HEIGHT = 1080;
// Extra time after viewport resize so lazy content can repaint before screenshot.
const RENDER_WAIT_MS = 600;
const OMNIPARSER_URL =
  "https://zenot.shop/parse?box_threshold=0.05&iou_threshold=0.1&use_paddleocr=true&imgsz=640&return_image=true";

let captureInProgress = false;

function broadcastStatus(phase, message, data = null) {
  const payload = { type: "CAPTURE_STATUS", phase, message, data, at: Date.now() };
  chrome.runtime.sendMessage(payload).catch(() => {});
  chrome.storage.session.set({ lastCaptureStatus: payload, captureInProgress }).catch(() => {});
}

// Always restore tab layout even when capture or API call fails.
async function cleanupDebugger(target) {
  try {
    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride");
  } catch (_) {}
  try {
    await chrome.debugger.detach(target);
  } catch (_) {}
}

function summarizeParseResult(data) {
  if (!data) return "No parse data returned.";
  if (Array.isArray(data)) return `${data.length} element(s) detected.`;
  if (Array.isArray(data.elements)) return `${data.elements.length} element(s) detected.`;
  if (Array.isArray(data.parsed_content_list)) {
    return `${data.parsed_content_list.length} parsed item(s).`;
  }
  const text = JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// Privacy: full screenshot is POSTed to zenot.shop for OCR / UI parsing.
async function sendToOmniParser(dataUrl) {
  const base64Data = dataUrl.split(",")[1];
  const byteString = atob(base64Data);
  const byteArray = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    byteArray[i] = byteString.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: "image/png" });

  const formData = new FormData();
  formData.append("image", blob, "screenshot.png");

  const response = await fetch(OMNIPARSER_URL, { method: "POST", body: formData });

  if (!response.ok) {
    throw new Error(`OmniParser server returned ${response.status}`);
  }

  return response.json();
}

async function captureFixedSize(tabId) {
  const target = { tabId };
  captureInProgress = true;
  chrome.storage.session.set({ captureInProgress: true }).catch(() => {});

  try {
    broadcastStatus("capturing", "Capturing at 1920×1080…");

    await chrome.debugger.attach(target, "1.3");

    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: FIXED_WIDTH,
      height: FIXED_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false
    });

    await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));

    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });

    await cleanupDebugger(target);

    const dataUrl = `data:image/png;base64,${result.data}`;

    broadcastStatus("saved", "Screenshot saved, sending to OmniParser…");

    await chrome.downloads.download({
      url: dataUrl,
      filename: `fixed-screenshot-${Date.now()}.png`,
      saveAs: false
    });

    broadcastStatus("parsing", "Waiting for OmniParser response…");

    const parsedData = await sendToOmniParser(dataUrl);
    const summary = summarizeParseResult(parsedData);

    broadcastStatus("done", "Done ✅", { summary, raw: parsedData });
    console.log("OmniParser result:", parsedData);
  } catch (err) {
    console.error("Capture pipeline failed:", err);
    await cleanupDebugger(target);

    const msg = String(err?.message || err);
    if (/chrome:\/\//i.test(msg) || /Cannot access/i.test(msg)) {
      broadcastStatus("error", "This page type cannot be captured. Use a normal website tab.");
    } else if (/OmniParser/i.test(msg)) {
      broadcastStatus("error", `OmniParser failed: ${msg}`);
    } else {
      broadcastStatus("error", `Capture failed: ${msg}`);
    }
  } finally {
    captureInProgress = false;
    chrome.storage.session.set({ captureInProgress: false }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "START_CAPTURE") return false;

  if (captureInProgress) {
    sendResponse({ started: false, reason: "Capture already in progress." });
    return false;
  }

  captureFixedSize(message.tabId);
  sendResponse({ started: true });
  return false;
});
