/*
 * DarkShift — background service worker.
 * Resolves per-tab config, pushes changes to tabs, fetches cross-origin CSS, and handles
 * shortcuts, context menus, the schedule and the toolbar icon.
 */
import {
  canRunOn,
  contentConfig,
  loadState,
  nextScheduleBoundary,
  normalizeSettings,
  resolve,
  setTabModes,
  updateSettings,
  updateSite,
} from './shared/core.js';

const CONTENT_FILES = ['src/content/color.js', 'src/content/css.js', 'src/content/engine.js', 'src/content/main.js'];
const HOOK_FILE = 'src/content/hook.js';
const ICON = (state) => ({
  16: `icons/${state}-16.png`,
  32: `icons/${state}-32.png`,
  48: `icons/${state}-48.png`,
  128: `icons/${state}-128.png`,
});
const ALARM = 'dm-schedule';

// ---- install / startup -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings, support } = await chrome.storage.local.get(['settings', 'support']);
  await chrome.storage.local.set({
    settings: normalizeSettings(settings),
    support: { installedAt: Date.now(), ...(support || {}) },
  });
  createMenus();
  await injectIntoOpenTabs();
  await refreshSchedule();
  if (details.reason === 'install') chrome.tabs.create({ url: 'src/options/options.html#welcome' });
});

chrome.runtime.onStartup.addListener(() => {
  refreshSchedule();
});

/** Content scripts only auto-run on new page loads; bring already-open tabs up to date. */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id >= 0 && canRunOn(t.url) && !t.discarded)
      .map(async (t) => {
        const target = { tabId: t.id, allFrames: true };
        try {
          await chrome.scripting.executeScript({ target, files: [HOOK_FILE], world: 'MAIN', injectImmediately: true });
          await chrome.scripting.executeScript({ target, files: CONTENT_FILES, injectImmediately: true });
        } catch (e) {
          /* tab not scriptable (file access off, error page...) */
        }
      }),
  );
}

// ---- config delivery ---------------------------------------------------------------------

function frameUrl(sender) {
  // Sub-frames follow the tab's top-level site so a whole tab looks consistent.
  if (sender.frameId === 0) return sender.url || (sender.tab && sender.tab.url);
  return (sender.tab && sender.tab.url) || sender.url;
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushAll, 25);
}

async function pushAll() {
  const [state, tabs] = await Promise.all([loadState(), chrome.tabs.query({})]);
  for (const tab of tabs) {
    if (!canRunOn(tab.url)) continue;
    const config = contentConfig(resolve(state, tab.id, tab.url));
    chrome.tabs.sendMessage(tab.id, { type: 'config', config }).catch(() => {});
  }
  await refreshSchedule(state.settings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && (changes.settings || changes.sites)) || (area === 'session' && changes.tabs)) schedulePush();
});

async function refreshSchedule(settings) {
  if (!settings) settings = (await loadState()).settings;
  await chrome.alarms.clear(ALARM);
  if (settings.enabled && settings.schedule.type === 'time') {
    chrome.alarms.create(ALARM, { when: nextScheduleBoundary(settings.schedule).getTime() });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) pushAll();
});

// ---- messages ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'getConfig':
      loadState()
        .then((state) => sendResponse(contentConfig(resolve(state, sender.tab ? sender.tab.id : -1, frameUrl(sender)))))
        .catch(() => sendResponse(null));
      return true;
    case 'fetchCSS':
      if (!sender.tab) return false;
      fetchCSS(msg.url).then(sendResponse);
      return true;
    case 'fetchImage':
      if (!sender.tab) return false;
      fetchImage(msg.url).then(sendResponse);
      return true;
    case 'status':
      if (sender.tab && sender.frameId === 0) setIcon(sender.tab.id, msg.mode !== 'off');
      return false;
    default:
      return false;
  }
});

const cssCache = new Map();
const CSS_CACHE_MAX = 300;
const CSS_MAX_BYTES = 8 * 1024 * 1024;

