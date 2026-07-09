// Background service worker — no Chrome Debugger API used anywhere.
// Screenshot : chrome.tabs.captureVisibleTab
// Actions    : chrome.scripting.executeScript (DOM injection)

const ACTION_DELAY_MS = 400;
const BACKEND_URL = "http://localhost:5000";
const OMNIPARSER_URL =
  "https://zenot.shop/parse?box_threshold=0.05&iou_threshold=0.1&use_paddleocr=true&imgsz=640&return_image=true";
const FETCH_TIMEOUT_MS = 30000;

let captureInProgress = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Status broadcasting ───────────────────────────────────────────────────

// Badge helpers — show live status on the extension icon without reopening popup
const BADGE_COLORS = {
  capturing : "#6366f1",
  parsing   : "#6366f1",
  deciding  : "#6366f1",
  executing : "#f59e0b",
  done      : "#22c55e",
  error     : "#ef4444"
};

function setBadge(phase, shortText) {
  const color = BADGE_COLORS[phase] || "#6366f1";
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text: shortText }).catch(() => {});
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

function phaseToShort(phase) {
  switch (phase) {
    case "capturing" : return "📸";
    case "parsing"   : return "🔍";
    case "deciding"  : return "🤔";
    case "executing" : return "⚡";
    case "done"      : return "✅";
    case "error"     : return "❌";
    default          : return "…";
  }
}

function broadcastStatus(phase, message, data = null) {
  const payload = { type: "CAPTURE_STATUS", phase, message, data, at: Date.now() };
  // Try to reach popup if it happens to be open (e.g. user opened it mid-task)
  chrome.runtime.sendMessage(payload).catch(() => {});
  // Always persist — popup reads this when user manually opens it after task
  chrome.storage.session.set({ lastCaptureStatus: payload, captureInProgress }).catch(() => {});
  // Show live status on extension icon badge — visible even when popup is closed
  setBadge(phase, phaseToShort(phase));
  if (phase === "done" || phase === "error") {
    // Auto-clear badge after 6 seconds
    setTimeout(clearBadge, 6000);
  }
}

// ─── Screenshot ───────────────────────────────────────────────────────────

async function captureScreenshot(tabId) {
  // captureVisibleTab captures the currently visible viewport — no debugger needed.
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  return dataUrl;
}

// ─── OmniParser ───────────────────────────────────────────────────────────

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

  const response = await fetchWithTimeout(OMNIPARSER_URL, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`OmniParser server returned ${response.status}`);
  return response.json();
}

