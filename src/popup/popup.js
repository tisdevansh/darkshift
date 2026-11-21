/* DarkShift — toolbar popup. */
import {
  DEFAULT_ADJUST,
  canRunOn,
  hostOf,
  loadState,
  resolve,
  setTabModes,
  shouldRemind,
  updateSettings,
  updateSite,
} from '../shared/core.js';
import { mountSupport, markReminded, markSupported } from '../ui/support.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SLIDERS = [
  { key: 'brightness', label: 'Brightness', icon: 'i-sun', fmt: (v) => `${v - 50 >= 0 ? '+' : ''}${v - 50}` },
  { key: 'contrast', label: 'Contrast', icon: 'i-filter', fmt: (v) => `${v - 50 >= 0 ? '+' : ''}${v - 50}` },
  { key: 'saturation', label: 'Saturation', icon: 'i-heart', fmt: (v) => `${v * 2}%` },
  { key: 'blueLight', label: 'Blue light', icon: 'i-moon', fmt: (v) => `${v}%` },
  { key: 'dim', label: 'Dim', icon: 'i-power', fmt: (v) => `${v}%` },
  { key: 'images', label: 'Dim images', icon: 'i-lock', fmt: (v) => `${v}%` },
];

const MODE_LABEL = { dark: 'Dark', filter: 'Filter', off: 'Off' };
const SOURCE_LABEL = {
  tab: 'set for this tab',
  site: 'site rule',
  default: 'default for all sites',
  schedule: 'paused by schedule',
  power: 'DarkShift is turned off',
  unsupported: 'protected page',
};

let state = null;
let tab = null;
let res = null;
let scope = null;
let allTabs = [];
const selected = new Set();
let dragging = false;

// ---- helpers --------------------------------------------------------------------------

function iconSvg(id, cls = 'icon') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}