function fetchCSS(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false });
  if (cssCache.has(url)) return cssCache.get(url);
  const job = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal, cache: 'force-cache' });
      if (!res.ok) return { ok: false };
      const type = res.headers.get('content-type') || '';
      if (type && !/css|text\/plain|octet-stream/i.test(type)) return { ok: false };
      const text = await res.text();
      if (text.length > CSS_MAX_BYTES) return { ok: false };
      return { ok: true, text };
    } catch (e) {
      cssCache.delete(url);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  })();
  cssCache.set(url, job);
  if (cssCache.size > CSS_CACHE_MAX) cssCache.delete(cssCache.keys().next().value);
  return job;
}

// Cross-origin logos/icons are sampled to decide whether a dark transparent image needs inverting.
const imgCache = new Map();
const IMG_MAX_BYTES = 1.5 * 1024 * 1024;

function fetchImage(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false });
  if (imgCache.has(url)) return imgCache.get(url);
  const job = (async () => {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !/^image\//i.test(type)) return { ok: false };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > IMG_MAX_BYTES) return { ok: false };
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { ok: true, dataUrl: `data:${type};base64,${btoa(bin)}` };
    } catch (e) {
      return { ok: false };
    }
  })();
  imgCache.set(url, job);
  if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
  return job;
}

// ---- toolbar icon ------------------------------------------------------------------------

function setIcon(tabId, on) {
  chrome.action.setIcon({ tabId, path: ICON(on ? 'on' : 'off') }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' && tab.url && !canRunOn(tab.url)) setIcon(tabId, false);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setTabModes([tabId], null).catch(() => {});
});

// ---- actions shared by shortcuts and context menu ------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function toggleSite(tab, onMode = 'dark') {
  if (!tab || !canRunOn(tab.url)) return;
  const state = await loadState();
  const r = resolve(state, tab.id, tab.url);
  if (!r.host) return;
  if (!state.settings.enabled) await updateSettings({ enabled: true });
  const next = r.mode === onMode && state.settings.enabled ? 'off' : onMode;
  await updateSite(r.siteKey || r.host, { mode: next });
  await setTabModes([tab.id], null);
}

async function toggleTab(tab) {
  if (!tab || !canRunOn(tab.url)) return;
  const state = await loadState();
  const r = resolve(state, tab.id, tab.url);
  if (!state.settings.enabled) await updateSettings({ enabled: true });
  await setTabModes([tab.id], r.mode === 'off' || !state.settings.enabled ? 'dark' : 'off');
}

async function cycleMode(tab) {
  if (!tab || !canRunOn(tab.url)) return;
  const state = await loadState();
  const r = resolve(state, tab.id, tab.url);
  const order = ['dark', 'filter', 'off'];
  const next = order[(order.indexOf(r.mode) + 1) % order.length];
  await updateSite(r.siteKey || r.host, { mode: next });
  await setTabModes([tab.id], null);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || (await activeTab());
  switch (command) {
    case 'toggle-site':
      return toggleSite(tab);
    case 'toggle-tab':
      return toggleTab(tab);
    case 'cycle-mode':
      return cycleMode(tab);
    case 'toggle-power': {
      const { settings } = await loadState();
      return updateSettings({ enabled: !settings.enabled });
    }
  }
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'frame', 'selection', 'link', 'image', 'video'];
    chrome.contextMenus.create({ id: 'dm-root', title: 'DarkShift', contexts });
    chrome.contextMenus.create({ id: 'dm-site', parentId: 'dm-root', title: 'Toggle dark mode for this site', contexts });
    chrome.contextMenus.create({ id: 'dm-tab', parentId: 'dm-root', title: 'Toggle dark mode for this tab only', contexts });
    chrome.contextMenus.create({ id: 'dm-filter', parentId: 'dm-root', title: 'Toggle filter mode for this site', contexts });
    chrome.contextMenus.create({ id: 'dm-sep', parentId: 'dm-root', type: 'separator', contexts });
    chrome.contextMenus.create({ id: 'dm-power', parentId: 'dm-root', title: 'Turn DarkShift on / off everywhere', contexts });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case 'dm-site':
      return toggleSite(tab);
    case 'dm-tab':
      return toggleTab(tab);
    case 'dm-filter':
      return toggleSite(tab, 'filter');
    case 'dm-power': {
      const { settings } = await loadState();
      return updateSettings({ enabled: !settings.enabled });
    }
  }
});
