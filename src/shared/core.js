/*
 * DarkShift — shared settings model, used by the background worker, popup and options page.
 *
 * Precedence for a tab:  power off  >  tab override  >  site rule  >  default mode (+ schedule)
 */

export const BRAND = 'DarkShift';
export const MODES = ['dark', 'filter', 'off'];

export const DEFAULT_ADJUST = Object.freeze({
  brightness: 50,
  contrast: 50,
  saturation: 50,
  blueLight: 0,
  dim: 0,
  images: 0,
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  defaultMode: 'dark',
  adjust: DEFAULT_ADJUST,
  schedule: Object.freeze({ type: 'always', start: '20:00', end: '07:00' }),
});

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function normalizeAdjust(a, base = DEFAULT_ADJUST) {
  const out = {};
  for (const k of Object.keys(DEFAULT_ADJUST)) out[k] = clampInt(a && a[k], 0, 100, base[k]);
  return out;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSettings(s) {
  s = s || {};
  const sch = s.schedule || {};
  return {
    enabled: s.enabled !== false,
    defaultMode: MODES.includes(s.defaultMode) ? s.defaultMode : DEFAULT_SETTINGS.defaultMode,
    adjust: normalizeAdjust(s.adjust),
    schedule: {
      type: ['always', 'system', 'time'].includes(sch.type) ? sch.type : 'always',
      start: TIME_RE.test(sch.start) ? sch.start : DEFAULT_SETTINGS.schedule.start,
      end: TIME_RE.test(sch.end) ? sch.end : DEFAULT_SETTINGS.schedule.end,
    },
  };
}

/** Site key for a URL: hostname without "www.", "file://" for local files, '' if unsupported. */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'file://';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/** Whether extensions are allowed to run on this URL at all. */
export function canRunOn(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) return false;
  const h = u.hostname;
  if (h === 'chromewebstore.google.com') return false;
  if (h === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
  if (h === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return false;
  return true;
}

/** Find the site rule that applies to a host (exact host first, then parent domains). */
export function findSiteKey(host, sites) {
  if (!host || !sites) return null;
  if (sites[host]) return host;
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const key = parts.slice(i).join('.');
    if (sites[key]) return key;
  }
  return null;
}

const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export function inTimeWindow(schedule, date = new Date()) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(schedule.start);
  const end = toMinutes(schedule.end);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Next Date at which the time schedule flips. */
export function nextScheduleBoundary(schedule, date = new Date()) {
  const candidates = [schedule.start, schedule.end].map((t) => {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(date);
    d.setHours(h, m, 0, 0);
    if (d <= date) d.setDate(d.getDate() + 1);
    return d;
  });
  return new Date(Math.min(...candidates.map(Number)) + 1000);
}

/**
 * Resolve what a tab should look like.
 * Returns { mode, source, adjust, host, siteKey, followSystem, customAdjust }.
 * source: 'power' | 'tab' | 'site' | 'default' | 'schedule' | 'unsupported'
 */
export function resolve(state, tabId, url) {
  const settings = state.settings;
  const host = hostOf(url);
  const siteKey = findSiteKey(host, state.sites);
  const site = siteKey ? state.sites[siteKey] : null;
  const customAdjust = !!(site && site.adjust);
  const adjust = normalizeAdjust(customAdjust ? site.adjust : settings.adjust, settings.adjust);
  const base = { host, siteKey, adjust, customAdjust, followSystem: false };

  if (!url || !canRunOn(url)) return { ...base, mode: 'off', source: 'unsupported' };
  if (!settings.enabled) return { ...base, mode: 'off', source: 'power' };
  const tabMode = state.tabs && state.tabs[tabId];
  if (MODES.includes(tabMode)) return { ...base, mode: tabMode, source: 'tab' };
  if (site && MODES.includes(site.mode)) return { ...base, mode: site.mode, source: 'site' };

  const mode = settings.defaultMode;
  const sch = settings.schedule;
  if (mode !== 'off' && sch.type === 'time' && !inTimeWindow(sch)) return { ...base, mode: 'off', source: 'schedule' };
  return { ...base, mode, source: 'default', followSystem: mode !== 'off' && sch.type === 'system' };
}

/** The slice of a resolution that content scripts need. */
export function contentConfig(r) {
  return { mode: r.mode, adjust: r.adjust, followSystem: r.followSystem };
}

export async function loadState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'sites']),
    chrome.storage.session.get('tabs'),
  ]);
  return {
    settings: normalizeSettings(local.settings),
    sites: local.sites && typeof local.sites === 'object' ? local.sites : {},
    tabs: session.tabs && typeof session.tabs === 'object' ? session.tabs : {},
  };
}

// ---- mutations (all writes go through these so popup, options and shortcuts agree) ----

export async function updateSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  const next = normalizeSettings({ ...normalizeSettings(settings), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function updateSite(key, patch) {
  if (!key) return;
  const { sites = {} } = await chrome.storage.local.get('sites');
  const cur = { ...(sites[key] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete cur[k];
    else cur[k] = k === 'adjust' ? normalizeAdjust(v) : v;
  }
  if (Object.keys(cur).length) sites[key] = cur;
  else delete sites[key];
  await chrome.storage.local.set({ sites });
}

export async function setTabModes(tabIds, mode) {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  for (const id of tabIds) {
    if (MODES.includes(mode)) tabs[id] = mode;
    else delete tabs[id];
  }
  await chrome.storage.session.set({ tabs });
}

// ---- support reminder (popup only, never on web pages) ----

export const SUPPORT = Object.freeze({
  upiId: 'tisdevansh@pingpay',
  payee: 'Devansh Agarwal',
  author: 'Devansh Agarwal',
  amounts: [19, 49, 99],
  reminderDays: 10,
  graceDays: 3,
  thanksDays: 60,
});

const DAY = 24 * 60 * 60 * 1000;

export function upiLink(amount) {
  // Keep "@" literal in the VPA: some UPI apps don't decode %40 in pa=.
  const enc = (v) => encodeURIComponent(v).replace(/%40/g, '@');
  let link = `upi://pay?pa=${enc(SUPPORT.upiId)}&pn=${enc(SUPPORT.payee)}&cu=INR&tn=${enc(`Support ${BRAND}`)}`;
  if (amount > 0) link += `&am=${amount}.00`;
  return link;
}

/** Should the popup show the gentle support reminder? */
export function shouldRemind(support, now = Date.now()) {
  const s = support || {};
  if (s.never) return false;
  if (!s.installedAt) return false;
  if (now - s.installedAt < SUPPORT.graceDays * DAY) return false;
  if (s.supportedAt && now - s.supportedAt < SUPPORT.thanksDays * DAY) return false;
  return !s.lastReminder || now - s.lastReminder >= SUPPORT.reminderDays * DAY;
}
