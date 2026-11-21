/* DarkShift — options page. */
import {
  DEFAULT_SETTINGS,
  MODES,
  inTimeWindow,
  loadState,
  normalizeAdjust,
  normalizeSettings,
  updateSettings,
  updateSite,
} from '../shared/core.js';
import { mountSupport, markSupported } from '../ui/support.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;

function renderGeneral() {
  $('#enabled').checked = state.settings.enabled;
  for (const b of $$('#defaultMode [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.settings.defaultMode));
}

function renderSchedule() {
  const sch = state.settings.schedule;
  for (const b of $$('#scheduleType [data-type]')) b.setAttribute('aria-pressed', String(b.dataset.type === sch.type));
  $('#timeRow').hidden = sch.type !== 'time';
  if (document.activeElement !== $('#start')) $('#start').value = sch.start;
  if (document.activeElement !== $('#end')) $('#end').value = sch.end;
  $('#scheduleNow').textContent = inTimeWindow(sch) ? 'Active right now.' : 'Not active right now: sites using the default stay light.';
}

function renderSites() {
  const filter = $('#siteFilter').value.trim().toLowerCase();
  const rows = $('#siteRows');
  rows.textContent = '';
  const keys = Object.keys(state.sites).sort();
  const shown = keys.filter((k) => !filter || k.includes(filter));
  $('#sitesEmpty').hidden = keys.length > 0;
  for (const key of shown) {
    const site = state.sites[key];
    const tr = document.createElement('tr');
    const host = document.createElement('td');
    host.className = 'host-cell';
    host.textContent = key === 'file://' ? 'Local files' : key;

    const modeTd = document.createElement('td');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Mode for ${key}`);
    for (const [value, label] of [['', 'Default'], ['dark', 'Dark'], ['filter', 'Filter'], ['off', 'Off']]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.append(o);
    }
    sel.value = site.mode || '';
    sel.addEventListener('change', () => updateSite(key, { mode: sel.value || null }));
    modeTd.append(sel);

    const adjTd = document.createElement('td');
    if (site.adjust) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Remove custom';
      b.addEventListener('click', () => updateSite(key, { adjust: null }));
      adjTd.append(b);
    } else {
      adjTd.innerHTML = '<span class="muted">—</span>';
    }

    const delTd = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn ghost small';
    del.textContent = 'Delete';
    del.addEventListener('click', () => updateSite(key, { mode: null, adjust: null }));
    delTd.append(del);

    tr.append(host, modeTd, adjTd, delTd);
    rows.append(tr);
  }
}

async function renderShortcuts() {
  const box = $('#shortcutRows');
  const cmds = await chrome.commands.getAll();
  box.textContent = '';
  for (const c of cmds) {
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = c.name === '_execute_action' ? 'Open DarkShift popup' : c.description;
    const key = document.createElement('span');
    key.className = 'kbd' + (c.shortcut ? '' : ' unset');
    key.textContent = c.shortcut || 'Not set';
    row.append(title, key);
    box.append(row);
  }
}

function renderAll() {
  renderGeneral();
  renderSchedule();
  renderSites();
}

function cleanHost(input) {
  let v = input.trim().toLowerCase();
  if (!v) return '';
  if (!/^[a-z]+:\/\//.test(v)) v = 'https://' + v;
  try {
    return new URL(v).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function wire() {
  $('#enabled').addEventListener('change', (e) => updateSettings({ enabled: e.target.checked }));
  for (const b of $$('#defaultMode [data-mode]')) b.addEventListener('click', () => updateSettings({ defaultMode: b.dataset.mode }));
  for (const b of $$('#scheduleType [data-type]')) {
    b.addEventListener('click', () => updateSettings({ schedule: { ...state.settings.schedule, type: b.dataset.type } }));
  }
  for (const id of ['start', 'end']) {
    $('#' + id).addEventListener('change', (e) => {
      if (e.target.value) updateSettings({ schedule: { ...state.settings.schedule, [id]: e.target.value } });
    });
  }

  $('#addSite').addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = cleanHost($('#newHost').value);
    if (!host) {
      $('#newHost').focus();
      return;
    }
    await updateSite(host, { mode: $('#newMode').value });
    $('#newHost').value = '';
  });
  $('#siteFilter').addEventListener('input', renderSites);

  $('#openShortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  $('#export').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['settings', 'sites']);
    const blob = new Blob([JSON.stringify({ app: 'DarkShift', version: 1, ...data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `darkshift-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const msg = $('#importMsg');
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || (data.app && data.app !== 'DarkShift')) throw new Error('Not a DarkShift file');
      const sites = {};
      for (const [k, v] of Object.entries(data.sites || {})) {
        if (!v || typeof v !== 'object' || typeof k !== 'string' || k.length > 253) continue;
        const entry = {};
        if (MODES.includes(v.mode)) entry.mode = v.mode;
        if (v.adjust) entry.adjust = normalizeAdjust(v.adjust);
        if (Object.keys(entry).length) sites[k.toLowerCase()] = entry;
      }
      await chrome.storage.local.set({ settings: normalizeSettings(data.settings), sites });
      msg.textContent = `Imported ${Object.keys(sites).length} site rules.`;
    } catch (err) {
      msg.textContent = `Couldn't import: ${err.message}`;
    }
  });

  let resetArmed = false;
  $('#reset').addEventListener('click', async (e) => {
    if (!resetArmed) {
      resetArmed = true;
      e.target.textContent = 'Click again to confirm';
      setTimeout(() => {
        resetArmed = false;
        e.target.textContent = 'Reset';
      }, 4000);
      return;
    }
    await chrome.storage.local.set({ settings: normalizeSettings(DEFAULT_SETTINGS), sites: {} });
    await chrome.storage.session.set({ tabs: {} });
    resetArmed = false;
    e.target.textContent = 'Done';
  });

  $('#supportDone').addEventListener('click', async () => {
    await markSupported();
    $('#supportThanks').textContent = '  Thank you so much! ❤';
  });

  // Highlight the section in view.
  const links = $$('nav a');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        for (const l of links) l.classList.toggle('active', l.getAttribute('href') === '#' + en.target.id);
      }
    },
    { rootMargin: '-30% 0px -60% 0px' },
  );
  for (const s of $$('main .panel')) observer.observe(s);
}

async function init() {
  $('#version').textContent = chrome.runtime.getManifest().version;
  if (location.hash === '#welcome') $('#welcome').hidden = false;
  state = await loadState();
  wire();
  renderAll();
  renderShortcuts();
  mountSupport($('#support'));
  chrome.storage.onChanged.addListener(async () => {
    state = await loadState();
    renderAll();
  });
}

init();