function summarizeParseResult(data) {
  if (!data) return "No parse data returned.";
  if (Array.isArray(data)) return `${data.length} element(s) detected.`;
  if (Array.isArray(data.elements)) return `${data.elements.length} element(s) detected.`;
  if (Array.isArray(data.parsed_content_list)) return `${data.parsed_content_list.length} parsed item(s).`;
  const text = JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// ─── Element list builder ─────────────────────────────────────────────────

function normalizeParseElements(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return [];
}

function inferElementType(content) {
  const lower = content.toLowerCase();
  if (!content || lower === "none" || lower === "null") return "icon";
  return "text";
}

function parseElementContent(element, index) {
  if (typeof element === "object" && element !== null) {
    return {
      type: element.type ?? inferElementType(element.content ?? element.text ?? ""),
      content: String(element.content ?? element.text ?? `element-${index}`).trim()
    };
  }
  let content = String(element).trim();
  const numbered = content.match(/^\d+:\s*(.*)$/);
  if (numbered) content = numbered[1].trim();
  const typed = content.match(/^(icon|text):\s*(.*)$/i);
  if (typed) return { type: typed[1].toLowerCase(), content: typed[2].trim() || `element-${index}` };
  return { type: inferElementType(content), content: content || `element-${index}` };
}

function buildElementList(elements, coordinates, imageWidth, imageHeight) {
  const items = normalizeParseElements(elements);
  if (!items.length) return [];

  return items.map((element, i) => {
    const { type, content } = parseElementContent(element, i);
    const raw = Array.isArray(coordinates)
      ? coordinates[i]
      : coordinates?.[String(i)] ?? coordinates?.[i];

    if (!raw || raw.length < 4) return null;

    let [a, b, c, d] = raw.map(Number);
    const normalized = a <= 1 && b <= 1 && c <= 1 && d <= 1;
    if (normalized) { a *= imageWidth; b *= imageHeight; c *= imageWidth; d *= imageHeight; }

    const x1 = Math.round(a);
    const y1 = Math.round(b);
    const x2 = c > a ? Math.round(c) : Math.round(a + c);
    const y2 = d > b ? Math.round(d) : Math.round(b + d);

    return { id: i, type, content, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }).filter(Boolean);
}

// ─── Backend / Claude ─────────────────────────────────────────────────────

async function askClaudeForActions(elementList, userTask) {
  if (!elementList.length) {
    return null;
  }
  const response = await fetchWithTimeout(`${BACKEND_URL}/decide-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ elements: elementList, task: userTask })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Backend returned ${response.status}: ${detail}`);
  }
  return response.json();
}

// ─── Action label (for status messages) ──────────────────────────────────

function formatActionLabel(action) {
  switch (action.action) {
    case "click":   return `Click #${action.element_id} at (${action.x}, ${action.y})`;
    case "type":    return `Type "${action.text}" at (${action.x}, ${action.y})`;
    case "scroll":  return `Scroll ${action.direction || "down"} ${action.amount || 400}px`;
    case "press_key": return `Press ${action.key}`;
    default:        return `${action.action}`;
  }
}

// ─── DOM actions via chrome.scripting ────────────────────────────────────
// Each action is injected as a self-contained function into the page.
// No debugger, no CDP — pure DOM + synthetic events.

async function scriptClick(tabId, x, y) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (cx, cy) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return;
        el.focus?.();
        ["mousedown", "mouseup", "click"].forEach((type) => {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy
          }));
        });
      },
      args: [x, y]
    });
  } catch (err) {
    console.error("scriptClick failed:", err);
  }
}

async function scriptType(tabId, x, y, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (cx, cy, value) => {
        const el = document.elementFromPoint(cx, cy);
        if (!el) return;

        ["mousedown", "mouseup", "click"].forEach((type) => {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy
          }));
        });

        el.focus?.();

        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) nativeSetter.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = "";
        }

        for (const char of value) {
          el.dispatchEvent(new KeyboardEvent("keydown",  { key: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
              "value"
            )?.set;
            if (nativeSetter) nativeSetter.call(el, el.value + char);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent += char;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
          }

          el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        }

        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      args: [x, y, String(text ?? "")]
    });
  } catch (err) {
    console.error("scriptType failed:", err);
  }
}

async function scriptScroll(tabId, direction = "down", amount = 400) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (dir, amt) => {
        window.scrollBy({ top: dir === "up" ? -amt : amt, behavior: "smooth" });
      },
      args: [direction, amount]
    });
  } catch (err) {
    console.error("scriptScroll failed:", err);
  }
}

async function scriptPressKey(tabId, key) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (k) => {
        const el = document.activeElement || document.body;
        ["keydown", "keyup"].forEach((type) => {
          el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
        });
        if (k === "Enter") {
          const form = el.closest?.("form");
          if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
      },
      args: [key]
    });
  } catch (err) {
    console.error("scriptPressKey failed:", err);
  }
}

// ─── Action runner ────────────────────────────────────────────────────────

async function runActions(tabId, actions) {
  let completed = 0;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    broadcastStatus("executing", `Step ${i + 1}/${actions.length}: ${formatActionLabel(action)}`);

    try {
      switch (action.action) {
        case "click":
          if (action.x == null || action.y == null)
            throw new Error(`Click action missing coordinates (step ${i + 1})`);
          await scriptClick(tabId, action.x, action.y);
          break;

        case "type":
          if (action.x == null || action.y == null)
            throw new Error(`Type action missing coordinates (step ${i + 1})`);
          await scriptType(tabId, action.x, action.y, action.text ?? "");
          break;

        case "scroll":
          await scriptScroll(tabId, action.direction ?? "down", action.amount ?? 400);
          break;

        case "press_key":
          await scriptPressKey(tabId, action.key || "Enter");
          break;

        default:
          console.warn("Unknown action skipped:", action);
      }
      completed++;
    } catch (err) {
      console.error(`Action ${i + 1} failed:`, err);
    }

    await sleep(ACTION_DELAY_MS);
  }
  return completed;
}

