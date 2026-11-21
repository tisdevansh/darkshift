/*
 * DarkShift — page-world hook (MAIN world).
 * CSS-in-JS libraries edit stylesheets through the CSSOM (insertRule, replaceSync, adopted
 * sheets), which MutationObserver cannot see. This tiny hook just announces such edits and
 * new shadow roots with DOM events; it never reads or changes page data.
 */
(() => {
  'use strict';
  if (window.__darkshiftHook) return;
  Object.defineProperty(window, '__darkshiftHook', { value: true });

  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      document.dispatchEvent(new CustomEvent('dm:css'));
    }, 0);
  };

  const wrap = (proto, name, after) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') return;
    const orig = desc.value;
    const wrapped = {
      [name](...args) {
        const result = orig.apply(this, args);
        (after || notify)(this, result);
        return result;
      },
    }[name];
    Object.defineProperty(proto, name, { ...desc, value: wrapped });
  };

  const sheetProto = window.CSSStyleSheet && CSSStyleSheet.prototype;
  for (const m of ['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replaceSync']) wrap(sheetProto, m);
  wrap(sheetProto, 'replace', (_, promise) => {
    notify();
    if (promise && promise.then) promise.then(notify, () => {});
  });
  const groupProto = window.CSSGroupingRule && CSSGroupingRule.prototype;
  for (const m of ['insertRule', 'deleteRule']) wrap(groupProto, m);

  for (const proto of [Document.prototype, window.ShadowRoot && ShadowRoot.prototype]) {
    if (!proto) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (!desc || !desc.set) continue;
    const set = desc.set;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      ...desc,
      set(v) {
        set.call(this, v);
        notify();
      },
    });
  }

  const announce = (host) => {
    if (host.isConnected) host.dispatchEvent(new CustomEvent('dm:shadow', { bubbles: true, composed: true }));
  };
  wrap(window.Element && Element.prototype, 'attachShadow', (host, root) => {
    if (root && root.mode === 'open') {
      queueMicrotask(() => announce(host));
      setTimeout(() => announce(host), 50);
    }
  });
})();
