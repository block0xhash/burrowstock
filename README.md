# burrowstock

> Snap it. Burrow it. Find it. Sell it.

A local-first desktop app for cataloguing physical items using AI vision. Photograph your pile of junk, let Gemini identify every item, organise by location, search instantly, and generate marketplace listings in seconds.

Built with Tauri v2 + Rust. Sub-second startup. No cloud. No accounts. No subscription.

---

## What it does

### 📷 AI-Powered Scanning
Photograph a pile of items — a box of electronics, a shelf of tools, a wardrobe. Gemini Vision identifies every single item visible, even partially hidden ones. One photo can yield 20+ catalogued items in seconds.

- Identifies brand, model, generation, ports (for IT hardware)
- Notes condition, colour, size, visible defects
- Assigns eBay-standard conditions: Brand New / Like New / Very Good / Good / Acceptable
- Shows confidence score per item
- Tracks tokens used and estimated API cost per scan

### 📦 Location Catalog
Organise your inventory by physical location — boxes, shelves, rooms, storage units.

- Create unlimited locations with colour coding
- Inline rename and delete with confirmation
- Each location stores the original scan photo
- Click the scan photo thumbnail to open a full zoom/pan modal
- Items list with category badges and condition indicators
- Filter items within a location instantly

### 🔍 Full-Text Search
Find anything across your entire catalog instantly using SQLite FTS5 — same technology that powers search in major applications.

- Search by item name, notes, category, or location
- Results appear as you type with 150ms debounce
- Matching text highlighted in results
- Results grouped by location, collapsible
- Handles thousands of items with no slowdown

### 🏷️ AI Listing Generator
Select an item, add individual photos (not the pile — just that item), and generate a complete marketplace listing.

- Supports: **eBay**, **Facebook Marketplace**, **Gumtree**, **OLX**
- AI writes keyword-rich titles (max 80 chars for eBay)
- Full description with honest condition report
- Market-based price estimate with low/high range
- Keywords/search terms included
- Copy listing to clipboard — paste anywhere
- Platform-specific format (formal for eBay, casual for Facebook)

### ✏️ Item Management
Full CRUD on every item in your catalog.

- Click any item to open detail panel
- Edit name, condition, location, notes inline
- Move items between locations
- Custom dropdowns — no broken native selects on Linux
- Rename and delete with undo-safe confirmation modals
- Changes save in under a second (targeted SQLite writes, no full reload)

### 📊 Usage & Cost Tracking
Know exactly what you're spending on AI.

- Tracks scan tokens and listing tokens separately
- Model-aware pricing (Gemini 3.5 Flash, 2.5 Flash, Flash Latest, etc.)
- Daily quota bar — shows usage vs free tier limit (1,500 req/day)
- Estimated locally, links to Google AI Studio for real quota
- Resets at midnight Pacific Time

### ⚙️ Settings
- Bring your own Gemini API key — stored locally, never sent anywhere except Google
- Load all available models from your API key
- Dark and light theme (toggle in topbar)
- AI prompts visible in read-only mode — unlock with superuser confirmation to edit
- Separate scan prompt and listing prompt, both fully customisable

### 🔒 Privacy
- **Everything stays on your machine.** Photos, catalog, API key.
- The only outbound connection is to `generativelanguage.googleapis.com` when you scan or generate a listing.
- SQLite database at `~/.config/burrowstock/catalog.db`
- Settings at `~/.config/burrowstock/settings.json`
- No telemetry. No analytics. No accounts.

---

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 |
| Backend | Rust |
| Database | SQLite + FTS5 (rusqlite) |
| AI Vision | Google Gemini API (gemini-flash-latest) |
| HTTP | reqwest (Rust) |
| UI | Vanilla JS + CSS — no framework |
| Image serving | Custom `bslocal://` Rust protocol handler |

No npm. No node_modules. No Electron. No bundler.

---

## Prerequisites

### All platforms
```bash
# Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli
```

### Linux (Ubuntu/Debian)
```bash
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

### macOS
```bash
xcode-select --install
```

### Windows
Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

---

## Run

```bash
git clone https://github.com/block0xhash/burrowstock
cd burrowstock
cargo tauri dev
```

First run compiles Rust (~2 minutes). Subsequent runs start in under a second. Frontend changes hot-reload instantly without recompiling.

---

## Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com/apikey)
2. Sign in with a Google account
3. Click **Create API key**
4. Copy the key
5. Open Burrowstock → Settings → API & Model → paste key → Save

**Free tier:** 1,500 requests/day · 15 requests/minute · No credit card required

---

## Build release binary

```bash
cargo tauri build
```

Output in `src-tauri/target/release/bundle/`:

| Platform | File |
|---|---|
| Linux | `burrowstock_0.1.0_amd64.AppImage` |
| macOS | `burrowstock_0.1.0_aarch64.dmg` |
| Windows | `burrowstock_0.1.0_x64-setup.exe` |

---

## Project structure

```
burrowstock/
├── src/
│   ├── index.html          # App shell
│   ├── app.js              # All UI — state, render, events
│   ├── app.css             # Styles — dark/light theme, all components
│   └── tauri-bridge.js     # window.bs.* — JS to Tauri IPC bridge
└── src-tauri/
    ├── src/
    │   ├── main.rs         # Entry point
    │   ├── lib.rs          # Tauri commands + bslocal:// protocol
    │   ├── db.rs           # SQLite schema, migrations, queries, FTS5
    │   └── vision.rs       # Gemini API — scanning + listing generation
    ├── capabilities/
    │   └── default.json    # Tauri security capabilities
    ├── Cargo.toml
    └── tauri.conf.json
```

---

## Roadmap

### v1 (current)
- Scan photos with AI
- Full catalog with location management
- FTS5 search
- AI listing generator
- Copy to clipboard for any marketplace

### v2
- One-click post to eBay via OAuth (user's own account)
- Facebook Marketplace integration
- Subscription: $9/month or $79 lifetime

### v3
- Mobile companion app (iOS/Android) for taking sell photos
- Cloud sync across devices (optional, encrypted)

---

## License

MIT — do whatever you want with it.
