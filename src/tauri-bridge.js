/**
 * burrowstock — tauri-bridge.js
 *
 * Provides window.bs.* API identical to the Electron preload.js.
 * The frontend (app.js) never needs to know it's running in Tauri.
 *
 * Uses @tauri-apps/api/core invoke() under the hood.
 * Loaded before app.js so window.bs is ready immediately.
 */

// Tauri v2 exposes __TAURI_INTERNALS__ on window
const invoke = window.__TAURI_INTERNALS__?.invoke
  ?? (async (cmd, args) => {
      console.error('Tauri not available — running in browser?', cmd, args);
      throw new Error('Tauri runtime not found');
  });

// Convert a local filesystem path to bslocal:// URL
// bslocal:// is a custom Rust protocol handler registered in lib.rs
function toAssetUrl(filePath) {
  return `bslocal://localhost${filePath.startsWith('/') ? filePath : '/' + filePath}`;
}

// File dialog helpers via Tauri v2 plugin-dialog
async function openImageDialog(multiple = false) {
  return invoke('plugin:dialog|open', {
    options: {
      multiple,
      filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','webp','heic'] }],
    }
  });
}

window.bs = {
  // ── Settings ──────────────────────────────────────────────────────────────
  loadSettings:   ()           => invoke('load_settings'),
  saveSettings:   (data)       => invoke('save_settings',  { settings: data }),

  // ── Gemini models ─────────────────────────────────────────────────────────
  listModels:     (apiKey)     => invoke('list_models',    { apiKey }),

  // ── Locations ─────────────────────────────────────────────────────────────
  listLocations:  ()           => invoke('list_locations'),
  upsertLocation: (id, label='') => invoke('upsert_location', { id, label }),
  renameLocation: (oldId, newId) => invoke('rename_location', { oldId, newId }),
  deleteLocation: (id)         => invoke('delete_location', { id }),

  // ── Items ─────────────────────────────────────────────────────────────────
  listItems:      (opts={})    => invoke('list_items',     { locationId: opts?.locationId ?? null }),
  getItem:        (id)         => invoke('get_item',       { id }),
  addItem:        (data)       => invoke('add_item',       data),
  updateItem:     (id, fields) => invoke('update_item',    { id, fields }),
  renameItem:     (id, name)   => invoke('rename_item',    { id, name }),
  deleteItem:     (id)         => invoke('delete_item',    { id }),
  moveItem:       (id, locationId) => invoke('move_item',  { id, locationId }),
  search:         (query)      => invoke('search_items',   { query }),

  // ── File dialogs ──────────────────────────────────────────────────────────
  openImage: async () => {
    const result = await openImageDialog(false);
    if (!result) return null;
    const path = Array.isArray(result) ? result[0] : result;
    return { path, url: toAssetUrl(path) };
  },

  openItemPhotos: async () => {
    const result = await openImageDialog(true);
    if (!result || !result.length) return [];
    const paths = Array.isArray(result) ? result.slice(0, 5) : [result];
    return paths.map(path => ({ path, url: toAssetUrl(path) }));
  },

  // ── Vision scan ───────────────────────────────────────────────────────────
  scan: async (imagePath) => {
    const settings = await invoke('load_settings');
    return invoke('scan_photo', {
      imagePath,
      apiKey:        settings.geminiKey,
      model:         settings.geminiModel || 'gemini-2.5-flash',
      customPrompt:  settings.scanPrompt || null,
    });
  },

  // ── Prompt ────────────────────────────────────────────────────────────────
  getDefaultPrompt:        () => invoke('get_default_prompt'),
  getDefaultListingPrompt: () => invoke('get_default_listing_prompt'),

  saveScan: (data) => invoke('save_scan', {
    imagePath:  data.imagePath  || '',
    locationId: data.locationId,
    items:      data.items      || [],
    model:      'gemini-2.5-flash',
  }),

  // ── eBay listing ──────────────────────────────────────────────────────────
  generateListing: async (item, photoPaths = []) => {
    const settings = await invoke('load_settings');
    return invoke('generate_listing', {
      itemName:   item.name,
      itemCond:   item.condition  || 'unknown',
      itemNotes:  item.notes      || '',
      photoPaths: photoPaths.map(p => typeof p === 'string' ? p : p.path),
      apiKey:     settings.geminiKey,
      model:      settings.geminiModel || 'gemini-2.5-flash',
    });
  },
};

console.log('[burrowstock] Tauri bridge ready');