function siteKey() {
  return res.siteKey || res.host;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function prettyHost(r, url) {
  if (r.host === 'file://') return 'Local file';
  if (r.host) return r.host;
  try {
    const u = new URL(url);
    return u.protocol === 'chrome:' || u.protocol === 'edge:' || u.protocol === 'brave:' ? 'Browser page' : u.protocol.replace(':', '') + ' page';
  } catch (e) {
    return 'This page';
  }
}

// ---- rendering --------------------------------------------------------------------------

function renderHeader() {
  const on = state.settings.enabled;
  $('#power').checked = on;
  $('#powerLabel').textContent = on ? 'On' : 'Off';
}

function renderSite() {
  const supported = res.source !== 'unsupported';
  $('#host').textContent = prettyHost(res, tab.url);
  const fav = $('#favicon');
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) {
    fav.src = tab.favIconUrl;
    fav.onerror = () => (fav.src = '../../icons/on-32.png');
  } else {
    fav.src = '../../icons/on-32.png';
  }

  const chip = $('#modeChip');
  chip.className = `chip ${res.mode}`;
  chip.textContent = MODE_LABEL[res.mode];
  let status = SOURCE_LABEL[res.source] || '';
  if (res.followSystem) status += ' · follows system theme';
  $('#status').textContent = `${MODE_LABEL[res.mode]} · ${status}`;

  $('#unsupported').hidden = supported;
  if (!supported && /^file:/.test(tab.url)) {
    $('#unsupportedText').textContent = 'Allow "Access to file URLs" for DarkShift on the extensions page to use it on local files.';
  }
  $('#controls').hidden = !supported;
  $('#controls').classList.toggle('disabled-ui', !state.settings.enabled);
  if (!supported) return;

  for (const b of $$('.scope [data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));

  // Mode buttons show the value that applies at the chosen scope.
  let shown = res.mode;
  if (scope === 'all') shown = state.settings.defaultMode;
  else if (scope === 'site') {
    const site = res.siteKey && state.sites[res.siteKey];
    shown = site && site.mode ? site.mode : res.source === 'tab' ? null : res.mode;
  } else if (scope === 'tab') shown = state.tabs[tab.id] || res.mode;
  for (const b of $$('.modes [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === shown));

  renderScopeHint();
}

function renderScopeHint() {
  const hint = $('#scopeHint');
  hint.textContent = '';
  const add = (text, action, label) => {
    const span = document.createElement('span');
    span.textContent = text;
    hint.append(span);
    if (action) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', action);
      hint.append(b);
    }
  };
  if (scope === 'tab') {
    if (state.tabs[tab.id]) add('Only this tab is changed.', () => setTabModes([tab.id], null), 'Undo');
    else add('Changes only this tab until it is closed.');
  } else if (scope === 'site') {
    const site = res.siteKey && state.sites[res.siteKey];
    if (site && site.mode) add(`Remembered for ${res.siteKey}.`, () => updateSite(res.siteKey, { mode: null }), 'Use default');
    else add(`Choose a mode to remember it for ${res.host}.`);
  } else {
    const rules = Object.values(state.sites).filter((s) => s.mode).length;
    add(rules ? `Default for every site · ${rules} site rule${rules > 1 ? 's' : ''} still apply.` : 'Default for every site.');
  }
}

function renderSliders(force) {
  const box = $('#sliders');
  if (!box.childElementCount) {
    box.innerHTML = SLIDERS.map(
      (s) => `<div class="slider-row">
        <span class="s-ico">${iconSvg(s.icon)}</span>
        <label for="s-${s.key}">${s.label}</label>
        <input type="range" id="s-${s.key}" data-key="${s.key}" min="0" max="100" step="1">
        <output id="o-${s.key}"></output>
      </div>`,
    ).join('');
    for (const input of box.querySelectorAll('input')) {
      input.addEventListener('input', () => {
        dragging = true;
        paintSlider(input);
        saveAdjust();
      });
      input.addEventListener('change', () => (dragging = false));
    }
  }
  if (dragging && !force) return;
  for (const s of SLIDERS) {
    const input = $(`#s-${s.key}`);
    input.value = res.adjust[s.key];
    paintSlider(input);
  }
  const supported = res.source !== 'unsupported';
  $('#siteOnly').checked = res.customAdjust;
  $('#siteOnly').disabled = !supported || !res.host;
  $('#siteOnlyLabel').textContent = res.host && supported ? `Only ${res.host.length > 18 ? 'this site' : res.host}` : 'Only this site';
}

function paintSlider(input) {
  const s = SLIDERS.find((x) => x.key === input.dataset.key);
  input.style.setProperty('--pct', `${input.value}%`);
  $(`#o-${s.key}`).textContent = s.fmt(Number(input.value));
}

const saveAdjust = debounce(async () => {
  const adjust = {};
  for (const s of SLIDERS) adjust[s.key] = Number($(`#s-${s.key}`).value);
  if ($('#siteOnly').checked && res.host) await updateSite(siteKey(), { adjust });
  else await updateSettings({ adjust });
  dragging = false;
}, 90);

function renderTabs() {
  const list = $('#tabList');
  $('#tabsCount').textContent = `${allTabs.length} open`;
  list.textContent = '';
  for (const t of allTabs) {
    const r = resolve(state, t.id, t.url);
    const locked = r.source === 'unsupported';
    const li = document.createElement('li');
    li.className = 'tab-item' + (t.id === tab.id ? ' current' : '') + (locked ? ' locked' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = locked;
    cb.checked = selected.has(t.id);
    cb.setAttribute('aria-label', `Select ${t.title || 'tab'}`);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(t.id);
      else selected.delete(t.id);
      renderSelection();
    });
    let fav;
    if (t.favIconUrl && /^(https?|data):/.test(t.favIconUrl)) {
      fav = document.createElement('img');
      fav.src = t.favIconUrl;
      fav.alt = '';
      fav.onerror = () => fav.replaceWith(fallbackFav(t));
    } else {
      fav = fallbackFav(t);
    }
    const text = document.createElement('div');
    text.className = 'tab-text';
    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = t.title || prettyHost(r, t.url);
    const host = document.createElement('div');
    host.className = 'tab-host';
    host.textContent = locked ? 'Protected page' : prettyHost(r, t.url);
    text.append(title, host);
    const chip = document.createElement('span');
    chip.className = `chip ${r.mode}` + (r.source === 'tab' ? ' pinned' : '');
    chip.textContent = MODE_LABEL[r.mode];
    chip.title = SOURCE_LABEL[r.source] || '';
    li.append(cb, fav, text, chip);
    li.addEventListener('click', (e) => {
      if (locked || e.target === cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    list.append(li);
  }
  renderSelection();
}

function fallbackFav(t) {
  const d = document.createElement('span');
  d.className = 'fav-fallback';
  d.textContent = (hostOf(t.url || '') || '?').charAt(0).toUpperCase();
  return d;
}

function renderSelection() {
  const selectable = allTabs.filter((t) => canRunOn(t.url));
  for (const id of [...selected]) if (!selectable.some((t) => t.id === id)) selected.delete(id);
  const all = $('#selectAll');
  all.checked = selectable.length > 0 && selected.size === selectable.length;
  all.indeterminate = selected.size > 0 && selected.size < selectable.length;
  $('#selectedCount').textContent = selected.size ? `${selected.size} selected` : 'Select all';
  for (const b of $$('[data-bulk]')) b.disabled = selected.size === 0;
}

async function renderReminder() {
  const { support } = await chrome.storage.local.get('support');
  if (!shouldRemind(support)) return;
  $('#reminder').hidden = false;
  // Counting the reminder as shown keeps it to once every 10 days.
  markReminded();
}

let fileAccess = true;

function renderAll() {
  res = resolve(state, tab.id, tab.url);
  if (!fileAccess && /^file:/.test(tab.url || '')) res = { ...res, mode: 'off', source: 'unsupported' };
  if (!scope) scope = state.tabs[tab.id] ? 'tab' : 'site';
  renderHeader();
  renderSite();
  renderSliders();
  if (!$('#tabsBody').hidden) renderTabs();
  else $('#tabsCount').textContent = `${allTabs.length} open`;
}

// ---- actions ---------------------------------------------------------------------------

async function setMode(mode) {
  if (!state.settings.enabled) await updateSettings({ enabled: true });
  if (scope === 'tab') await setTabModes([tab.id], mode);
  else if (scope === 'site') {
    await updateSite(siteKey(), { mode });
    if (state.tabs[tab.id]) await setTabModes([tab.id], null);
  } else {
    await updateSettings({ defaultMode: mode });
    if (state.tabs[tab.id]) await setTabModes([tab.id], null);
  }
}

function wire() {
  $('#power').addEventListener('change', (e) => updateSettings({ enabled: e.target.checked }));
  for (const b of $$('.modes [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const b of $$('.scope [data-scope]')) {
    b.addEventListener('click', () => {
      scope = b.dataset.scope;
      renderSite();
    });
  }

  $('#siteOnly').addEventListener('change', async (e) => {
    if (!res.host) return;
    if (e.target.checked) await updateSite(siteKey(), { adjust: res.adjust });
    else await updateSite(siteKey(), { adjust: null });
  });
  $('#resetAdjust').addEventListener('click', async () => {
    if (res.customAdjust) await updateSite(siteKey(), { adjust: { ...DEFAULT_ADJUST } });
    else await updateSettings({ adjust: { ...DEFAULT_ADJUST } });
  });

  $('#tabsToggle').addEventListener('click', () => {
    const body = $('#tabsBody');
    body.hidden = !body.hidden;
    $('#tabsToggle').setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) renderTabs();
  });
  $('#selectAll').addEventListener('change', (e) => {
    selected.clear();
    if (e.target.checked) for (const t of allTabs) if (canRunOn(t.url)) selected.add(t.id);
    renderTabs();
  });
  for (const b of $$('[data-bulk]')) {
    b.addEventListener('click', async () => {
      const mode = b.dataset.bulk === 'clear' ? null : b.dataset.bulk;
      if (mode && !state.settings.enabled) await updateSettings({ enabled: true });
      await setTabModes([...selected], mode);
    });
  }

  $('#settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const sheet = $('#supportSheet');
  let support = null;
  const openSupport = () => {
    sheet.hidden = false;
    if (!support) support = mountSupport(sheet);
    $('#reminder').hidden = true;
  };
  const closeSupport = () => (sheet.hidden = true);
  $('#supportBtn').addEventListener('click', openSupport);
  $('#reminderSupport').addEventListener('click', openSupport);
  $('#reminderClose').addEventListener('click', () => ($('#reminder').hidden = true));
  $('#supportClose').addEventListener('click', closeSupport);
  $('#supportLater').addEventListener('click', closeSupport);
  sheet.addEventListener('click', (e) => e.target === sheet && closeSupport());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !sheet.hidden && closeSupport());
  $('#supportDone').addEventListener('click', async () => {
    await markSupported();
    const btn = $('#supportDone');
    btn.textContent = 'Thank you! ❤';
    btn.disabled = true;
    setTimeout(closeSupport, 1200);
  });
}

async function refreshTabs() {
  allTabs = await chrome.tabs.query({});
  allTabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) tab = { id: -1, url: '' };
  [state] = await Promise.all([loadState(), refreshTabs()]);
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  // Pre-select tabs the user highlighted in the tab strip (Ctrl/Shift+click).
  const highlighted = allTabs.filter((t) => t.highlighted && t.windowId === tab.windowId && canRunOn(t.url));
  if (highlighted.length > 1) for (const t of highlighted) selected.add(t.id);
  wire();
  renderAll();
  if (highlighted.length > 1) $('#tabsToggle').click();
  renderReminder();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && !changes.settings && !changes.sites) return;
    state = await loadState();
    renderAll();
  });
  const onTabsChanged = debounce(async () => {
    await refreshTabs();
    renderAll();
  }, 150);
  chrome.tabs.onUpdated.addListener(onTabsChanged);
  chrome.tabs.onRemoved.addListener(onTabsChanged);
  chrome.tabs.onCreated.addListener(onTabsChanged);
}

init();
