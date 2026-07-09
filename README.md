# AI Page Agent

![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-MV3-blue)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2020-yellow)
![AI](https://img.shields.io/badge/AI-Vision%20Agent-purple)
![Claude](https://img.shields.io/badge/Claude-Anthropic-green)
![OmniParser](https://img.shields.io/badge/OmniParser-UI%20Detection-orange)

**AI Page Agent** is a Chrome extension that captures a screenshot of the current page, parses UI elements via OmniParser, plans actions with Claude, and executes click/type/scroll/keystroke commands through DOM injection — all without the Chrome Debugger Protocol.

## Features

- 📸 **Screenshot capture** — `chrome.tabs.captureVisibleTab` (no debugger, no permissions beyond `activeTab`)
- 🔍 **OmniParser integration** — Sends screenshots to a remote OmniParser server to detect UI elements and their coordinates
- 🤔 **Claude-powered decisions** — Sends parsed elements + a user-defined task to a local backend running Claude; Claude returns multi-step action plans
- ⚡ **DOM-injected actions** — `click`, `type`, `scroll`, `press_key` executed via `chrome.scripting.executeScript` with synthetic MouseEvent/KeyboardEvent dispatching (React/Vue/Angular compatible)
- 🏷️ **Live badge status** — Extension icon shows emoji badges (`📸` → `🔍` → `🤔` → `⚡` → `✅`) during each pipeline phase
- 🪟 **Self-closing popup** — Popup closes before capture so it never appears in the screenshot; background picks up the task via `storage.onChanged`
- 📜 **Multi-step action plans** — Claude can return a sequence of actions, each executed with a configurable delay
- 🔁 **Storage-backed status** — Last capture status persists in `chrome.storage.session` for retrieval after popup reopens

## How It Works

```
User opens popup, describes task, clicks "Run"
          │
          ▼
   ┌─────────────────┐
   │  START CAPTURE  │  popup.js writes { tabId, userTask }
   │                 │  to session storage, then window.close()
   └────────┬────────┘
            │ storage.onChanged
            ▼
   ┌─────────────────┐
   │    1. SCREENSHOT│  background.js captures visible tab as PNG
   │  "capturing"    │  chrome.tabs.captureVisibleTab
   └────────┬────────┘
            │ dataUrl (base64)
            ▼
   ┌─────────────────┐
   │  2. OmniParser  │  POST screenshot → OmniParser server
   │   "parsing"     │  Returns detected elements + coordinates
   └────────┬────────┘
            │ parsedData
            ▼
   ┌─────────────────┐
   │  3. Build list  │  Normalize elements, scale coords to viewport
   │                 │  Get actual window dimensions via executeScript
   └────────┬────────┘
            │ elementList
            ▼
   ┌─────────────────┐
   │  4. Claude      │  POST elements + task → local backend
   │   "deciding"    │  Returns { actions: [...], summary }
   └────────┬────────┘
            │ decision
            ▼
   ┌─────────────────┐
   │  5. Execute     │  For each action in decision.actions:
   │  "executing"    │    click  → scriptClick (elementFromPoint + MouseEvent)
   │                 │    type   → scriptType (native value setter + InputEvent)
   │                 │    scroll → window.scrollBy
   │                 │    press_key → KeyboardEvent on activeElement
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │     DONE ✅     │  Badge clears after 6s, status saved to storage
   └─────────────────┘
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌───────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │ popup.html│   │ background.js│   │  Injected Script  │  │
│  │ popup.js  │──▶│ (SW)         │──▶│  (executeScript)  │  │
│  └───────────┘   └──────┬───────┘   └───────────────────┘  │
│                         │                                    │
│                  captureVisibleTab                            │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
   ┌──────────────────┐   ┌────────────────────┐
   │  OmniParser API  │   │  Local Backend     │
   │  (remote server) │   │  (localhost:5000)  │
   │  /parse          │   │  /decide-action    │
   │  Returns:        │   │  Returns:          │
   │  elements +      │   │  { actions: [...] }│
   │  coordinates     │   └────────────────────┘
   └──────────────────┘
```

## Installation

1. **Clone or download** this repository
2. Open **chrome://extensions** in Chrome
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked** and select the `frontend/` directory
5. The **AI Page Agent** icon now appears in the toolbar

### Permissions

| Permission | Purpose |
|-----------|---------|
| `activeTab` | Screenshot + script injection on the current tab |
| `tabs` | Query active tab URL and ID |
| `scripting` | Execute DOM-injected actions |
| `storage` | Persist task + status across popup open/close |
| `http://localhost:5000/*` | Communicate with local Claude backend |
| `https://zenot.shop/*` | Communicate with OmniParser server |

## Backend Setup

The extension expects a local server running at `http://localhost:5000` with a `POST /decide-action` endpoint.

### Request shape

```json
{
  "elements": [
    { "id": 0, "type": "text", "content": "Sign in", "x": 150, "y": 300 },
    { "id": 1, "type": "icon", "content": "search",  "x": 900, "y": 120 }
  ],
  "task": "Click the Sign in button"
}
```

### Response shape

```json
{
  "summary": "Clicked Sign in",
  "actions": [
    { "action": "click", "element_id": 0, "x": 150, "y": 300, "reasoning": "This is the Sign in button" }
  ]
}
```

### Supported action types

| Type | Fields |
|------|--------|
| `click` | `element_id`, `x`, `y` |
| `type` | `element_id`, `x`, `y`, `text` |
| `scroll` | `direction` ("down"/"up"), `amount` (px) |
| `press_key` | `key` (e.g. "Enter", "Escape") |

A sample FastAPI backend that wraps the Anthropic Claude API can be found alongside this extension.

## Project Structure

```
ai-page-agent/
├── README.md
└── frontend/
    ├── manifest.json      # Chrome Extension Manifest V3
    ├── background.js      # Service worker — screenshot, pipe, decide, execute
    ├── popup.html         # Popup UI — task input + status display
    └── popup.js           # Popup logic — send task, close, show results
```

## License

MIT
