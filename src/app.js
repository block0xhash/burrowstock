/**
 * burrowstock — app.js
 *
 * Single-page renderer. Architecture:
 *   state       — single source of truth, never mutated directly outside setters
 *   render()    — rebuilds DOM from state, wires events
 *   panels      — catalogPanel, scanPanel, searchPanel, settingsPanel
 *   detail      — slide-in item detail + eBay listing panel
 *
 * All IPC calls go through window.bs (defined in preload.js).
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const CONDITIONS = ['brand_new', 'like_new', 'very_good', 'good', 'acceptable', 'unknown'];
const CONDITION_LABELS = {
  brand_new:  'Brand New',
  like_new:   'Like New',
  very_good:  'Very Good',
  good:       'Good',
  acceptable: 'Acceptable',
  unknown:    'Unknown',
};
// Map old condition values to new eBay ones
const CONDITION_MAP = {
  new: 'brand_new', fair: 'acceptable', poor: 'acceptable',
};
function normaliseCondition(c) {
  return CONDITION_MAP[c] || (CONDITIONS.includes(c) ? c : 'unknown');
}
const LOC_COLORS  = ['--loc-1','--loc-2','--loc-3','--loc-4','--loc-5','--loc-6','--loc-7','--loc-8'];
const LOC_COLORS_COUNT = LOC_COLORS.length;

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  tab:         'locations',
  settings:    { geminiKey: '', geminiModel: 'gemini-3.5-flash', theme: 'dark' },
  locations:   [],
  items:       [],
  filtered:    [],
  locFilter:   'all',
  query:       '',
  selectedItem: null,       // item currently shown in detail panel
  detailTab:   'details',   // 'details' | 'sell'
  listing:     null,        // generated eBay listing data
  listingPhotos: [],        // { path, url }[] for item sell photos
  listingPrice: '',
  listingLoading: false,
  geminiModels: [],
  search:      { expanded: {} },
  scan: {
    phase:    'idle',       // idle | photo | scanning | results | done
    imagePath: null,
    imageUrl:  null,
    results:   [],
    logs:      [],
    logOpen:   true,
  },
  settingsTab: 'api',
  defaultScanPrompt:    '',
  defaultListingPrompt: '',
  promptUnlocked: false,
  itemsSort: 'name',
  itemsSortDir: 'asc',
  listingPlatform: 'ebay',
  renamingLocation: null,  // id of location being renamed
  showAddLocation: false,
  showAddItem: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getFileSizeKb(path) {
  try {
    // Use fetch to get file size via bslocal protocol
    const url  = `bslocal://localhost${path.startsWith('/') ? path : '/' + path}`;
    const resp = await fetch(url, { method: 'HEAD' });
    const len  = resp.headers.get('content-length');
    if (len) return `${(parseInt(len)/1024).toFixed(0)}KB`;
  } catch {}
  return 'unknown size';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Boot ─────────────────────────────────────────────────────────────────────────
async function boot() {
  // Load everything in parallel for fast startup
  const [settings, locations, items, defaultScan, defaultListing] = await Promise.all([
    window.bs.loadSettings(),
    window.bs.listLocations(),
    window.bs.listItems(),
    window.bs.getDefaultPrompt(),
    window.bs.getDefaultListingPrompt(),
  ]);

  state.settings            = settings ?? state.settings;
  state.defaultScanPrompt    = defaultScan    || '';
  state.defaultListingPrompt = defaultListing || '';

  // Migrate old model defaults to 3.5
  if (!state.settings.geminiModel || state.settings.geminiModel === 'gemini-2.5-flash') {
    state.settings.geminiModel = 'gemini-3.5-flash';
    await window.bs.saveSettings(state.settings);
  }

  // Reset daily counters if it's a new day
  const today = new Date().toDateString();
  if (state.settings.quotaDate !== today) {
    state.settings.quotaDate     = today;
    state.settings.todayScans    = 0;
    state.settings.todayListings = 0;
    await window.bs.saveSettings(state.settings);
  }
  // First run — seed todayScans from totalScans so existing usage shows
  if (!state.settings.todayScans && state.settings.totalScans) {
    state.settings.todayScans    = state.settings.totalScans    || 0;
    state.settings.todayListings = state.settings.totalListings || 0;
    await window.bs.saveSettings(state.settings);
  }

  // Clear corrupt scanPrompt — if it doesn't look like a real prompt, reset it
  if (state.settings.scanPrompt && state.settings.scanPrompt.length < 100) {
    state.settings.scanPrompt = null;
    await window.bs.saveSettings(state.settings);
  }

  state.locations = locations;
  state.items     = items;
  if (locations.length && state.locFilter === 'all') {
    state.locFilter = locations[0].id;
  }
  applyTheme(state.settings.theme);
  applyFilter();
  render();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

// ── Data refresh ────────────────────────────────────────────────────────────────
async function refreshData() {
  [state.locations, state.items] = await Promise.all([
    window.bs.listLocations(),
    window.bs.listItems(),
  ]);
  applyFilter();
}

// Lightweight refresh — only reload items, not locations
async function refreshItems() {
  state.items = await window.bs.listItems();
  applyFilter();
}

// Lightest refresh — update a single item in state without any API call
function updateItemInState(updatedItem) {
  const idx = state.items.findIndex(i => i.id === updatedItem.id);
  if (idx >= 0) state.items[idx] = updatedItem;
  applyFilter();
}

function applyFilter() {
  let items = state.items;
  if (state.locFilter !== 'all')
    items = items.filter(i => i.location_id === state.locFilter);
  if (state.query)
    items = items.filter(i =>
      i.name.toLowerCase().includes(state.query.toLowerCase()) ||
      (i.notes||'').toLowerCase().includes(state.query.toLowerCase())
    );
  state.filtered = items;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('root').innerHTML = shell();
  bindEvents();
}

function shell() {
  const showSidebar = state.tab === 'locations';
  const showDetail  = state.selectedItem && (state.tab === 'locations' || state.tab === 'items' || state.tab === 'search');

  return `
    ${topbar()}
    <div class="body">
      ${showSidebar ? `<aside class="sidebar">${sidebar()}</aside>` : ''}
      <div class="main" id="main-panel">
        ${mainPanel()}
      </div>
      ${showDetail ? detailSidePanel() : ''}
    </div>`;
}

// ── Topbar ────────────────────────────────────────────────────────────────────
function topbar() {
  const isDark = state.settings.theme !== 'light';
  return `
    <header class="topbar">
      <div class="logo">burrow<span>stock</span></div>
      <nav class="nav">
        ${navBtn('locations','📦', 'Locations')}
        ${navBtn('scan',     '📷', 'Scan')}
        ${navBtn('items',    '📋', 'Items')}
        ${navBtn('search',   '🔍', 'Search')}
        ${navBtn('settings', '⚙️',  'Settings')}
      </nav>
      <div class="topbar-right">
        <button class="theme-btn" id="theme-toggle" title="${isDark ? 'Switch to light mode' : 'Switch to dark mode'}">
          ${isDark ? '☀️' : '🌙'}
        </button>
        <div class="model-badge">${state.settings.geminiModel || 'gemini-3.5-flash'}</div>
      </div>
    </header>`;
}

const navBtn = (id, icon, label) =>
  `<button class="nav-btn${state.tab === id ? ' active' : ''}" data-tab="${id}">
    <span class="nav-icon">${icon}</span>${label}
   </button>`;

// ── Sidebar ───────────────────────────────────────────────────────────────────
function locColor(id) {
  const idx = state.locations.findIndex(l => l.id === id);
  return idx >= 0 ? `var(${LOC_COLORS[idx % LOC_COLORS_COUNT]})` : 'var(--neutral)';
}

function condClass(cond) {
  const c = normaliseCondition((cond||'unknown').toLowerCase().replace(/\s+/g,'_'));
  return `condition-${c}`;
}

function sidebar() {
  const locRows = state.locations.length
    ? state.locations.map((l, i) => {
        const color      = `var(${LOC_COLORS[i % LOC_COLORS_COUNT]})`;
        const isRenaming = state.renamingLocation === l.id;
        const isActive   = state.locFilter === l.id;

        if (isRenaming) return `
          <div class="loc-row active loc-renaming-row" data-loc="${l.id}">
            <span class="loc-dot" style="background:${color};flex-shrink:0"></span>
            <input class="loc-rename-input" id="loc-rename-input-${l.id}"
              value="${l.id.replace(/"/g,'&quot;')}" data-old-id="${l.id}"
              autocomplete="off" spellcheck="false">
            <button class="loc-rename-confirm" data-id="${l.id}" title="Save (Enter)">✓</button>
            <button class="loc-rename-cancel" title="Cancel (Esc)">✕</button>
          </div>`;

        return `
          <div class="loc-row${isActive ? ' active' : ''}" data-loc="${l.id}">
            <span class="loc-dot" style="background:${color}"></span>
            <span class="loc-name">${l.id}</span>
            <span class="loc-count">${l.item_count}</span>
            <span class="loc-row-actions">
              <button class="loc-action-btn rename loc-rename-btn" data-id="${l.id}" title="Rename">✎</button>
              <button class="loc-action-btn delete loc-delete-btn" data-id="${l.id}" title="Delete">🗑</button>
            </span>
          </div>`;
      }).join('')
    : `<div class="sidebar-empty-hint">No locations yet.<br>Scan a photo to create one.</div>`;

  const addLocForm = state.showAddLocation ? `
    <div class="inline-form">
      <input class="input" id="new-loc-input" placeholder="e.g. Garage Shelf" autofocus>
      <div class="inline-form-btns">
        <button class="btn primary" id="confirm-add-loc-btn">Add</button>
        <button class="btn ghost" id="cancel-add-loc-btn">Cancel</button>
      </div>
    </div>` : '';

  return `
    <div class="sidebar-scroll">
      <div class="sidebar-section">
        <div class="sidebar-label">Locations</div>
        ${locRows}
        ${addLocForm}
      </div>
    </div>
    <div class="sidebar-footer">
      ${!state.showAddLocation
        ? '<button class="sidebar-add-btn" id="add-location-btn">+ Add location</button>'
        : ''}
    </div>`;
}

// ── Main panel router ─────────────────────────────────────────────────────────
function mainPanel() {
  switch (state.tab) {
    case 'locations': return locationsPanel();
    case 'items':     return itemsPanel();
    case 'scan':      return scanPanel();
    case 'search':    return searchPanel();
    case 'settings':  return settingsPanel();
    default:          return '';
  }
}

// ── Locations panel — sidebar + location content ─────────────────────────────
function locationsPanel() {
  if (!state.locFilter || state.locFilter === 'all') return `
    <div class="empty">
      <span class="empty-icon">📦</span>
      <p>Select a location to view its items</p>
      <button class="btn primary" id="scan-btn-empty">📷 Scan your first location</button>
    </div>`;

  const items    = state.filtered;
  const color    = locColor(state.locFilter);
  const dot      = `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:8px;vertical-align:middle"></span>`;
  const addForm  = state.showAddItem ? `
    <div class="add-item-form">
      <input class="input" id="new-item-name" placeholder="Item name…" style="flex:2" autofocus>
      <div class="cond-custom-select" id="add-item-cond-wrap" style="flex:1;min-width:110px">
        <div class="cond-trigger" id="add-cond-trigger">
          <span class="cond-trigger-text condition-unknown" id="add-cond-text">Unknown</span>
          <span style="font-size:9px;color:var(--text-3)">▾</span>
        </div>
        <div class="cond-dropdown" id="add-cond-dropdown" style="display:none">
          ${CONDITIONS.map(c => `<div class="cond-option ${condClass(c)}" data-add-cond="${c}">${CONDITION_LABELS[c]}</div>`).join('')}
        </div>
      </div>
      <input class="input" id="new-item-notes" placeholder="Notes (optional)" style="flex:2">
      <button class="btn primary" id="confirm-add-item-btn">Add</button>
      <button class="btn ghost" id="cancel-add-item-btn">✕</button>
    </div>` : '';

  // Get scan photo from first item that has one
  const rawScanImg = items.find(i => i.scan_image)?.scan_image;
  const scanImg = rawScanImg ? rawScanImg.replace(/\\/g, '/') : null;
  const scanDate = items.length
    ? new Date(items[0].added_at * 1000).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
    : '';

  const locHeader = scanImg ? `
    <div class="loc-scan-header">
      <div class="loc-scan-thumb" id="loc-scan-thumb-wrap" data-expanded="false">
        <img src="bslocal://localhost${scanImg}" alt="Scan photo" id="loc-scan-img">
        <div class="loc-scan-expand-hint" id="loc-scan-hint">Click to expand</div>
      </div>
      <div class="loc-scan-meta">
        <div class="loc-scan-label">📷 Scan photo</div>
        <div class="loc-scan-date">${scanDate}</div>
        <div class="loc-scan-count">${items.length} items identified</div>
      </div>
    </div>` : '';

  const itemRows = items.map((item, i) => `
    <tr class="item-row${state.selectedItem?.id === item.id ? ' selected' : ''}" data-item-id="${item.id}">
      <td class="col-num">${i + 1}</td>
      <td class="col-name">
        <div class="item-name">${item.name}</div>
        ${item.notes ? `<div class="item-notes">${item.notes}</div>` : ''}
      </td>
      <td class="col-cat"><span class="cat-pill">${item.category}</span></td>
      <td class="col-cond">
        <span class="condition-badge ${condClass(item.condition)}">${CONDITION_LABELS[item.condition]||item.condition}</span>
      </td>
      <td class="col-conf" style="color:var(--text-3);font-family:var(--font-mono)">${item.confidence}%</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="row-btn" id="sell-btn-${item.id}" title="Sell on eBay" style="color:var(--accent)">🏷️</button>
          <button class="row-btn rename item-rename-btn" data-id="${item.id}" data-name="${item.name.replace(/"/g,'&quot;')}" title="Rename">✎</button>
          <button class="row-btn delete item-delete-btn" data-id="${item.id}" title="Delete">✕</button>
        </span>
      </td>
    </tr>`).join('');

  const emptyBody = `
    <div class="empty">
      <span class="empty-icon">📭</span>
      <p>No items in this location</p>
      <div class="flex gap-2" style="margin-top:8px">
        <button class="btn" id="add-item-btn">+ Add item</button>
        <button class="btn primary" id="scan-btn-empty">📷 Scan</button>
      </div>
    </div>`;

  return `
    <div class="panel-header">
      <div class="panel-title">${dot}${state.locFilter}</div>
      <span class="panel-subtitle">${items.length} item${items.length !== 1 ? 's' : ''}</span>
      <input class="input" id="catalog-search" placeholder="Filter…" value="${state.query}" style="width:160px;margin-left:auto">
      <button class="btn" id="add-item-btn">+ Add item</button>
      <button class="btn primary" id="scan-btn">📷 Scan</button>
    </div>
    ${addForm}
    ${items.length
      ? `${locHeader}
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th class="col-num">#</th>
              <th>Item</th>
              <th style="width:120px">Category</th>
              <th style="width:110px">Condition</th>
              <th style="width:44px">%</th>
              <th style="width:90px"></th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>`
      : emptyBody
    }`;
}

// ── Item detail panel ─────────────────────────────────────────────────────────
function detailSidePanel() {
  const item = state.selectedItem;
  if (!item) return '';

  const photos       = state.listingPhotos;
  const displayPhoto = photos[0] || null;  // only show item-specific photos, not the pile scan

  const detailsTab = `
    <div class="flex-col gap-3">
      <div class="detail-photo" id="detail-main-photo">
        ${displayPhoto
          ? `<img src="${displayPhoto.url}" alt="${item.name}">
             <div class="detail-photo-overlay">📷 Change photo</div>`
          : `<div class="detail-photo-placeholder">
               <div style="font-size:32px;margin-bottom:6px">📷</div>
               <div style="font-size:12px">No photo</div>
               <div style="font-size:10px;margin-top:4px;color:var(--text-3)">Click to add for selling</div>
             </div>
             <div class="detail-photo-overlay">📷 Add photos</div>`
        }
      </div>

      ${photos.length > 1 ? `
        <div class="detail-photos-strip">
          ${photos.map((p,i) => `
            <img class="detail-photo-thumb${i===0?' active':''}" src="${p.url}"
              alt="Photo ${i+1}" data-photo-idx="${i}">
          `).join('')}
        </div>` : ''}

      <div class="field-group">
        <label class="field-label">Name</label>
        <input class="input" id="detail-name" value="${item.name.replace(/"/g,'&quot;')}" placeholder="Item name">
      </div>

      <div class="flex gap-2">
        <div class="field-group" style="flex:1">
          <label class="field-label">Condition</label>
          <div class="custom-select-wrap" id="detail-cond-wrap">
            <div class="custom-select-trigger" id="detail-cond-trigger">
              <span id="detail-cond-text" class="${condClass(item.condition)}">${CONDITION_LABELS[item.condition]||item.condition}</span>
              <span class="custom-select-arrow">▾</span>
            </div>
            <div class="custom-select-dropdown" id="detail-cond-dropdown" style="display:none">
              ${CONDITIONS.map(c => `
                <div class="custom-select-option cond-option ${condClass(c)}${item.condition===c?' selected':''}"
                  data-detail-cond="${c}">${CONDITION_LABELS[c]}</div>
              `).join('')}
            </div>
          </div>
          <input type="hidden" id="detail-condition" value="${item.condition}">
        </div>
        <div class="field-group" style="flex:1">
          <label class="field-label">Location</label>
          <div class="custom-select-wrap" id="detail-loc-wrap">
            <div class="custom-select-trigger" id="detail-loc-trigger">
              <span id="detail-loc-text">${item.location_id}</span>
              <span class="custom-select-arrow">▾</span>
            </div>
            <div class="custom-select-dropdown" id="detail-loc-dropdown" style="display:none">
              ${state.locations.map(l => `
                <div class="custom-select-option${l.id===item.location_id?' selected':''}"
                  data-detail-loc="${l.id}">${l.id}</div>
              `).join('')}
            </div>
          </div>
          <input type="hidden" id="detail-location" value="${item.location_id}">
        </div>
      </div>

      <div class="field-group">
        <label class="field-label">Notes</label>
        <textarea class="input" id="detail-notes" rows="3"
          placeholder="Condition details, serial numbers, accessories…"
          style="resize:vertical">${item.notes||''}</textarea>
      </div>

      <div class="flex gap-2" style="flex-wrap:wrap">
        <span class="cat-pill">${item.category}</span>
        <span class="condition-badge ${condClass(item.condition)}">${CONDITION_LABELS[item.condition]||item.condition}</span>
        <span style="font-size:11px;color:var(--text-3);font-family:var(--font-mono)">${item.confidence}% confidence</span>
      </div>

      <div class="flex gap-2">
        <button class="btn primary" id="save-detail-btn" style="flex:1">Save changes</button>
        <button class="btn" id="detail-sell-btn" style="flex:1">🏷️ Sell on eBay</button>
      </div>
    </div>`;

  const sellTab = sellPanel(item);

  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'sell',    label: '🏷️ Sell on eBay' },
  ];

  return `
    <div class="detail-panel-resize" id="detail-resize-handle"></div>
    <aside class="detail-panel">
      <div class="detail-header">
        <div class="detail-title">${item.name}</div>
        <button class="detail-close" id="detail-close-btn" title="Close">✕</button>
      </div>

      <div class="detail-tabs">
        ${tabs.map(t => `
          <button class="detail-tab-btn${state.detailTab===t.id?' active':''}"
            id="detail-tab-${t.id}">${t.label}</button>
        `).join('')}
      </div>

      <div class="detail-body">
        ${state.detailTab === 'details' ? detailsTab : sellTab}
      </div>
    </aside>`;
}

// ── Sell panel ────────────────────────────────────────────────────────────────
function sellPanel(item) {
  const photos  = state.listingPhotos;
  const listing = state.listing;

  // Photo strip
  const photoStrip = photos.length ? `
    <div class="sell-photos">
      ${photos.map((p,i) => `
        <div class="sell-photo-thumb">
          <img src="${p.url}" alt="Photo ${i+1}">
          <button class="sell-photo-remove" onclick="removeListingPhoto(${i})">✕</button>
        </div>`).join('')}
      ${photos.length < 5 ? `
        <div class="sell-photo-add" id="add-listing-photos-btn" title="Add more photos">+</div>` : ''}
    </div>
    <div class="sell-photo-hint">
      ${photos.length}/5 photos · damage, labels, accessories · plain background gets better prices
    </div>` : `
    <div class="sell-photo-empty" id="add-listing-photos-btn">
      <span style="font-size:28px">📷</span>
      <div style="font-size:13px;font-weight:600;margin-top:6px">Add photos of this item</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:3px">Not the pile — just this item alone</div>
    </div>
    <div class="sell-photo-tips">
      <div class="sell-tip-title">📸 Photo tips for better sales</div>
      <div class="sell-tips-grid">
        <div class="sell-tip">✓ Front &amp; back views</div>
        <div class="sell-tip">✓ Any damage or wear</div>
        <div class="sell-tip">✓ Labels &amp; model numbers</div>
        <div class="sell-tip">✓ What's included</div>
        <div class="sell-tip">✓ Plain background</div>
        <div class="sell-tip">✓ Good lighting</div>
      </div>
      <div class="sell-tip-note">Clear photos get higher prices and fewer disputes</div>
    </div>`;

  // Platform selector
  const platform  = state.listingPlatform || 'ebay';
  const platforms = [
    { id: 'ebay',      label: 'eBay',               emoji: '🛒' },
    { id: 'facebook',  label: 'Facebook Marketplace',emoji: '👤' },
    { id: 'gumtree',   label: 'Gumtree',             emoji: '🌳' },
    { id: 'olx',       label: 'OLX',                 emoji: '📦' },
  ];

  const platformBar = `
    <div class="platform-selector">
      ${platforms.map(p => `
        <button class="platform-btn${platform===p.id?' active':''}" data-platform="${p.id}">
          ${p.emoji} ${p.label}
        </button>`).join('')}
    </div>`;

  const preview = listing ? `
    <div class="listing-preview-card">
      <div class="listing-preview-title-row">
        <div class="listing-preview-title">${listing.title}</div>
        <button class="copy-btn" id="copy-title-btn" title="Copy title">⎘ Copy title</button>
      </div>

      <div class="listing-meta-row">
        <span class="condition-badge ${condClass(item.condition)}">${listing.condition}</span>
        <span class="cat-pill">${listing.category}</span>
      </div>

      <div class="listing-price-row">
        <div class="listing-price-wrap">
          <span class="listing-price-currency">$</span>
          <input id="listing-price-input" type="number" min="0" step="0.01"
            class="listing-price-input"
            value="${state.listingPrice || listing.price_low}">
        </div>
        <div class="listing-price-meta">
          <div>Market: $${listing.price_low} – $${listing.price_high}</div>
          <div style="font-size:10px;color:var(--text-3)">${listing.price_note}</div>
        </div>
      </div>

      <div class="listing-description">${listing.description}</div>

      <div class="listing-keywords">
        ${(listing.keywords||[]).map(k => `<span class="ebay-keyword">${k}</span>`).join('')}
      </div>
    </div>

    <div class="listing-actions">
      <button class="btn ghost" id="regenerate-listing-btn">↺ Regenerate</button>
      <button class="btn" id="copy-listing-btn">⎘ Copy listing</button>
      <button class="btn primary" style="opacity:0.45;cursor:not-allowed"
        title="One-click posting coming in v2">
        🚀 Post · v2
      </button>
    </div>` : '';

  return `
    <div class="flex-col gap-3">
      ${photoStrip}
      ${platformBar}
      <button class="btn primary" id="generate-listing-btn" ${state.listingLoading ? 'disabled' : ''}>
        ${state.listingLoading
          ? '<span class="pulse-dot" style="width:6px;height:6px;margin-right:6px"></span>Generating listing…'
          : `✨ Generate ${platforms.find(p=>p.id===platform)?.label||'eBay'} listing with AI`}
      </button>
      ${preview}
    </div>`;
}

// ── Scan ──────────────────────────────────────────────────────────────────────
function scanPanel() {
  const { phase, results, imageUrl, logs, logOpen } = state.scan;
  const hasResults = phase === 'results' || phase === 'done';

  const toolbarHtml = {
    idle: `
      <button class="btn" id="choose-photo-btn">📷 Choose photo</button>
      <span class="text-muted ml-auto">${state.settings.geminiModel}</span>`,
    photo: `
      <button class="btn" id="choose-photo-btn">📷 Choose photo</button>
      <button class="btn primary" id="do-scan-btn">▶ Scan</button>
      <button class="btn ghost" id="clear-photo-btn">Clear</button>
      <span class="text-muted ml-auto">${state.settings.geminiModel}</span>`,
    scanning: `
      <span class="pulse-dot"></span>
      <span class="text-muted">Analysing with ${state.settings.geminiModel}…</span>
      <button class="btn ghost ml-auto" id="cancel-scan-btn">Cancel</button>`,
    results: `
      <span class="text-muted">${results.length} items identified</span>
      ${Object.keys(state.scan.saved||{}).length > 0
        ? `<span class="text-success" style="margin-left:8px">✓ ${Object.keys(state.scan.saved).length} saved</span>`
        : ''
      }
      <button class="btn ghost ml-auto" id="scan-another-btn">New scan</button>
      <button class="btn primary" id="save-scan-btn">Save all with locations</button>`,
    done: `
      <span class="text-success">✓ All saved to catalog</span>
      <button class="btn ghost ml-auto" id="scan-another-btn">New scan</button>
      <button class="btn primary" id="go-catalog-btn">View catalog</button>`,
  }[phase] || '';

  const imageHtml = imageUrl
    ? `<img src="${imageUrl}" alt="Scan photo">`
    : `<div class="drop-zone" id="drop-zone" style="max-width:320px">
        <span class="drop-icon">📷</span>
        <p>Click to choose a photo</p>
        <small>JPG · PNG · WEBP · HEIC</small>
       </div>`;

  let resultsHtml;
  if (!hasResults) {
    resultsHtml = `<div class="empty"><p style="color:var(--text-3)">Identified items will appear here after scanning</p></div>`;
  } else if (phase === 'done') {
    resultsHtml = `<div class="empty"><span class="empty-icon">✅</span><p class="text-success">Saved ${results.filter(r=>r.checked!==false).length} items to catalog</p></div>`;
  } else {
    const saved = state.scan.saved || {};
    const rows = results.map((item, i) => `
      <tr class="${item.checked === false ? 'hidden-row' : ''}"
        style="${saved[i] ? 'opacity:0.35;background:var(--bg-overlay)' : item.checked === false ? 'opacity:0.35' : ''}">
        <td class="col-num">${saved[i] ? '✓' : i + 1}</td>
        <td style="width:24px">${saved[i]
          ? '<span style="color:var(--green);font-size:14px">✓</span>'
          : `<input type="checkbox" class="scan-check" data-idx="${i}" ${item.checked !== false ? 'checked' : ''} style="accent-color:var(--accent)">`
        }</td>
        <td class="col-name">
          <input class="inline-input" data-idx="${i}" data-field="name"
            value="${item.name.replace(/"/g,'&quot;')}" spellcheck="false">
          <div class="item-notes">${item.notes}</div>
        </td>
        <td style="width:110px">
          <div class="cond-custom-select" data-idx="${i}">
            <div class="cond-trigger" data-idx="${i}">
              <span class="cond-trigger-text ${condClass(item.condition)}">${CONDITION_LABELS[item.condition]||item.condition}</span>
              <span style="font-size:9px;color:var(--text-3)">▾</span>
            </div>
            <div class="cond-dropdown" style="display:none">
              ${CONDITIONS.map(c => `
                <div class="cond-option${item.condition===c?' selected':''} ${condClass(c)}" 
                  data-idx="${i}" data-value="${c}">${CONDITION_LABELS[c]}</div>
              `).join('')}
            </div>
          </div>
        </td>
        <td class="col-cat"><span class="cat-pill">${item.category}</span></td>
        <td class="col-conf">${item.confidence}%</td>
        <td style="width:110px">
          <input class="inline-input loc-input-inline" data-idx="${i}" data-field="location"
            value="${item.location || ''}" placeholder="location?">
        </td>
      </tr>`).join('');

    resultsHtml = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="col-num">#</th><th style="width:24px"></th>
            <th>Item</th><th>Condition</th><th>Category</th><th>%</th><th>Location</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  const logLines = (logs||[]).map(l => `<span class="log-line ${l.type}">${l.text}</span>`).join('')
    || `<span class="log-line info">Waiting for scan…</span>`;

  return `
    <div class="toolbar">${toolbarHtml}</div>
    <div class="scan-body">
      <div class="scan-top">
        <div class="scan-img-col" id="scan-img-col">${imageHtml}</div>
        <div class="col-divider" id="scan-col-divider"></div>
        <div class="scan-results-col" id="scan-results-col">
          <div class="col-header">Identified Items</div>
          ${resultsHtml}
        </div>
      </div>
      <div class="log-strip" id="log-strip">
        <div class="log-resize-handle" id="log-resize-handle"></div>
        <div class="log-header" id="log-toggle">
          API Log <span style="font-size:9px;margin-left:4px">${logOpen ? '▼' : '▶'}</span>
        </div>
        <div class="log-content" id="log-content" ${logOpen ? '' : 'style="display:none"'}>
          ${logLines}
        </div>
      </div>
    </div>`;
}

// ── Items panel — flat list of all items, no sidebar ─────────────────────────
function itemsPanel() {
  // Sort options
  const sortKey   = state.itemsSort   || 'name';
  const sortDir   = state.itemsSortDir || 'asc';
  const q         = state.query.toLowerCase();

  let items = [...state.items];

  // Filter
  if (q) items = items.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.notes||'').toLowerCase().includes(q) ||
    (i.category||'').toLowerCase().includes(q) ||
    i.location_id.toLowerCase().includes(q)
  );

  // Sort
  items.sort((a, b) => {
    let av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return sortDir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
  });

  const sortArrow = (key) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (!items.length && !q) return `
    <div class="items-panel-header">
      <div class="panel-title">All Items</div>
      <button class="btn primary" id="scan-btn">📷 Scan</button>
    </div>
    <div class="empty">
      <span class="empty-icon">📦</span>
      <p>No items yet — scan a location to get started</p>
    </div>`;

  const rows = items.map((item, i) => `
    <tr class="item-row${state.selectedItem?.id === item.id ? ' selected' : ''}" data-item-id="${item.id}">
      <td class="col-num" style="color:var(--text-3)">${i + 1}</td>
      <td class="col-name">
        <div class="item-name">${item.name}</div>
        ${item.notes ? `<div class="item-notes">${item.notes}</div>` : ''}
      </td>
      <td class="col-cat"><span class="cat-pill">${item.category}</span></td>
      <td class="col-cond">
        <span class="condition-badge ${condClass(item.condition)}">${CONDITION_LABELS[item.condition]||item.condition}</span>
      </td>
      <td class="col-loc">
        <span class="loc-pill" style="color:${locColor(item.location_id)};font-weight:600">${item.location_id}</span>
      </td>
      <td class="col-conf" style="font-family:var(--font-mono);color:var(--text-3)">${item.confidence}%</td>
      <td class="col-actions">
        <span class="row-actions">
          <button class="row-btn" style="color:var(--accent)" data-sell-id="${item.id}" title="Create listing">🏷️</button>
          <button class="row-btn rename item-rename-btn" data-id="${item.id}" data-name="${item.name.replace(/"/g,'&quot;')}" title="Rename">✎</button>
          <button class="row-btn delete item-delete-btn" data-id="${item.id}" title="Delete">✕</button>
        </span>
      </td>
    </tr>`).join('');

  return `
    <div class="items-panel-header">
      <div class="panel-title">All Items</div>
      <span class="panel-subtitle" style="color:var(--text-3)">${items.length} of ${state.items.length}</span>
      <div class="items-search-wrap">
        <input class="input" id="items-search" placeholder="Filter…"
          value="${state.query}" autocomplete="off" style="width:180px">
      </div>
      <button class="btn primary" id="scan-btn">📷 Scan</button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th class="col-num">#</th>
          <th class="col-name sortable" data-sort="name">Item${sortArrow('name')}</th>
          <th class="col-cat">Category</th>
          <th class="col-cond sortable" data-sort="condition">Condition${sortArrow('condition')}</th>
          <th class="col-loc sortable" data-sort="location_id">Location${sortArrow('location_id')}</th>
          <th class="col-conf sortable" data-sort="confidence">%${sortArrow('confidence')}</th>
          <th class="col-actions"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Search ────────────────────────────────────────────────────────────────────
function highlight(text, query) {
  if (!query) return text;
  const re  = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<mark class="search-highlight">$1</mark>');
}

function searchPanel() {
  const q         = state.query;
  const totalHits = 0; // FTS results loaded async in event handler

  return `
    <div class="search-header">
      <div class="search-input-wrap">
        <span class="search-icon">🔍</span>
        <input class="search-input-field" id="search-input"
          placeholder="Search items, notes, categories, locations…"
          value="${q}" autofocus autocomplete="off" spellcheck="false">
        ${q ? `<button class="search-clear-btn" id="search-clear-btn">✕</button>` : ''}
      </div>
      ${q ? `<div class="search-meta">${totalHits} result${totalHits !== 1 ? 's' : ''} for <strong>"${q}"</strong></div>` : ''}
    </div>
    <div class="search-body" id="search-results">
      ${!q
        ? `<div class="search-empty-state">
            <div class="search-empty-icon">🔍</div>
            <div class="search-empty-title">Search your catalog</div>
            <div class="search-empty-sub">Find any item across all locations instantly</div>
            <div class="search-tips">
              <div class="search-tip-item">Search by <strong>item name</strong> — "Dell laptop"</div>
              <div class="search-tip-item">Search by <strong>category</strong> — "cable" or "keyboard"</div>
              <div class="search-tip-item">Search by <strong>location</strong> — "Shelf A"</div>
              <div class="search-tip-item">Search by <strong>notes</strong> — "cracked screen"</div>
            </div>
           </div>`
        : '<div class="search-loading">Searching…</div>'  // FTS results injected by event handler
      }
    </div>`;
}

function buildSearchResults(hits, q) {
  // Group by location
  const groups = {};
  hits.forEach(i => { (groups[i.location_id] = groups[i.location_id] || []).push(i); });

  return Object.entries(groups).map(([locId, items]) => {
    const open = state.search.expanded[locId] !== false;
    const rows = items.map(i => `
      <tr class="item-row" data-item-id="${i.id}">
        <td class="col-name">
          <div class="item-name">${highlight(i.name, q)}</div>
          ${i.notes ? `<div class="item-notes">${highlight(i.notes, q)}</div>` : ''}
        </td>
        <td class="col-cat"><span class="cat-pill">${highlight(i.category, q)}</span></td>
        <td class="col-cond">
          <span class="condition-badge ${condClass(i.condition)}">${CONDITION_LABELS[i.condition]||i.condition}</span>
        </td>
        <td class="col-conf" style="font-family:var(--font-mono);color:var(--text-3)">${i.confidence}%</td>
        <td class="col-actions">
          <span class="row-actions">
            <button class="row-btn" style="color:var(--accent)" data-sell-id="${i.id}" title="Sell on eBay">🏷️</button>
            <button class="row-btn rename item-rename-btn" data-id="${i.id}" data-name="${i.name.replace(/"/g,'&quot;')}" title="Rename">✎</button>
            <button class="row-btn delete item-delete-btn" data-id="${i.id}" title="Delete">✕</button>
          </span>
        </td>
      </tr>`).join('');

    return `
      <div class="search-group">
        <div class="search-group-header" data-loc-group="${locId}">
          <span class="loc-dot" style="background:${locColor(locId)}"></span>
          <span class="search-group-name">${highlight(locId, q)}</span>
          <span class="loc-count">${items.length} match${items.length!==1?'es':''}</span>
          <span class="expand-arrow">${open ? '▼' : '▶'}</span>
        </div>
        ${open ? `
          <table class="data-table">
            <thead><tr>
              <th>Item</th><th>Category</th><th>Condition</th><th style="width:50px">%</th><th style="width:80px"></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>` : ''}
      </div>`;
  }).join('');
}


// Model-aware pricing — returns { inp, out } per million tokens
// ── Pricing ──────────────────────────────────────────────────────────────────────
function modelPricing(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('3.5-flash'))   return { inp: 1.50, out: 9.00 };
  if (m.includes('3.1-flash'))   return { inp: 0.50, out: 3.00 };
  if (m.includes('3-flash'))     return { inp: 0.50, out: 3.00 };
  if (m.includes('2.5-flash'))   return { inp: 0.30, out: 2.50 };
  if (m.includes('2.0-flash'))   return { inp: 0.10, out: 0.40 };
  if (m.includes('flash-latest'))return { inp: 0.30, out: 2.50 };
  if (m.includes('flash'))       return { inp: 0.30, out: 2.50 };
  if (m.includes('3.1-pro'))     return { inp: 2.00, out: 12.00 };
  if (m.includes('2.5-pro'))     return { inp: 1.25, out: 10.00 };
  if (m.includes('pro'))         return { inp: 1.25, out: 10.00 };
  return { inp: 0.30, out: 2.50 };
}

// ── Settings helpers ────────────────────────────────────────────────────────────
function quotaWidget(s) {
  const used  = (s.todayScans || 0) + (s.todayListings || 0);
  const limit = 1500;
  const pct       = used === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const remaining = Math.max(0, limit - used);
  const color     = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--green)';
  return `
    <div class="quota-display">
      <div class="quota-header">
        <span>Today's API usage</span>
        <span style="font-family:var(--font-mono);font-size:12px">${used} / ${limit}</span>
      </div>
      <div class="quota-bar-track">
        <div class="quota-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="quota-footer">
        <span style="color:${color}">${remaining} requests remaining today</span>
        <a href="https://aistudio.google.com" target="_blank" style="color:var(--accent);font-size:11px">Check quota ↗</a>
      </div>
      <div class="settings-hint">Estimated locally · actual quota at <a href="https://aistudio.google.com" target="_blank" style="color:var(--text-2)">aistudio.google.com ↗</a> · resets midnight PT</div>
    </div>`;
}

// ── Settings ──────────────────────────────────────────────────────────────────
// ── Settings panel ───────────────────────────────────────────────────────────────
function settingsPanel() {
  const s        = state.settings;
  const model    = s.geminiModel || 'gemini-3.5-flash';
  const hasKey   = !!s.geminiKey;
  const hasModels = state.geminiModels.length > 0;

  // ── Usage stats (shown at bottom of API tab) ──────────────────────────────
  const scanInp   = s.totalInputTokens         || 0;
  const scanOut   = s.totalOutputTokens        || 0;
  const scans     = s.totalScans               || 0;
  const listInp   = s.totalListingInputTokens  || 0;
  const listOut   = s.totalListingOutputTokens || 0;
  const listings  = s.totalListings            || 0;
  const totalInp  = scanInp  + listInp;
  const totalOut  = scanOut  + listOut;
  const px2       = modelPricing(model);
  const scanCost  = ((scanInp * px2.inp) + (scanOut * px2.out)) / 1_000_000;
  const listCost  = ((listInp * px2.inp) + (listOut * px2.out)) / 1_000_000;
  const totalCost = scanCost + listCost;

  // ── API & Model — two column: settings left, usage right ─────────────────
  const apiSection = `
    <div class="api-layout">
      <div class="api-settings-col">
        <div class="settings-heading">Gemini API</div>
        <div class="field-group">
          <label class="field-label">API Key</label>
          <div class="settings-row gap-2">
            <input class="input" id="gemini-key" type="password"
              placeholder="Paste your Gemini API key…"
              value="${s.geminiKey||''}" autocomplete="off">
            <a href="https://aistudio.google.com/apikey" target="_blank"
              class="btn ghost" style="white-space:nowrap">Get key ↗</a>
          </div>
          ${!hasKey ? '<div class="settings-hint warning">⚠ No API key — scanning will not work</div>' : quotaWidget(s)}
        </div>
        <div class="field-group">
          <label class="field-label">Model</label>
          <div class="custom-select-wrap" id="model-select-wrap">
            <div class="custom-select-trigger" id="model-trigger">
              <span id="model-trigger-text">${model}</span>
              <span class="custom-select-arrow">▾</span>
            </div>
            ${hasModels ? `
            <div class="custom-select-dropdown" id="model-dropdown" style="display:none">
              ${state.geminiModels.map(m =>
                `<div class="custom-select-option${m===model?' selected':''}" data-value="${m}">${m}</div>`
              ).join('')}
            </div>` : ''}
          </div>
          <input type="hidden" id="model-input" value="${model}">
          <div class="settings-row gap-2" style="margin-top:8px">
            ${hasModels
              ? `<span class="settings-hint">✓ ${state.geminiModels.length} models</span>
                 <button class="btn ghost" id="fetch-models-btn" style="font-size:11px">⟳ Refresh</button>`
              : `<button class="btn" id="fetch-models-btn">⟳ Load models</button>`
            }
          </div>
        </div>
        <div class="settings-divider"></div>
        <div class="settings-row gap-2">
          <button class="btn primary" id="save-settings-btn">Save settings</button>
          <span class="settings-msg" id="settings-msg"></span>
        </div>
      </div>

      <div class="api-usage-col">
        <div class="settings-heading">Usage & Cost</div>
        <div class="usage-side-grid">

          <div class="usage-mini-card">
            <div class="usage-section-title">📷 Scanning</div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${scans}</span><span class="usage-mini-label">scans</span></div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${(scanInp/1000).toFixed(1)}k</span><span class="usage-mini-label">input</span></div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${(scanOut/1000).toFixed(1)}k</span><span class="usage-mini-label">output</span></div>
            <div class="usage-mini-cost">$${scanCost.toFixed(4)}</div>
          </div>

          <div class="usage-mini-card">
            <div class="usage-section-title">🏷️ Listings</div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${listings}</span><span class="usage-mini-label">listings</span></div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${(listInp/1000).toFixed(1)}k</span><span class="usage-mini-label">input</span></div>
            <div class="usage-mini-stat"><span class="usage-mini-value">${(listOut/1000).toFixed(1)}k</span><span class="usage-mini-label">output</span></div>
            <div class="usage-mini-cost">$${listCost.toFixed(4)}</div>
          </div>

        </div>
        <div class="usage-detail" style="margin-top:12px">
          <div class="usage-detail-row"><span>Total cost</span><strong>$${totalCost.toFixed(4)}</strong></div>
          <div class="usage-detail-row"><span>Total tokens</span><strong>${((totalInp+totalOut)/1000).toFixed(1)}k</strong></div>
          <div class="usage-detail-row"><span>Model</span><strong style="font-size:11px">${model}</strong></div>
        </div>
        <div class="settings-hint" style="margin-top:8px">Pricing varies by model<br>Free tier: 1,500 req/day · ai.google.dev/pricing</div>
      </div>
    </div>`;

  // ── AI Prompts ─────────────────────────────────────────────────────────────
  const unlocked = state.promptUnlocked;
  const promptSection = `
    <div class="prompts-fullpage">

      <div class="prompt-lock-card ${unlocked ? 'unlocked' : ''}">
        <div class="prompt-lock-icon">${unlocked ? '🔓' : '🔒'}</div>
        <div class="prompt-lock-body">
          <div class="prompt-lock-title">${unlocked ? 'Superuser mode — prompts are editable' : 'AI Prompts are read-only'}</div>
          <div class="prompt-lock-desc">${unlocked
            ? 'Changes take effect on the next scan or listing generation. Reset to default anytime.'
            : 'These prompts are carefully engineered. Only unlock if you know what you are changing.'
          }</div>
        </div>
        <button class="btn ${unlocked ? 'danger' : ''}" id="toggle-prompt-lock-btn" style="${unlocked ? '' : 'border-color:var(--border-2);color:var(--text-2)'}">
          ${unlocked ? '🔒 Lock' : '🔓 Unlock to edit'}
        </button>
      </div>

      <div class="prompts-side-by-side">
        <div class="prompt-pane">
          <div class="prompt-pane-header">
            <div class="prompt-pane-left">
              <span class="prompt-pane-icon">📷</span>
              <div>
                <div class="prompt-pane-title">Scan Prompt</div>
                <div class="prompt-pane-sub">Photo identification · every scan</div>
              </div>
            </div>
            <span class="prompt-card-badge ${s.scanPrompt ? 'custom' : 'default'}">${s.scanPrompt ? 'Custom' : 'Default'}</span>
          </div>
          <textarea class="input prompt-textarea ${unlocked ? '' : 'locked'}" id="scan-prompt-input"
            autocomplete="off" spellcheck="false"
            ${unlocked ? '' : 'readonly'}
            >${s.scanPrompt || state.defaultScanPrompt}</textarea>
          <div class="prompt-pane-footer">
            ${unlocked ? `
              <button class="btn ghost" id="reset-scan-prompt-btn">↺ Default</button>
              <button class="btn primary" id="save-scan-prompt-btn">Save</button>
              <span class="settings-msg" id="scan-prompt-msg"></span>
            ` : '<span class="prompt-readonly-hint">🔒 Unlock to edit</span>'}
          </div>
        </div>

        <div class="prompt-pane-divider"></div>

        <div class="prompt-pane">
          <div class="prompt-pane-header">
            <div class="prompt-pane-left">
              <span class="prompt-pane-icon">🏷️</span>
              <div>
                <div class="prompt-pane-title">eBay Listing Prompt</div>
                <div class="prompt-pane-sub">Listing generation · sell flow</div>
              </div>
            </div>
            <span class="prompt-card-badge ${s.ebayPrompt ? 'custom' : 'default'}">${s.ebayPrompt ? 'Custom' : 'Default'}</span>
          </div>
          <textarea class="input prompt-textarea ${unlocked ? '' : 'locked'}" id="ebay-prompt-input"
            autocomplete="off" spellcheck="false"
            ${unlocked ? '' : 'readonly'}
            >${s.ebayPrompt || state.defaultListingPrompt}</textarea>
          <div class="prompt-pane-footer">
            ${unlocked ? `
              <button class="btn ghost" id="reset-ebay-prompt-btn">↺ Default</button>
              <button class="btn primary" id="save-ebay-prompt-btn">Save</button>
              <span class="settings-msg" id="ebay-prompt-msg"></span>
            ` : '<span class="prompt-readonly-hint">🔒 Unlock to edit</span>'}
          </div>
        </div>
      </div>
    </div>`;

  // ── Appearance ─────────────────────────────────────────────────────────────
  const appearanceSection = `
    <div class="settings-section">
      <div class="settings-heading">Appearance</div>

      <div class="field-group">
        <label class="field-label">Theme</label>
        <div class="theme-toggle">
          <button class="theme-option${s.theme!=='light'?' active':''}" id="theme-dark-btn">
            <span class="theme-option-icon">🌙</span>
            <span class="theme-option-label">Dark</span>
          </button>
          <button class="theme-option${s.theme==='light'?' active':''}" id="theme-light-btn">
            <span class="theme-option-icon">☀️</span>
            <span class="theme-option-label">Light</span>
          </button>
        </div>
      </div>
    </div>`;

  // ── About ──────────────────────────────────────────────────────────────────
  const aboutSection = `
    <div class="settings-section about-section">

      <div class="about-hero">
        <div class="about-name">burrow<span>stock</span></div>
        <div class="about-tagline">Snap it. Burrow it. Find it. Sell it.</div>
        <div class="about-badges">
          <span class="about-badge">v0.1.0</span>
          <span class="about-badge">Tauri v2</span>
          <span class="about-badge">Rust</span>
          <span class="about-badge">MIT</span>
        </div>
      </div>

      <div class="about-features">
        <div class="about-feature">
          <div class="about-feature-icon">📷</div>
          <div>
            <div class="about-feature-title">AI-powered scanning</div>
            <div class="about-feature-desc">Photograph a pile — Gemini Vision identifies every item, assigns categories and eBay-standard conditions.</div>
          </div>
        </div>
        <div class="about-feature">
          <div class="about-feature-icon">🔍</div>
          <div>
            <div class="about-feature-title">Instant search</div>
            <div class="about-feature-desc">SQLite FTS5 full-text search across your entire catalog. Finds anything in milliseconds.</div>
          </div>
        </div>
        <div class="about-feature">
          <div class="about-feature-icon">🏷️</div>
          <div>
            <div class="about-feature-title">Listing generator</div>
            <div class="about-feature-desc">AI writes complete listings for eBay, Facebook Marketplace, Gumtree, and OLX. Copy and paste anywhere.</div>
          </div>
        </div>
        <div class="about-feature">
          <div class="about-feature-icon">🔒</div>
          <div>
            <div class="about-feature-title">100% local</div>
            <div class="about-feature-desc">Your photos, catalog, and API key never leave your machine. No accounts, no cloud, no subscription.</div>
          </div>
        </div>
        <div class="about-feature">
          <div class="about-feature-icon">⚡</div>
          <div>
            <div class="about-feature-title">Built with Tauri + Rust</div>
            <div class="about-feature-desc">Sub-second startup. No Electron, no Node.js, no npm. Your system WebView, a Rust backend, SQLite.</div>
          </div>
        </div>
        <div class="about-feature">
          <div class="about-feature-icon">🔑</div>
          <div>
            <div class="about-feature-title">BYOK — free tier</div>
            <div class="about-feature-desc">Bring your own Gemini API key. Free tier covers 1,500 scans/day. No credit card needed.</div>
          </div>
        </div>
      </div>

      <div class="about-links">
        <a href="https://github.com/block0xhash/burrowstock" target="_blank" class="about-link">
          <span>⌥</span> GitHub
        </a>
        <a href="https://aistudio.google.com/apikey" target="_blank" class="about-link">
          <span>🔑</span> Get Gemini API key
        </a>
        <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" class="about-link">
          <span>💰</span> API pricing
        </a>
      </div>

      <div class="about-roadmap">
        <div class="about-roadmap-title">Roadmap</div>
        <div class="about-roadmap-item done">✅ v1 — Scan, catalog, search, generate listings</div>
        <div class="about-roadmap-item">🔜 v2 — One-click post to eBay &amp; Facebook Marketplace</div>
        <div class="about-roadmap-item">🔜 v3 — Mobile companion app for item photos</div>
      </div>

      <div class="about-footer">
        Built by <strong>block0xhash</strong> · MIT License · Data stored at <code>~/.config/burrowstock/</code>
      </div>
    </div>`;

  const sections = { api: apiSection, prompt: promptSection, about: aboutSection };
  const navItems = [
    { id: 'api',        label: '🔑 API & Model' },
    { id: 'prompt',     label: '🤖 AI Prompts' },

    { id: 'about',      label: 'ℹ️ About' },
  ];

  return `
    <div class="settings-layout">
      <nav class="settings-nav">
        ${navItems.map(n => `
          <div class="settings-nav-item${state.settingsTab===n.id?' active':''}" data-settings-tab="${n.id}">
            ${n.label}
          </div>`).join('')}
      </nav>
      <div class="settings-content">
        ${sections[state.settingsTab] || ''}
      </div>
    </div>`;
}


// ── UI helpers ────────────────────────────────────────────────────────────────
// ── UI helpers ──────────────────────────────────────────────────────────────────
function showConfirmModal(message, onConfirm) {
  // Remove any existing modal first
  document.querySelector('.confirm-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-raised);border:1px solid var(--border);border-radius:12px;padding:24px;min-width:300px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.6)';

  const msg = document.createElement('div');
  msg.innerHTML = message;
  msg.style.cssText = 'font-size:14px;color:var(--text);margin-bottom:20px;line-height:1.6';

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn danger';
  deleteBtn.textContent = 'Delete';

  footer.appendChild(cancelBtn);
  footer.appendChild(deleteBtn);
  box.appendChild(msg);
  box.appendChild(footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  cancelBtn.addEventListener('click', close);
  deleteBtn.addEventListener('click', () => { close(); onConfirm(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showInlineRename(id, currentName) {
  const row = document.querySelector(`[data-item-id="${id}"]`);
  if (!row) return;
  const nameCell = row.querySelector('.item-name');
  if (!nameCell) return;
  const oldText = nameCell.textContent;
  nameCell.innerHTML = `
    <input class="inline-input item-rename-field" value="${currentName.replace(/"/g,'&quot;')}"
      style="width:100%;font-size:13px" autofocus>`;
  const inp = nameCell.querySelector('.item-rename-field');
  inp?.focus(); inp?.select();
  const save = async () => {
    const name = inp?.value?.trim();
    if (name && name !== currentName) {
      await window.bs.renameItem(parseInt(id), name);
      await refreshData(); render();
    } else {
      nameCell.innerHTML = `<div class="item-name">${oldText}</div>`;
    }
  };
  inp?.addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') { nameCell.innerHTML = `<div class="item-name">${oldText}</div>`; }
  });
  inp?.addEventListener('blur', save);
}

// ── Events ────────────────────────────────────────────────────────────────────
// ── Events ────────────────────────────────────────────────────────────────────────
function bindEvents() {
  // ── Navigation ──────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tab]').forEach(el =>
    el.addEventListener('click', () => {
      state.tab   = el.dataset.tab;
      state.query = '';
      if (!['locations','items','search'].includes(state.tab)) state.selectedItem = null;
      render();
    })
  );

  // ── Theme toggle ─────────────────────────────────────────────────────────────
  // theme-toggle handled by master delegation (uses global setTheme)

  // ── Location filter ───────────────────────────────────────────────────────────
  document.querySelectorAll('[data-loc]').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.closest('.row-actions')) return;
      if (e.target.closest('.loc-row-actions')) return;
      if (e.target.closest('.loc-renaming-row')) return;
      if (state.renamingLocation) return;
      state.locFilter = el.dataset.loc;
      state.selectedItem = null;
      applyFilter();
      render();
    })
  );

  // ── Add location — inline form ────────────────────────────────────────────────
  document.getElementById('add-location-btn')?.addEventListener('click', () => {
    state.showAddLocation = true; render();
    setTimeout(() => document.getElementById('new-loc-input')?.focus(), 50);
  });

  document.getElementById('confirm-add-loc-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('new-loc-input')?.value?.trim();
    if (!id) return;
    await window.bs.upsertLocation(id);
    state.showAddLocation = false;
    state.locFilter = id;
    await refreshData(); render();
  });

  document.getElementById('cancel-add-loc-btn')?.addEventListener('click', () => {
    state.showAddLocation = false; render();
  });

  document.getElementById('new-loc-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('confirm-add-loc-btn')?.click();
    if (e.key === 'Escape') document.getElementById('cancel-add-loc-btn')?.click();
  });

  // ── Add item — inline form ────────────────────────────────────────────────────
  document.getElementById('add-item-btn')?.addEventListener('click', () => {
    state.showAddItem = !state.showAddItem; render();
    if (state.showAddItem)
      setTimeout(() => document.getElementById('new-item-name')?.focus(), 50);
  });

  document.getElementById('confirm-add-item-btn')?.addEventListener('click', async () => {
    const name       = document.getElementById('new-item-name')?.value?.trim();
    const condText   = document.getElementById('add-cond-text');
    const condition  = condText?.dataset?.value || 'unknown';
    const notes      = document.getElementById('new-item-notes')?.value?.trim() || '';
    const locationId = state.locFilter;
    if (!name || !locationId || locationId === 'all') {
      document.getElementById('new-item-name')?.focus();
      return;
    }
    await window.bs.addItem({ locationId, name, condition, notes, category: 'other' });
    state.showAddItem = false;
    await refreshData();
    render();
  });

  document.getElementById('cancel-add-item-btn')?.addEventListener('click', () => {
    state.showAddItem = false; render();
  });

  document.getElementById('new-item-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('confirm-add-item-btn')?.click();
    if (e.key === 'Escape') document.getElementById('cancel-add-item-btn')?.click();
  });

  // ── Location CRUD ─────────────────────────────────────────────────────────────

  // Rename — show inline input
  document.querySelectorAll('.loc-rename-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      state.renamingLocation = btn.dataset.id;
      render();
      setTimeout(() => {
        const inp = document.getElementById(`loc-rename-input-${btn.dataset.id}`);
        if (inp) { inp.focus(); inp.select(); }
      }, 30);
    });
  });

  // Rename — read value BEFORE render(), then save
  const doRename = async (oldId) => {
    // Read the input value FIRST before any render() call clears the DOM
    const inp   = document.getElementById(`loc-rename-input-${oldId}`);
    const newId = inp?.value?.trim();

    // Clear renaming state and re-render
    state.renamingLocation = null;

    if (!newId || newId === oldId) { render(); return; }

    // Optimistically update locFilter before async call
    if (state.locFilter === oldId) state.locFilter = newId;

    render(); // render with new locFilter immediately

    try {
      await window.bs.renameLocation(oldId, newId);
      await refreshData();
      showToast(`Renamed to "${newId}"`, 'success');
      render();
    } catch(err) {
      if (state.locFilter === newId) state.locFilter = oldId;
      const msg = String(err);
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        showToast(`"${newId}" already exists — choose a different name`, 'error');
      } else {
        showToast(msg, 'error');
      }
      render();
    }
  };

  document.querySelectorAll('.loc-rename-confirm').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      doRename(btn.dataset.id);
    });
  });
  document.querySelectorAll('.loc-rename-cancel').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.renamingLocation = null;
      render();
    });
  });
  document.querySelectorAll('.loc-rename-input').forEach(inp => {
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter')  { e.preventDefault(); doRename(inp.dataset.oldId); }
      if (e.key === 'Escape') { state.renamingLocation = null; render(); }
    });
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('mousedown', e => e.stopPropagation());
  });

  // Delete — confirmation modal
  document.querySelectorAll('.loc-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
        const loc   = state.locations.find(l => l.id === btn.dataset.id);
      const count = loc?.item_count || 0;
      showConfirmModal(
        count > 0
          ? `Delete "<strong>${btn.dataset.id}</strong>" and its ${count} item${count!==1?'s':''}?<br><span style="color:var(--red);font-size:12px">This cannot be undone.</span>`
          : `Delete location "<strong>${btn.dataset.id}</strong>"?`,
        async () => {
                try {
            await window.bs.deleteLocation(btn.dataset.id);
                    if (state.locFilter === btn.dataset.id) state.locFilter = 'all';
            if (state.selectedItem?.location_id === btn.dataset.id) state.selectedItem = null;
            await refreshData();
            showToast('Location deleted', 'success');
            render();
          } catch(err) { console.error('[delete] error:', err); showToast(String(err), 'error'); }
        }
      );
    });
  });

  // ── Item CRUD ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.item-rename-btn').forEach(el =>
    el.addEventListener('click', async e => {
      e.stopPropagation();
      showInlineRename(el.dataset.id, el.dataset.name);
    })
  );

  document.querySelectorAll('.item-delete-btn').forEach(el =>
    el.addEventListener('click', async e => {
      e.stopPropagation();
      showConfirmModal('Delete this item?', async () => {
        if (state.selectedItem?.id == el.dataset.id) state.selectedItem = null;
        await window.bs.deleteItem(parseInt(el.dataset.id));
        await refreshData(); render();
      });
    })
  );

  // ── Item row click → detail panel ─────────────────────────────────────────────
  // Use event delegation for item rows — works after every render
  document.addEventListener('click', async e => {
    const row = e.target.closest('.item-row[data-item-id]');
    if (!row) return;
    if (e.target.closest('.row-actions')) return;
    if (e.target.closest('.loc-row-actions')) return;
    if (e.target.closest('[data-sell-id]')) return;
    const item = await window.bs.getItem(parseInt(row.dataset.itemId));
    state.selectedItem  = item;
    state.detailTab     = 'details';
    state.listing       = null;
    state.listingPhotos = [];
    state.listingPrice  = '';
    render();
  });

  // ── Detail panel ──────────────────────────────────────────────────────────────
  document.getElementById('detail-close-btn')?.addEventListener('click', () => {
    state.selectedItem  = null;
    state.listing       = null;
    state.listingPhotos = [];
    render();
  });

  // Detail tabs


  // Detail custom condition select
  document.getElementById('detail-cond-trigger')?.addEventListener('click', e => {
    e.stopPropagation();
    const dd = document.getElementById('detail-cond-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('[data-detail-cond]').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const val = opt.dataset.detailCond;
      const inp = document.getElementById('detail-condition');
      const txt = document.getElementById('detail-cond-text');
      const dd  = document.getElementById('detail-cond-dropdown');
      if (inp) inp.value = val;
      if (txt) { txt.textContent = CONDITION_LABELS[val]; txt.className = condClass(val); }
      if (dd)  dd.style.display = 'none';
      document.querySelectorAll('[data-detail-cond]').forEach(o => o.classList.toggle('selected', o === opt));
    });
  });

  // Detail custom location select
  document.getElementById('detail-loc-trigger')?.addEventListener('click', e => {
    e.stopPropagation();
    const dd = document.getElementById('detail-loc-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('[data-detail-loc]').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const val = opt.dataset.detailLoc;
      const inp = document.getElementById('detail-location');
      const txt = document.getElementById('detail-loc-text');
      const dd  = document.getElementById('detail-loc-dropdown');
      if (inp) inp.value = val;
      if (txt) txt.textContent = val;
      if (dd)  dd.style.display = 'none';
      document.querySelectorAll('[data-detail-loc]').forEach(o => o.classList.toggle('selected', o === opt));
    });
  });

  // Add item condition dropdown
  document.getElementById('add-cond-trigger')?.addEventListener('click', e => {
    e.stopPropagation();
    const dd = document.getElementById('add-cond-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('[data-add-cond]').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const val = opt.dataset.addCond;
      const txt = document.getElementById('add-cond-text');
      const dd  = document.getElementById('add-cond-dropdown');
      if (txt) { txt.textContent = CONDITION_LABELS[val]; txt.className = `cond-trigger-text ${condClass(val)}`; txt.dataset.value = val; }
      if (dd)  dd.style.display = 'none';
    });
  });

  document.getElementById('detail-main-photo')?.addEventListener('click', async () => {
    const photos = await window.bs.openItemPhotos();
    if (!photos?.length) return;
    state.listingPhotos = [...state.listingPhotos, ...photos];
    render();
  });

  document.querySelectorAll('.detail-photo-thumb').forEach(el =>
    el.addEventListener('click', () => {
      // Swap clicked thumb to front
      const idx = parseInt(el.dataset.photoIdx);
      const moved = state.listingPhotos.splice(idx, 1)[0];
      state.listingPhotos.unshift(moved);
      render();
    })
  );

  // Detail panel save — delegated so works after every render
  document.addEventListener('click', async e => {
    if (!e.target.closest || e.target.id !== 'save-detail-btn') return;
    if (!state.selectedItem) return;
    const btn       = e.target;

    const name      = document.getElementById('detail-name')?.value?.trim();
    const condition = document.getElementById('detail-condition')?.value;
    const notes     = document.getElementById('detail-notes')?.value?.trim();
    const newLoc    = document.getElementById('detail-location')?.value;

    if (!name) { showToast('Item name cannot be empty', 'error'); return; }
    btn.innerHTML = '<span class="spin">⟳</span> Saving…';
    btn.disabled = true;
    btn.style.opacity = '0.7';

    // Show saving banner in detail header
    const header = document.querySelector('.detail-header');
    const banner = document.createElement('div');
    banner.id = 'saving-banner';
    banner.style.cssText = 'background:var(--accent);color:#fff;font-size:11px;font-weight:600;text-align:center;padding:4px;letter-spacing:0.05em;animation:pulse 1s infinite';
    banner.textContent = 'Saving changes…';
    if (header) header.after(banner);

    try {
      if (newLoc && newLoc !== state.selectedItem.location_id)
        await window.bs.moveItem(state.selectedItem.id, newLoc);
      await window.bs.updateItem(state.selectedItem.id, { name, condition, notes });
      // Reload just this one item — no full refresh needed
      state.selectedItem = await window.bs.getItem(state.selectedItem.id);
      updateItemInState(state.selectedItem);
      document.getElementById('saving-banner')?.remove();
      showToast('✓ Changes saved', 'success');
      render();
    } catch(err) {
      document.getElementById('saving-banner')?.remove();
      showToast('Save failed: ' + String(err), 'error');
      btn.innerHTML = 'Save changes'; btn.disabled = false; btn.style.opacity = '';
    }
  });

  // save-detail-btn handled via master delegation below

  // ── Master click delegation ───────────────────────────────────────────────────
  document.addEventListener('click', async e => {
    // Settings tab navigation
    const stab = e.target.closest('[data-settings-tab]');
    if (stab) { state.settingsTab = stab.dataset.settingsTab; render(); return; }

    // Theme toggle
    if (e.target.id === 'theme-toggle' || e.target.closest('#theme-toggle')) {
      await setTheme(state.settings.theme === 'light' ? 'dark' : 'light');
      return;
    }

    // Model custom dropdown — trigger opens/closes
    if (e.target.closest('#model-trigger')) {
      const dd = document.getElementById('model-dropdown');
      const tr = document.getElementById('model-trigger');
      if (!dd) return;
      const open = dd.style.display !== 'none';
      dd.style.display = open ? 'none' : 'block';
      tr?.classList.toggle('open', !open);
      return;
    }

    // Model custom dropdown — option selected
    const modelOpt = e.target.closest('#model-dropdown .custom-select-option');
    if (modelOpt) {
      const val = modelOpt.dataset.value;
      const inp = document.getElementById('model-input');
      const txt = document.getElementById('model-trigger-text');
      const dd  = document.getElementById('model-dropdown');
      const tr  = document.getElementById('model-trigger');
      if (inp) inp.value = val;
      if (txt) txt.textContent = val;
      if (dd)  dd.style.display = 'none';
      tr?.classList.remove('open');
      document.querySelectorAll('#model-dropdown .custom-select-option').forEach(o =>
        o.classList.toggle('selected', o === modelOpt)
      );
      return;
    }

    // Close model dropdown when clicking outside
    if (!e.target.closest('#model-select-wrap')) {
      const dd = document.getElementById('model-dropdown');
      const tr = document.getElementById('model-trigger');
      if (dd) dd.style.display = 'none';
      tr?.classList.remove('open');
    }

    // Save API settings
    if (e.target.id === 'save-settings-btn') {
      const key   = document.getElementById('gemini-key')?.value?.trim();
      const model = document.getElementById('model-input')?.value?.trim() || 'gemini-3.5-flash';
      state.settings.geminiKey   = key;
      state.settings.geminiModel = model;
      await window.bs.saveSettings(state.settings);
      showToast('✓ Settings saved', 'success');
      render();
      return;
    }

    // Load models
    if (e.target.id === 'fetch-models-btn') {
      const key = document.getElementById('gemini-key')?.value?.trim();
      if (!key) { showToast('Enter your API key first', 'error'); return; }
      e.target.textContent = 'Loading…';
      e.target.disabled    = true;
      try {
        state.geminiModels     = await window.bs.listModels(key);
        state.settings.geminiKey = key;
        showToast(`✓ ${state.geminiModels.length} models available`, 'success');
        render();
      } catch(err) {
        showToast('Failed to load models: ' + err, 'error');
        e.target.textContent = '⟳ Load models';
        e.target.disabled    = false;
      }
      return;
    }

    // Detail tabs
    if (e.target.id === 'detail-tab-details') { state.detailTab = 'details'; render(); return; }
    if (e.target.id === 'detail-tab-sell')    { state.detailTab = 'sell';    render(); return; }
    if (e.target.id === 'detail-sell-btn')    { state.detailTab = 'sell';    render(); return; }

    // Platform selector
    const pbtn = e.target.closest('[data-platform]');
    if (pbtn) { state.listingPlatform = pbtn.dataset.platform; render(); return; }

    // Prompt lock toggle
    if (e.target.id === 'toggle-prompt-lock-btn') {
      if (state.promptUnlocked) {
        state.promptUnlocked = false; render();
      } else {
        showConfirmModal(
          '⚠️ <strong>Superuser mode</strong><br><br>These prompts control how Burrowstock identifies items. Editing incorrectly will break scanning.<br><br>Only proceed if you know what you are changing.',
          () => { state.promptUnlocked = true; render(); }
        );
      }
      return;
    }

    // Scan prompt save/reset
    if (e.target.id === 'save-scan-prompt-btn') {
      const prompt = document.getElementById('scan-prompt-input')?.value?.trim();
      state.settings.scanPrompt = (prompt && prompt !== state.defaultScanPrompt) ? prompt : null;
      await window.bs.saveSettings(state.settings);
      showToast('✓ Scan prompt saved', 'success');
      render();
      return;
    }
    if (e.target.id === 'reset-scan-prompt-btn') {
      const el = document.getElementById('scan-prompt-input');
      if (el) el.value = state.defaultScanPrompt;
      showToast('Default prompt loaded — click Save to apply', 'success');
      return;
    }

    // eBay prompt save/reset
    if (e.target.id === 'save-ebay-prompt-btn') {
      const prompt = document.getElementById('ebay-prompt-input')?.value?.trim();
      state.settings.ebayPrompt = (prompt && prompt !== state.defaultListingPrompt) ? prompt : null;
      await window.bs.saveSettings(state.settings);
      showToast('✓ eBay prompt saved', 'success');
      render();
      return;
    }
    if (e.target.id === 'reset-ebay-prompt-btn') {
      const el = document.getElementById('ebay-prompt-input');
      if (el) el.value = state.defaultListingPrompt;
      showToast('Default prompt loaded — click Save to apply', 'success');
      return;
    }

    // Copy listing
    if (e.target.id === 'copy-listing-btn') {
      const l       = state.listing;
      const price   = document.getElementById('listing-price-input')?.value || l?.price_low;
      const platform = state.listingPlatform || 'ebay';
      if (!l) return;
      const text = platform === 'ebay'
        ? `TITLE: ${l.title}

CONDITION: ${l.condition}
CATEGORY: ${l.category}
PRICE: $${price}

DESCRIPTION:
${l.description}

SEARCH TERMS: ${(l.keywords||[]).join(', ')}`
        : `${l.title}

Condition: ${l.condition}
Price: $${price}

${l.description}

Keywords: ${(l.keywords||[]).join(', ')}`;
      navigator.clipboard.writeText(text);
      showToast('✓ Listing copied to clipboard', 'success');
      return;
    }

    if (e.target.id === 'copy-title-btn') {
      if (state.listing?.title) {
        navigator.clipboard.writeText(state.listing.title);
        showToast('✓ Title copied', 'success');
      }
      return;
    }
  });

  // ── Detail resize ─────────────────────────────────────────────────────────────
  initDetailResizer();

  // ── Sell panel ────────────────────────────────────────────────────────────────
  document.getElementById('add-listing-photos-btn')?.addEventListener('click', async () => {
    const photos = await window.bs.openItemPhotos();
    if (!photos?.length) return;
    state.listingPhotos = [...state.listingPhotos, ...photos].slice(0, 5);
    render();
  });

  document.getElementById('generate-listing-btn')?.addEventListener('click', generateListing);
  document.getElementById('regenerate-listing-btn')?.addEventListener('click', generateListing);


  // Copy title
  document.getElementById('copy-title-btn')?.addEventListener('click', () => {
    const title = state.listing?.title;
    if (!title) return;
    navigator.clipboard.writeText(title);
    showToast('✓ Title copied', 'success');
  });

  // Copy full listing
  document.getElementById('copy-listing-btn')?.addEventListener('click', () => {
    const l     = state.listing;
    const price = document.getElementById('listing-price-input')?.value || l?.price_low;
    const platform = state.listingPlatform || 'ebay';
    if (!l) return;

    let text = '';
    if (platform === 'facebook' || platform === 'gumtree' || platform === 'olx') {
      // Casual format for FB/Gumtree/OLX
      text = `${l.title}

Condition: ${l.condition}
Price: $${price}

${l.description}

Keywords: ${(l.keywords||[]).join(', ')}`;
    } else {
      // eBay format — title separate
      text = `TITLE: ${l.title}

CONDITION: ${l.condition}
CATEGORY: ${l.category}
PRICE: $${price}

DESCRIPTION:
${l.description}

SEARCH TERMS: ${(l.keywords||[]).join(', ')}`;
    }

    navigator.clipboard.writeText(text);
    showToast('✓ Listing copied to clipboard', 'success');
  });

  // Price input — update state
  document.addEventListener('input', e => {
    if (e.target.id === 'listing-price-input') {
      state.listingPrice = e.target.value;
    }
  });

  document.getElementById('listing-price-input')?.addEventListener('input', e => {
    state.listingPrice = e.target.value;
  });

  // ── Location scan photo expand ────────────────────────────────────────────────
  // Click thumb to pop out full image modal
  document.getElementById('loc-scan-thumb-wrap')?.addEventListener('click', () => {
    const img = document.querySelector('#loc-scan-thumb-wrap img');
    if (!img) return;

    const modal = document.createElement('div');
    modal.className = 'photo-modal-overlay';
    modal.innerHTML = `
      <div class="photo-modal">
        <div class="photo-modal-header">
          <span>📷 Scanned photo</span>
          <span class="photo-modal-hint">Scroll to zoom · drag to pan · double-click to reset</span>
          <button class="photo-modal-close">✕</button>
        </div>
        <div class="photo-modal-viewport" id="photo-viewport">
          <img src="${img.src}" alt="Scanned photo" class="photo-modal-img" id="photo-modal-img" draggable="false">
        </div>
      </div>`;

    document.body.appendChild(modal);

    // ── Zoom + pan ────────────────────────────────────────────────────────────
    const viewport = modal.querySelector('#photo-viewport');
    const image    = modal.querySelector('#photo-modal-img');
    let scale = 1, tx = 0, ty = 0;
    let dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

    const applyTransform = () => {
      image.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    viewport.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.min(8, Math.max(0.5, scale * delta));
      applyTransform();
    }, { passive: false });

    viewport.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      startTx = tx; startTy = ty;
      viewport.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      tx = startTx + (e.clientX - startX);
      ty = startTy + (e.clientY - startY);
      applyTransform();
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
      viewport.style.cursor = 'grab';
    });

    viewport.addEventListener('dblclick', () => {
      scale = 1; tx = 0; ty = 0;
      applyTransform();
    });

    const close = () => { modal.remove(); };
    modal.querySelector('.photo-modal-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  });

  // ── Catalog ───────────────────────────────────────────────────────────────────
  document.getElementById('catalog-search')?.addEventListener('input', e => {
    state.query = e.target.value;
    applyFilter();
    render();
  });

  // Search panel — SQL FTS5 backend, update results without touching the input
  let searchDebounce = null;
  document.addEventListener('input', e => {
    if (e.target.id !== 'search-input') return;
    const q = e.target.value;
    state.query = q;

    // Show/hide clear button
    const existingClear = document.getElementById('search-clear-btn');
    if (!existingClear && q) {
      const wrap = document.querySelector('.search-input-wrap');
      if (wrap) {
        const btn = document.createElement('button');
        btn.id = 'search-clear-btn'; btn.className = 'search-clear-btn'; btn.textContent = '✕';
        wrap.appendChild(btn);
      }
    } else if (existingClear && !q) { existingClear.remove(); }

    const results = document.getElementById('search-results');
    const meta    = document.getElementById('search-meta');

    if (!q) {
      if (meta) meta.textContent = '';
      if (results) results.innerHTML = `
        <div class="search-empty-state">
          <div class="search-empty-icon">🔍</div>
          <div class="search-empty-title">Search your catalog</div>
          <div class="search-empty-sub">Find any item across all locations instantly</div>
          <div class="search-tips">
            <div class="search-tip-item">Search by <strong>item name</strong> — "Dell laptop"</div>
            <div class="search-tip-item">Search by <strong>category</strong> — "cable" or "keyboard"</div>
            <div class="search-tip-item">Search by <strong>location</strong> — "Shelf A"</div>
            <div class="search-tip-item">Search by <strong>notes</strong> — "cracked screen"</div>
          </div>
        </div>`;
      return;
    }

    // Show loading state
    if (results) results.innerHTML = '<div class="search-loading">Searching…</div>';

    // Debounce — wait 150ms after last keystroke before hitting SQLite
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      try {
        const hits = await window.bs.search(q);
        if (meta) meta.textContent = `${hits.length} result${hits.length!==1?'s':''} for "${q}"`;
        if (!results) return;
        if (!hits.length) {
          results.innerHTML = `
            <div class="search-empty-state">
              <div class="search-empty-icon">🤷</div>
              <div class="search-empty-title">Nothing found for "${q}"</div>
              <div class="search-empty-sub">Try a different spelling or a shorter word</div>
            </div>`;
          return;
        }
        results.innerHTML = buildSearchResults(hits, q);

        // Wire result interactions
        results.querySelectorAll('.item-row[data-item-id]').forEach(row =>
          row.addEventListener('click', async () => {
            const item = await window.bs.getItem(parseInt(row.dataset.itemId));
            state.selectedItem = item; state.detailTab = 'details'; render();
          })
        );
        results.querySelectorAll('[data-sell-id]').forEach(btn =>
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            const item = await window.bs.getItem(parseInt(btn.dataset.sellId));
            state.selectedItem = item; state.detailTab = 'sell';
            state.listing = null; state.listingPhotos = []; render();
          })
        );
        results.querySelectorAll('[data-loc-group]').forEach(el =>
          el.addEventListener('click', () => {
            const id  = el.dataset.locGroup;
            const tbl = el.nextElementSibling;
            const open = tbl?.style.display !== 'none';
            if (tbl) tbl.style.display = open ? 'none' : '';
            el.querySelector('.expand-arrow').textContent = open ? '▶' : '▼';
          })
        );
      } catch(err) {
        console.error('FTS search error:', err);
        if (results) results.innerHTML = `<div class="search-empty-state"><div class="search-empty-sub">Search error: ${err}</div></div>`;
      }
    }, 150);
  });
  document.addEventListener('click', e => {
    if (e.target.id === 'search-clear-btn') {
      state.query = '';
      render();
      setTimeout(() => document.getElementById('search-input')?.focus(), 30);
    }
    if (e.target.dataset?.locGroup) {
      const id = e.target.dataset.locGroup;
      state.search.expanded[id] = state.search.expanded[id] === false ? true : false;
      render();
    }
  });

  document.getElementById('items-search')?.addEventListener('input', e => {
    state.query = e.target.value;
    render();
  });

  document.getElementById('scan-btn')?.addEventListener('click', () => { state.tab = 'scan'; render(); });
  document.getElementById('scan-btn-empty')?.addEventListener('click', () => { state.tab = 'scan'; render(); });
  document.getElementById('go-catalog-btn')?.addEventListener('click', () => {
    state.tab = 'locations'; resetScan(); render();
  });

  // ── Scan flow ──────────────────────────────────────────────────────────────────
  document.getElementById('choose-photo-btn')?.addEventListener('click', choosePhoto);
  document.getElementById('drop-zone')?.addEventListener('click', choosePhoto);
  document.getElementById('do-scan-btn')?.addEventListener('click', doScan);
  document.getElementById('clear-photo-btn')?.addEventListener('click', resetScan);
  document.getElementById('cancel-scan-btn')?.addEventListener('click', resetScan);
  document.getElementById('scan-another-btn')?.addEventListener('click', resetScan);
  document.getElementById('save-scan-btn')?.addEventListener('click', saveScan);

  // Inline scan result edits
  document.querySelectorAll('[data-field="name"]').forEach(el =>
    el.addEventListener('input', () => { state.scan.results[el.dataset.idx].name = el.value; })
  );

  // Custom condition dropdowns in scan results
  document.querySelectorAll('.cond-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      // Close all other open dropdowns
      document.querySelectorAll('.cond-dropdown').forEach(d => {
        if (d !== trigger.nextElementSibling) d.style.display = 'none';
      });
      const dropdown = trigger.nextElementSibling;
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });
  });

  document.querySelectorAll('.cond-option').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(opt.dataset.idx);
      const val = opt.dataset.value;
      state.scan.results[idx].condition = val;
      // Update trigger text and close
      const wrap    = opt.closest('.cond-custom-select');
      const text    = wrap.querySelector('.cond-trigger-text');
      const dropdown = wrap.querySelector('.cond-dropdown');
      text.textContent = CONDITION_LABELS[val] || val;
      text.className   = `cond-trigger-text ${condClass(val)}`;
      dropdown.style.display = 'none';
      // Update selected state
      wrap.querySelectorAll('.cond-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // Close condition dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.cond-dropdown').forEach(d => d.style.display = 'none');
  });
  document.querySelectorAll('[data-field="location"]').forEach(el =>
    el.addEventListener('input', () => { state.scan.results[el.dataset.idx].location = el.value; })
  );
  // Checkbox keyboard navigation
  const checkboxes = Array.from(document.querySelectorAll('.scan-check'));
  checkboxes.forEach((cb, pos) => {
    cb.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        for (let i = pos + 1; i < checkboxes.length; i++) {
          const idx = parseInt(checkboxes[i].dataset.idx);
          if (!state.scan.saved?.[idx]) { checkboxes[i].focus(); break; }
        }
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        for (let i = pos - 1; i >= 0; i--) {
          const idx = parseInt(checkboxes[i].dataset.idx);
          if (!state.scan.saved?.[idx]) { checkboxes[i].focus(); break; }
        }
      }
      if (e.key === 'ArrowRight' || e.key === 'Tab') {
        // Move focus to the location input on same row
        e.preventDefault();
        const row = cb.closest('tr');
        row?.querySelector('.loc-input-inline')?.focus();
      }
    });
  });

  // Individual row save buttons
  document.querySelectorAll('.scan-save-row-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      const i    = parseInt(btn.dataset.idx);
      const item = state.scan.results[i];
      if (!item?.location?.trim()) return;
      btn.textContent = '…';
      btn.disabled    = true;
      try {
        await window.bs.saveScan({
          imagePath:  state.scan.imagePath,
          locationId: item.location.trim(),
          items:      [{ ...item, confidence: confidenceToInt(item.confidence) }],
        });
        state.scan.saved[i] = true;
        addLog(`✓ Saved: ${item.name} → ${item.location}`, 'success');
        await refreshItems(); // lightweight — no location reload needed
        render();
      } catch(e) {
        addLog('✗ ' + e.message, 'error');
        btn.textContent = 'Save';
        btn.disabled    = false;
      }
    })
  );

  // Unpack buttons — clear saved state so item can be re-assigned
  document.querySelectorAll('.scan-unpack-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      delete state.scan.saved[i];
      render();
    })
  );

  // Auto-enable save button + keyboard navigation on location inputs
  const locInputs = Array.from(document.querySelectorAll('.loc-input-inline'));

  locInputs.forEach((el, pos) => {
    el.addEventListener('input', () => {
      state.scan.results[el.dataset.idx].location = el.value;
      const row     = el.closest('tr');
      const saveBtn = row?.querySelector('.scan-save-row-btn');
      if (saveBtn) {
        saveBtn.disabled = !el.value.trim();
        saveBtn.title    = el.value.trim() ? 'Save this item' : 'Assign a location first';
      }
    });

    el.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        // Move to next location input, skipping saved rows
        for (let next = pos + 1; next < locInputs.length; next++) {
          const nextEl = locInputs[next];
          const idx    = parseInt(nextEl.dataset.idx);
          if (!state.scan.saved?.[idx]) {
            e.preventDefault();
            nextEl.focus();
            nextEl.select();
            break;
          }
        }
      }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        // Move to previous location input
        for (let prev = pos - 1; prev >= 0; prev--) {
          const prevEl = locInputs[prev];
          const idx    = parseInt(prevEl.dataset.idx);
          if (!state.scan.saved?.[idx]) {
            e.preventDefault();
            prevEl.focus();
            prevEl.select();
            break;
          }
        }
      }
      if (e.key === 'Enter') {
        // Enter saves this row if location is set
        const idx = parseInt(el.dataset.idx);
        if (el.value.trim() && !state.scan.saved?.[idx]) {
          const saveBtn = el.closest('tr')?.querySelector('.scan-save-row-btn');
          if (saveBtn && !saveBtn.disabled) saveBtn.click();
        }
      }
    });
  });

  // Scan column resize
  initScanResizers();

  // Log toggle
  document.getElementById('log-toggle')?.addEventListener('click', () => {
    state.scan.logOpen = !state.scan.logOpen;
    const content = document.getElementById('log-content');
    if (content) content.style.display = state.scan.logOpen ? '' : 'none';
    const arrow = document.querySelector('#log-toggle span');
    if (arrow) arrow.textContent = state.scan.logOpen ? '▼' : '▶';
  });

  // ── Items panel — flat list of all items, no sidebar ─────────────────────────
function showMsg(text, type = 'ok') {
  const el = document.getElementById('settings-msg');
  if (!el) return;
  el.textContent  = text;
  el.className    = `settings-msg ${type}`;
}

// ── Resizers ──────────────────────────────────────────────────────────────────
function initScanResizers() {
  // Column divider
  const divider = document.getElementById('scan-col-divider');
  const imgCol  = document.getElementById('scan-img-col');
  if (divider && imgCol) {
    let drag = false, startX = 0, startW = 0;
    divider.addEventListener('mousedown', e => {
      drag = true; startX = e.clientX; startW = imgCol.offsetWidth;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      imgCol.style.width = Math.max(120, Math.min(800, startW + e.clientX - startX)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false; document.body.style.cursor = '';
      divider.classList.remove('dragging');
    });
  }

  // Log strip height
  const handle = document.getElementById('log-resize-handle');
  const strip  = document.getElementById('log-strip');
  if (handle && strip) {
    let drag = false, startY = 0, startH = 0;
    handle.addEventListener('mousedown', e => {
      drag = true; startY = e.clientY; startH = strip.offsetHeight;
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      strip.style.height = Math.max(30, Math.min(400, startH - (e.clientY - startY))) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = false; document.body.style.cursor = '';
    });
  }
}

function initDetailResizer() {
  const handle = document.getElementById('detail-resize-handle');
  const panel  = document.querySelector('.detail-panel');
  if (!handle || !panel) return;
  let drag = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    drag = true; startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    panel.style.width = Math.max(300, Math.min(700, startW - (e.clientX - startX))) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false; document.body.style.cursor = '';
    handle.classList.remove('dragging');
  });
}

// ── Scan flow ─────────────────────────────────────────────────────────────────
function addLog(text, type = 'info') {
  state.scan.logs.push({ text, type });
  const el = document.getElementById('log-content');
  if (el) el.innerHTML = state.scan.logs
    .map(l => `<span class="log-line ${l.type}">${l.text}</span>`).join('');
}

function resetScan() {
  state.scan = { phase:'idle', imagePath:null, imageUrl:null, results:[], logs:[], logOpen:true, saved:{} };
  render();
}

async function choosePhoto() {
  const result = await window.bs.openImage();
  if (!result) return;
  // Normalise path separators for Windows (backslash → forward slash)
  const normPath = result.path.replace(/\\/g, '/');
  const normUrl  = `bslocal://localhost${normPath.startsWith('/') ? normPath : '/' + normPath}`;
  state.scan = { ...state.scan, phase:'photo', imagePath: result.path, imageUrl: normUrl };
  render();
}

async function doScan() {
  if (!state.scan.imagePath) return;
  state.scan.phase = 'scanning';
  state.scan.logs  = [];
  render();

  const model    = state.settings.geminiModel || 'gemini-3.5-flash';
  const endpoint = `generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const imgSize  = await getFileSizeKb(state.scan.imagePath);

  addLog(`→ POST https://${endpoint}`, 'info');
  addLog(`  Image: ${state.scan.imagePath.split('/').pop()} (${imgSize})`, 'info');
  addLog(`  Encoding to base64…`, 'info');

  const t0 = Date.now();

  try {
    addLog(`  Sending request…`, 'info');
    const result = await window.bs.scan(state.scan.imagePath);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    const items = Array.isArray(result) ? result : result.items;
    if (!items || !Array.isArray(items)) {
      addLog(`✗ Unexpected response shape`, 'error');
      state.scan.phase = 'photo'; render(); return;
    }

    addLog(`← 200 OK  (${elapsed}s)`, 'success');
    if (result.input_tokens) {
      const px   = modelPricing(result.model || model);
      const cost = ((result.input_tokens * px.inp + result.output_tokens * px.out) / 1_000_000).toFixed(6);
      addLog(`  Tokens: ${result.input_tokens} in + ${result.output_tokens} out = ${result.input_tokens + result.output_tokens} total`, 'info');
      addLog(`  Est. cost: $${cost} ($${px.inp}/$${px.out} per 1M tokens)`, 'info');
    }
    addLog(`  Model: ${result.model || model}`, 'info');
    addLog(`✓ ${items.length} items identified`, 'success');
    items.forEach(item => addLog(`  · ${item.name} [${item.confidence}]`, 'result'));

    state.scan.phase        = 'results';
    state.scan.saved        = {};
    state.scan.results      = items.map(i => ({ ...i, checked: true, location: '' }));
    state.scan.lastTokens   = result.input_tokens || 0;

    // Track daily usage
    state.settings.todayScans = (state.settings.todayScans || 0) + 1;
    await window.bs.saveSettings(state.settings);

    render();
  } catch(e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const msg = e.message || '';
    if (msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate')) {
      addLog(`✗ Rate limit hit after ${elapsed}s`, 'error');
      addLog(`  Free tier: 15 req/min · 1,500 req/day`, 'info');
      addLog(`  Wait 60s or upgrade at aistudio.google.com`, 'info');
    } else if (msg.includes('403') || msg.toLowerCase().includes('api key')) {
      addLog(`✗ Invalid API key — check Settings`, 'error');
    } else {
      addLog(`✗ Error after ${elapsed}s: ${msg}`, 'error');
    }
    state.scan.phase = 'photo'; render();
  }
}

// Convert Gemini confidence string to 0-100 integer
function confidenceToInt(c) {
  if (typeof c === 'number') return Math.min(100, Math.max(0, c));
  switch (String(c).toLowerCase()) {
    case 'high':   return 90;
    case 'medium': return 60;
    case 'low':    return 30;
    default:       return parseInt(c) || 50;
  }
}

async function saveScan() {
  // Only save checked items that have a location assigned
  const saved2   = state.scan.saved || {};
  const toSave   = state.scan.results.filter((r, i) =>
    r.checked !== false && r.location?.trim() && !saved2[i]
  );
  const missing  = state.scan.results.filter((r, i) =>
    r.checked !== false && !r.location?.trim() && !saved2[i]
  );

  if (!toSave.length) {
    alert('No new items to save. Assign locations to unsaved items first.');
    return;
  }
  if (missing.length) {
    if (!confirm(`${missing.length} item(s) have no location and will be skipped. Save the rest?`)) return;
  }

  // Group by location
  const byLoc = {};
  toSave.forEach((item, _) => {
    const loc = item.location.trim();
    (byLoc[loc] = byLoc[loc] || []).push(item);
  });

  for (const [locationId, items] of Object.entries(byLoc)) {
    const normItems = items.map(i => ({ ...i, confidence: confidenceToInt(i.confidence) }));
    await window.bs.saveScan({ imagePath: state.scan.imagePath, locationId, items: normItems });
  }

  // Mark saved items — keep results visible, grey them out
  toSave.forEach((item) => {
    const idx = state.scan.results.indexOf(item);
    if (idx >= 0) state.scan.saved[idx] = true;
  });

  const allSaved = state.scan.results.every((r, i) =>
    state.scan.saved[i] || r.checked === false || !r.location?.trim()
  );

  // Stay in results phase — keep items visible, just greyed out
  // state.scan.phase = 'done';  // removed — don't clear screen

  addLog(`✓ Saved ${toSave.length} items to catalog`, 'success');
  await refreshData();

  // Show stats modal
  const total    = state.scan.results.length;
  const savedNow = Object.keys(state.scan.saved).length;
  const unsaved  = total - savedNow;
  showScanStats(savedNow, unsaved, toSave);

  render();
}

}

// ── Scan stats modal ────────────────────────────────────────────────────────────
function showScanStats(saved, unsaved, items) {
  const modal = document.createElement('div');
  modal.className = 'scan-stats-modal-overlay';
  modal.innerHTML = `
    <div class="scan-stats-modal">
      <div class="scan-stats-header">
        <span class="scan-stats-icon">✅</span>
        <div>
          <div class="scan-stats-title">Saved to catalog</div>
          <div class="scan-stats-sub">${saved} item${saved!==1?'s':''} saved${unsaved>0?` · ${unsaved} remaining`:''}</div>
        </div>
      </div>
      <div class="scan-stats-items">
        ${items.slice(0,8).map(i => `
          <div class="scan-stats-item">
            <span class="scan-stats-name">${i.name}</span>
            <span class="scan-stats-loc">${i.location}</span>
          </div>
        `).join('')}
        ${items.length > 8 ? `<div class="scan-stats-more">+${items.length-8} more</div>` : ''}
      </div>
      <div class="scan-stats-footer">
        ${unsaved > 0
          ? `<button class="btn ghost" id="stats-continue-btn">Continue assigning</button>`
          : `<button class="btn ghost" id="stats-scan-btn">New scan</button>`
        }
        <button class="btn primary" id="stats-catalog-btn">View catalog</button>
      </div>
    </div>`;
  document.getElementById('root').appendChild(modal);

  modal.querySelector('#stats-catalog-btn')?.addEventListener('click', () => {
    modal.remove();
    state.tab = 'locations';
    render();
  });
  modal.querySelector('#stats-continue-btn')?.addEventListener('click', () => modal.remove());
  modal.querySelector('#stats-scan-btn')?.addEventListener('click', () => {
    modal.remove();
    resetScan();
  });
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ── eBay listing generation ───────────────────────────────────────────────────
// ── eBay listing generation ──────────────────────────────────────────────────────
async function generateListing() {
  if (!state.selectedItem) return;
  state.listingLoading = true;
  state.listing        = null;
  render();

  try {
    const photoPaths  = state.listingPhotos.map(p => p.path);
    const listing     = await window.bs.generateListing(state.selectedItem, photoPaths);
    state.listing    = listing;
    state.listingPrice = String(listing.price_low);

    // Save the generated listing back to the item
    await window.bs.updateItem(state.selectedItem.id, {
      ebay_title:       listing.title,
      ebay_description: listing.description,
      ebay_price:       listing.price_low,
      ebay_estimate:    `$${listing.price_low}–$${listing.price_high}`,
    });
  } catch(e) {
    showToast('Listing generation failed: ' + (e.message || e), 'error');
  } finally {
    state.listingLoading = false;
    render();
  }
}

// Helper for removing a listing photo
window.removeListingPhoto = function(idx) {
  state.listingPhotos.splice(idx, 1);
  render();
};

// ── Go ────────────────────────────────────────────────────────────────────────
boot();