// ─── Main pipeline ────────────────────────────────────────────────────────

async function captureAndAct(tabId, userTask = "Click the most relevant button") {
  captureInProgress = true;
  chrome.storage.session.set({ captureInProgress: true }).catch(() => {});

  try {
    // 1. Screenshot — popup.js closes the popup window before sending
    //    START_CAPTURE, so by the time we reach here the popup is gone.
    broadcastStatus("capturing", "Capturing screenshot…");
    await sleep(150); // small buffer for browser to finish repainting
    const dataUrl = await captureScreenshot(tabId);

    // 2. OmniParser
    broadcastStatus("parsing", "Sending to OmniParser…");
    const parsedData = await sendToOmniParser(dataUrl);
    const summary = summarizeParseResult(parsedData);
    let decision = null;
    let doneMessage = "Done ✅";

    if (parsedData) {
      const elements = parsedData.elements ?? parsedData.parsed_content_list;
      const coordinates = parsedData.coordinates ?? parsedData.label_coordinates;

      let dims = { w: 1280, h: 800 };
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({ w: window.innerWidth, h: window.innerHeight })
        });
        if (results?.[0]?.result) dims = results[0].result;
      } catch (_) {}

      const imageWidth  = dims.w;
      const imageHeight = dims.h;
      const elementList = buildElementList(elements, coordinates, imageWidth, imageHeight);

      broadcastStatus("deciding", "Asking Claude for an action plan…");
      decision = await askClaudeForActions(elementList, userTask);

      if (decision?.actions?.length) {
        broadcastStatus("executing", `Running ${decision.actions.length} action(s)…`);
        const completed = await runActions(tabId, decision.actions);
        const completedMessage = completed < decision.actions.length
          ? ` (${completed}/${decision.actions.length} completed)`
          : "";
        doneMessage = `Done ✅${completedMessage}`;
      } else {
        doneMessage = decision === null ? "Task failed — no response from backend" : "Done ✅";
      }
    } else {
      doneMessage = "Done ✅";
    }

    broadcastStatus("done", doneMessage, { summary, raw: parsedData, decision });

  } catch (err) {
    console.error("Pipeline failed:", err);
    const msg = String(err?.message || err);
    if (/chrome:\/\//i.test(msg) || /Cannot access/i.test(msg)) {
      broadcastStatus("error", "Cannot capture this page. Open a normal website (https://…) first.");
    } else if (/OmniParser/i.test(msg)) {
      broadcastStatus("error", `OmniParser failed: ${msg}`);
    } else if (/Backend/i.test(msg)) {
      broadcastStatus("error", `Backend failed: ${msg}`);
    } else {
      broadcastStatus("error", `Task failed: ${msg}`);
    }
  } finally {
    captureInProgress = false;
    chrome.storage.session.set({ captureInProgress: false }).catch(() => {});
  }
}

// ─── Message listener (fallback) ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "START_CAPTURE") return false;

  if (captureInProgress) {
    sendResponse({ started: false, reason: "Capture already in progress." });
    return false;
  }

  captureAndAct(message.tabId, message.userTask);
  sendResponse({ started: true });
  return false;
});

// ─── Storage listener — triggered after popup closes itself ───────────────
// popup.js writes { pendingTask: { tabId, userTask } } to session storage
// then calls window.close(). We pick it up here once the popup is gone.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.pendingTask?.newValue) return;
  if (captureInProgress) return;

  const { tabId, userTask } = changes.pendingTask.newValue;

  // Clear it immediately so it doesn't re-fire
  chrome.storage.session.remove("pendingTask").catch(() => {});

  captureAndAct(tabId, userTask);
});