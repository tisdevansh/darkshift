/*
 * DarkShift — content controller. Gets the resolved config for this tab from the
 * background worker and starts/stops/updates the right engine.
 */
'use strict';
(() => {
  const U = (globalThis.__dm = globalThis.__dm || {});
  if (U.started) return;
  U.started = true;

  const ct = document.contentType || 'text/html';
  if (!/^(text\/html|application\/xhtml\+xml|text\/plain)$/.test(ct)) return;
  if (!document.documentElement) return;

  const { DynamicEngine, FilterEngine, cleanupStale, isTop } = U.engine;
  const HINT_KEY = '__darkshift';

  let engine = null;
  let engineMode = 'off';
  let engineAdjust = '';
  let config = null;
  let lastReported = null;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  cleanupStale();

  function effectiveMode(cfg) {
    if (!cfg) return 'off';
    if (cfg.followSystem && !systemDark.matches) return 'off';
    return cfg.mode;
  }

  function apply(cfg) {
    config = cfg;
    const mode = effectiveMode(cfg);
    const adjustKey = JSON.stringify(cfg.adjust);
    if (mode !== engineMode) {
      if (engine) engine.stop();
      engine = null;
      engineMode = mode;
      if (mode === 'dark') engine = new DynamicEngine(cfg.adjust);
      else if (mode === 'filter') engine = new FilterEngine(cfg.adjust);
      if (engine) engine.start();
    } else if (engine && adjustKey !== engineAdjust) {
      engine.update(cfg.adjust);
    }
    engineAdjust = adjustKey;
    U.overlay.set(cfg.adjust, mode !== 'off');
    report(mode);
  }

  function report(mode) {
    if (!isTop || mode === lastReported) return;
    lastReported = mode;
    send({ type: 'status', mode });
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // Tab-scoped hint (sessionStorage is per tab + origin) lets reloads go dark before the worker answers.
  function readHint() {
    try {
      const raw = sessionStorage.getItem(HINT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeHint(cfg) {
    try {
      sessionStorage.setItem(HINT_KEY, JSON.stringify(cfg));
    } catch (e) {
      /* storage blocked */
    }
  }

  const hint = readHint();
  if (hint && hint.mode && hint.adjust) apply(hint);

  send({ type: 'getConfig' }).then((cfg) => {
    if (!cfg) return;
    writeHint(cfg);
    apply(cfg);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'config' && msg.config) {
      writeHint(msg.config);
      apply(msg.config);
    }
  });

  systemDark.addEventListener('change', () => config && apply(config));

  // When the extension is reloaded or updated this script is orphaned (chrome.runtime.id
  // disappears): tidy up so the new instance starts from a clean page.
  const orphanCheck = setInterval(() => {
    let alive = false;
    try {
      alive = !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      alive = false;
    }
    if (alive) return;
    clearInterval(orphanCheck);
    if (engine) engine.stop();
    engine = null;
    engineMode = 'off';
    U.overlay.set({}, false);
  }, 2000);
})();
