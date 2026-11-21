/*
 * DarkShift — rendering engines.
 *  DynamicEngine: rewrites every stylesheet (incl. cross-origin, CSS-in-JS, shadow DOM and
 *                 inline styles) into dark override sheets attached via adoptedStyleSheets.
 *  FilterEngine:  classic invert + hue-rotate filter with media re-inverted.
 *  Overlay:       blue-light (warm) and dim layers on top of the page.
 */
'use strict';
(() => {
  const U = (globalThis.__dm = globalThis.__dm || {});
  if (U.engine) return;
  const { parseColor, createTransformer } = U.color;
  const { compileRules, compileText, compileStyle, renderNodes, renderDecls } = U.css;

  const MARKER = '#__dm_marker__';
  const MARKER_RULE = MARKER + '{}';
  const INLINE_ATTR = 'data-dm-i';
  const OVERLAY_TAG = 'dm-overlay';
  const isTop = (() => {
    try {
      return window.top === window;
    } catch (e) {
      return false;
    }
  })();

  const INLINE_HINT = /color|backg|border|outline|shadow|fill|stroke|caret|decoration|column-rule|--/i;
  const ATTR_SELECTOR = '[style],[bgcolor],font[color],body[text],[fill],[stroke],img';
  const COLOR_ATTRS = {
    bgcolor: { sel: (v) => `:where([bgcolor="${v}" i])`, p: 'background-color', r: 'bg' },
    color: { sel: (v) => `:where(font[color="${v}" i])`, p: 'color', r: 'fg' },
    text: { sel: (v) => `:where(body[text="${v}" i])`, p: 'color', r: 'fg' },
    fill: { sel: (v) => `:where([fill="${v}" i])`, p: 'fill', r: 'fg' },
    stroke: { sel: (v) => `:where([stroke="${v}" i])`, p: 'stroke', r: 'fg' },
  };

  /** Our own constructed sheets carry a marker rule so stale copies from an older instance can be dropped. */
  function isOwnSheet(sheet) {
    try {
      const first = sheet.cssRules[0];
      return !!first && first.selectorText === MARKER;
    } catch (e) {
      return false;
    }
  }

  function newSheet(text = '') {
    const s = new CSSStyleSheet();
    s.replaceSync(MARKER_RULE + text);
    return s;
  }

  function cssString(v) {
    return v.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
  }

  // ---- cross-origin stylesheet cache (per frame) ----------------------------------------

  const remote = new Map(); // url -> { state, text, nodes }
  let remoteListener = null;

  function fetchRemote(url) {
    const entry = { state: 'loading', text: null, nodes: null };
    remote.set(url, entry);
    chrome.runtime
      .sendMessage({ type: 'fetchCSS', url })
      .then((res) => {
        entry.state = res && res.ok ? 'ready' : 'error';
        entry.text = res && res.ok ? res.text : null;
      })
      .catch(() => {
        entry.state = 'error';
      })
      .finally(() => remoteListener && remoteListener());
  }

  /** Nodes for a cross-origin sheet, or null while loading (a rescan is triggered once ready). */
  function remoteNodes(url, depth = 0) {
    let entry = remote.get(url);
    if (!entry) {
      fetchRemote(url);
      return null;
    }
    if (entry.state !== 'ready') return null;
    if (!entry.nodes) entry.nodes = compileText(entry.text, { base: url, depth, remote: remoteNodes });
    return entry.nodes;
  }

  // ---- dark logo / icon detection ---------------------------------------------------------
  // Transparent images that are almost entirely dark (black logos, line icons) would vanish on a
  // dark page. They are sampled once per URL and, if they qualify, inverted to a light version.

  const IMG_ATTR = 'data-dm-img';
  const imageResults = new Map(); // src -> 'inv' | '' | Promise
  let imageBudget = 400;
  const SVG_SRC = /\.svg(\?|#|$)|^data:image\/svg/i;

  function classifyPixels(data) {
    let transparent = 0;
    let opaque = 0;
    let lumSum = 0;
    let dark = 0;
    let satSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 25) {
        transparent++;
        continue;
      }
      opaque++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumSum += lum;
      if (lum < 0.3) dark++;
      satSum += max ? (max - Math.min(r, g, b)) / max : 0;
    }
    const total = transparent + opaque;
    if (!opaque || opaque < total * 0.03 || transparent / total < 0.15) return '';
    return lumSum / opaque < 0.22 && dark / opaque > 0.7 && satSum / opaque < 0.4 ? 'inv' : '';
  }

  async function loadForAnalysis(src) {
    const u = new URL(src, document.baseURI);
    let url = u.href;
    if (!/^(data|blob):/.test(url) && u.origin !== location.origin) {
      const res = await chrome.runtime.sendMessage({ type: 'fetchImage', url });
      if (!res || !res.ok) return null;
      url = res.dataUrl;
    }
    const im = new Image();
    im.src = url;
    await im.decode();
    return im;
  }

  async function classifyImage(src) {
    try {
      const im = await loadForAnalysis(src);
      if (!im) return '';
      const w = im.naturalWidth || 64;
      const h = im.naturalHeight || 64;
      const scale = Math.min(1, 64 / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const ctx = new OffscreenCanvas(cw, ch).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, cw, ch);
      return classifyPixels(ctx.getImageData(0, 0, cw, ch).data);
    } catch (e) {
      return '';
    }
  }

  function inspectImage(img, engine) {
    const src = img.currentSrc || img.src;
    // Only finished images: lazy images are checked when their own load event fires.
    if (!src || !img.complete || !img.naturalWidth) return;
    if (!SVG_SRC.test(src) && img.naturalWidth * img.naturalHeight > 640000) return; // photos
    let result = imageResults.get(src);
    if (result === undefined) {
      if (imageBudget <= 0) return;
      imageBudget--;
      result = classifyImage(src).then((v) => {
        imageResults.set(src, v);
        return v;
      });
      imageResults.set(src, result);
    }
    Promise.resolve(result).then((v) => {
      if (engine.stopped || (img.currentSrc || img.src) !== src) return;
      if (v) {
        if (img.getAttribute(IMG_ATTR) !== v) img.setAttribute(IMG_ATTR, v);
      } else if (img.hasAttribute(IMG_ATTR)) {
        img.removeAttribute(IMG_ATTR);
      }
    });
  }

  // ---- per-root (document or shadow root) state -------------------------------------------

  class RootContext {
    constructor(engine, root) {
      this.engine = engine;
      this.root = root;
      this.isDoc = root === document;
      this.entries = new Map(); // source sheet -> { out, text, len, media }
      this.ordered = [];
      this.attrSheet = newSheet();
      this.attrKeys = new Set();
      this.inlineSheet = newSheet();
      this.inlineIds = new Set();
      this.ownSheets = new Set([this.attrSheet, this.inlineSheet]);
      if (this.isDoc) this.ownSheets.add(engine.finalSheet);
    }

    sourceSheets() {
      const list = [];
      for (const s of this.root.styleSheets) {
        const node = s.ownerNode;
        if (node && node.nodeType === 1 && node.hasAttribute('data-dm')) continue;
        list.push(s);
      }
      for (const s of this.root.adoptedStyleSheets || []) {
        if (!this.ownSheets.has(s) && !this.engine.allOwn.has(s) && !isOwnSheet(s)) list.push(s);
      }
      return list;
    }

    /** deep=true recompiles every accessible sheet (CSSOM edits keep the rule count). */
    scan(deep) {
      const T = this.engine.T;
      const sources = this.sourceSheets();
      const seen = new Set();
      let orderChanged = sources.length !== this.ordered.length;
      sources.forEach((src, i) => {
        seen.add(src);
        let e = this.entries.get(src);
        if (!e) {
          e = { out: newSheet(), text: null, len: -1, version: -1 };
          this.entries.set(src, e);
          this.engine.allOwn.add(e.out);
          orderChanged = true;
        }
        if (this.ordered[i] !== src) orderChanged = true;
        this.updateEntry(src, e, deep, T);
      });
      for (const [src, e] of this.entries) {
        if (!seen.has(src)) {
          this.entries.delete(src);
          this.engine.allOwn.delete(e.out);
          orderChanged = true;
        }
      }
      this.ordered = sources;
      this.sync(orderChanged);
    }

    updateEntry(src, e, deep, T) {
      let rules = null;
      try {
        rules = src.cssRules;
      } catch (err) {
        rules = null;
      }
      const len = rules ? rules.length : -2;
      const media = src.media ? src.media.mediaText : '';
      if (!deep && len === e.len && e.version === T.version && media === e.media && !(len === -2 && e.pendingRemote)) {
        e.out.disabled = src.disabled;
        return;
      }
      let nodes;
      e.pendingRemote = false;
      const base = src.href || document.baseURI;
      if (rules) {
        nodes = compileRules(rules, { base, depth: 0, remote: remoteNodes });
      } else if (src.href) {
        nodes = remoteNodes(src.href);
        if (!nodes) {
          nodes = [];
          e.pendingRemote = remote.get(src.href)?.state === 'loading';
        }
      } else {
        nodes = [];
      }
      let text = renderNodes(nodes, T);
      if (text && media && media !== 'all') text = `@media ${media}{${text}}`;
      if (text !== e.text) {
        e.text = text;
        try {
          e.out.replaceSync(MARKER_RULE + text);
        } catch (err) {
          /* ignore */
        }
      }
      e.len = len;
      e.media = media;
      e.version = T.version;
      e.out.disabled = src.disabled;
    }

    /** Keep our sheets at the end of adoptedStyleSheets, in source order. */
    sync(force) {
      const current = this.root.adoptedStyleSheets || [];
      const ours = [];
      for (const src of this.ordered) {
        const e = this.entries.get(src);
        if (e) ours.push(e.out);
      }
      ours.push(this.attrSheet, this.inlineSheet);
      if (this.isDoc) ours.push(this.engine.finalSheet);
      if (!force && current.length >= ours.length) {
        let ok = true;
        const offset = current.length - ours.length;
        for (let i = 0; i < ours.length && ok; i++) ok = current[offset + i] === ours[i];
        if (ok) return;
      }
      const foreign = current.filter((s) => !this.ownSheets.has(s) && !this.engine.allOwn.has(s) && !isOwnSheet(s));
      try {
        this.root.adoptedStyleSheets = [...foreign, ...ours];
      } catch (err) {
        /* ignore */
      }
    }

    // -- inline styles and legacy color attributes --

    processElement(el) {
      if (el.localName === OVERLAY_TAG) return;
      const engine = this.engine;
      if (el.localName === 'img') inspectImage(el, engine);
      if (el.hasAttribute('style')) {
        const text = el.getAttribute('style');
        let id = '';
        if (text && INLINE_HINT.test(text)) {
          let rec = engine.inlineCache.get(text);
          if (rec === undefined && engine.inlineCache.size < 20000) {
            const st = compileStyle(el.style, document.baseURI, false);
            rec = st ? { id: String(++engine.inlineSeq), d: st.d } : null;
            engine.inlineCache.set(text, rec);
            if (rec) engine.inlineById.set(rec.id, rec);
          }
          if (rec) {
            id = rec.id;
            if (!this.inlineIds.has(id)) {
              this.inlineIds.add(id);
              this.insertInline(rec);
            }
          }
        }
        if (id) {
          if (el.getAttribute(INLINE_ATTR) !== id) el.setAttribute(INLINE_ATTR, id);
        } else if (el.hasAttribute(INLINE_ATTR)) {
          el.removeAttribute(INLINE_ATTR);
        }
      } else if (el.hasAttribute(INLINE_ATTR)) {
        el.removeAttribute(INLINE_ATTR);
      }
      for (const name in COLOR_ATTRS) {
        if (!el.hasAttribute(name)) continue;
        if (name === 'color' && el.localName !== 'font') continue;
        if (name === 'text' && el.localName !== 'body') continue;
        this.addAttrRule(name, el.getAttribute(name));
      }
    }

    insertInline(rec) {
      try {
        const sheet = this.inlineSheet;
        sheet.insertRule(`[${INLINE_ATTR}="${rec.id}"]{${renderDecls(rec.d, this.engine.T, true)}}`, sheet.cssRules.length);
      } catch (err) {
        /* ignore */
      }
    }

    addAttrRule(name, raw) {
      const value = (raw || '').trim();
      const key = name + '\u0000' + value;
      if (!value || this.attrKeys.has(key)) return;
      this.attrKeys.add(key);
      let c = parseColor(value);
      if (!c && /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) c = parseColor('#' + value);
      if (!c) return;
      const def = COLOR_ATTRS[name];
      const rule = `${def.sel(cssString(value))}{${def.p}:${this.engine.T.str(c, def.r)}}`;
      try {
        this.attrSheet.insertRule(rule, this.attrSheet.cssRules.length);
      } catch (err) {
        /* ignore */
      }
    }

    rebuildInlineAndAttrs() {
      const T = this.engine.T;
      let text = '';
      for (const id of this.inlineIds) {
        const rec = this.engine.inlineById.get(id);
        if (rec) text += `[${INLINE_ATTR}="${id}"]{${renderDecls(rec.d, T, true)}}`;
      }
      this.inlineSheet.replaceSync(MARKER_RULE + text);
      const keys = [...this.attrKeys];
      this.attrKeys.clear();
      this.attrSheet.replaceSync(MARKER_RULE);
      for (const key of keys) {
        const [name, value] = key.split('\u0000');
        this.addAttrRule(name, value);
      }
    }

    processTree(rootNode) {
      if (rootNode.nodeType === 1) {
        if (rootNode.matches(ATTR_SELECTOR)) this.processElement(rootNode);
      }
      if (rootNode.querySelectorAll) {
        for (const el of rootNode.querySelectorAll(ATTR_SELECTOR)) this.processElement(el);
      }
      this.engine.findShadowRoots(rootNode);
    }

    destroy() {
      for (const e of this.entries.values()) this.engine.allOwn.delete(e.out);
      try {
        const current = this.root.adoptedStyleSheets || [];
        this.root.adoptedStyleSheets = current.filter((s) => !this.ownSheets.has(s) && !isOwnSheet(s));
      } catch (err) {
        /* ignore */
      }
      for (const el of this.root.querySelectorAll(`[${INLINE_ATTR}]`)) el.removeAttribute(INLINE_ATTR);
      for (const el of this.root.querySelectorAll(`[${IMG_ATTR}]`)) el.removeAttribute(IMG_ATTR);
      this.entries.clear();
    }
  }

  // ---- dynamic engine ------------------------------------------------------------------------

  class DynamicEngine {
    constructor(adjust) {
      this.adjust = adjust;
      this.T = createTransformer(adjust);
      this.finalSheet = newSheet();
      this.allOwn = new Set();
      this.roots = new Map();
      this.inlineCache = new Map();
      this.inlineById = new Map();
      this.inlineSeq = 0;
      this.loading = document.readyState === 'loading';
      this.pendingElements = new Set();
      this.pendingRoots = new Set();
      this.scanQueued = false;
      this.deepQueued = false;
      this.elementsQueued = false;
      this.hidden = false;
      this.dirtyWhileHidden = false;
      this.styleObserver = new MutationObserver(() => this.queueScan(false));
      this.observedStyles = new WeakSet();
      this.observer = new MutationObserver((records) => this.onMutations(records));
      this.onCssEvent = () => this.queueScan(true);
      this.onShadowEvent = (e) => {
        const host = e.composedPath()[0];
        if (host && host.shadowRoot) this.addRoot(host.shadowRoot);
      };
      this.onLoadEvent = (e) => {
        const t = e.target;
        if (!t) return;
        if (t.localName === 'link') this.queueScan(false);
        else if (t.localName === 'img' && e.type === 'load') inspectImage(t, this);
      };
      this.onVisibility = () => {
        this.hidden = document.hidden;
        if (!this.hidden && this.dirtyWhileHidden) {
          this.dirtyWhileHidden = false;
          this.rerenderAll();
        }
      };
      this.onReady = () => {
        this.queueScan(true);
        this.processTreeAll();
        requestAnimationFrame(() => this.finishLoading());
      };
    }

    start() {
      // Imports nested in same-origin sheets keep the rule count, so a ready remote needs a deep scan.
      remoteListener = () => this.queueScan(true);
      this.renderFinal();
      this.addRoot(document);
      document.addEventListener('dm:css', this.onCssEvent, true);
      document.addEventListener('dm:shadow', this.onShadowEvent, true);
      document.addEventListener('load', this.onLoadEvent, true);
      document.addEventListener('error', this.onLoadEvent, true);
      document.addEventListener('visibilitychange', this.onVisibility);
      if (this.loading) {
        document.addEventListener('DOMContentLoaded', this.onReady, { once: true });
        this.loadingTimer = setTimeout(() => this.finishLoading(), 3000);
      }
      this.poll = setInterval(() => {
        if (document.hidden) return;
        this.scanAll(false);
        if (isTop) U.overlay.ensure();
      }, 1500);
    }

    stop() {
      this.stopped = true;
      clearInterval(this.poll);
      clearTimeout(this.loadingTimer);
      this.observer.disconnect();
      this.styleObserver.disconnect();
      document.removeEventListener('dm:css', this.onCssEvent, true);
      document.removeEventListener('dm:shadow', this.onShadowEvent, true);
      document.removeEventListener('load', this.onLoadEvent, true);
      document.removeEventListener('error', this.onLoadEvent, true);
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('DOMContentLoaded', this.onReady);
      for (const ctx of this.roots.values()) ctx.destroy();
      this.roots.clear();
      remoteListener = null;
    }

    update(adjust) {
      this.adjust = adjust;
      this.T = createTransformer(adjust);
      this.renderFinal();
      if (document.hidden) this.dirtyWhileHidden = true;
      else this.rerenderAll();
    }

    rerenderAll() {
      for (const ctx of this.roots.values()) {
        ctx.scan(false);
        ctx.rebuildInlineAndAttrs();
      }
    }

    finishLoading() {
      if (!this.loading) return;
      this.loading = false;
      clearTimeout(this.loadingTimer);
      this.renderFinal();
    }

    renderFinal() {
      const T = this.T;
      let css = `:root{color-scheme:dark !important}`;
      css += isTop ? `:where(:root){background-color:${T.bg};color:${T.fg}}` : `:where(:root){color:${T.fg}}`;
      css += `::placeholder{opacity:.7}`;
      css += `img[${IMG_ATTR}="inv"]{filter:invert(.88) hue-rotate(180deg) !important}`;
      const img = this.adjust.images || 0;
      if (img > 0) css += `img,picture>source,svg image{filter:brightness(${(1 - img / 200).toFixed(3)}) contrast(1.05)}`;
      if (this.loading) {
        // Flash guard until the page's stylesheets have been converted.
        css +=
          `html,body{background-color:${isTop ? T.bg : 'transparent'} !important}` +
          `body :not(img):not(video):not(canvas):not(svg):not(svg *):not(iframe):not(picture){` +
          `background-color:transparent !important;color:${T.fg} !important;border-color:${T.bd} !important}`;
      }
      try {
        this.finalSheet.replaceSync(MARKER_RULE + css);
      } catch (e) {
        /* ignore */
      }
    }

    addRoot(root) {
      if (this.roots.has(root)) return;
      const ctx = new RootContext(this, root);
      this.roots.set(root, ctx);
      this.observer.observe(root === document ? document.documentElement || document : root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'bgcolor', 'color', 'text', 'fill', 'stroke', 'media', 'disabled', 'rel', 'href', 'src', 'srcset'],
      });
      this.observeStyleElements(root);
      ctx.scan(true);
      ctx.processTree(root === document ? document.documentElement || document : root);
    }

    observeStyleElements(root) {
      for (const el of root.querySelectorAll('style')) this.observeStyle(el);
    }

    observeStyle(el) {
      if (this.observedStyles.has(el)) return;
      this.observedStyles.add(el);
      this.styleObserver.observe(el, { childList: true, characterData: true, subtree: true });
    }

    findShadowRoots(node) {
      if (node.nodeType === 1 && node.shadowRoot) this.addRoot(node.shadowRoot);
      if (!node.querySelectorAll || !node.firstElementChild) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = walker.nextNode())) if (el.shadowRoot && !this.roots.has(el.shadowRoot)) this.addRoot(el.shadowRoot);
    }

    rootOf(node) {
      const r = node.getRootNode ? node.getRootNode() : document;
      return this.roots.get(r) || this.roots.get(document);
    }

    onMutations(records) {
      let sheetsChanged = false;
      for (const rec of records) {
        if (rec.type === 'childList') {
          for (const node of rec.addedNodes) {
            if (node.nodeType !== 1) continue;
            const name = node.localName;
            if (name === 'style' || name === 'link') {
              sheetsChanged = true;
              if (name === 'style') this.observeStyle(node);
            } else if (node.querySelector && node.querySelector('style,link')) {
              sheetsChanged = true;
              for (const s of node.querySelectorAll('style')) this.observeStyle(s);
            }
            this.pendingRoots.add(node);
          }
          for (const node of rec.removedNodes) {
            if (node.nodeType === 1 && (node.localName === 'style' || node.localName === 'link')) sheetsChanged = true;
          }
          if (rec.target && rec.target.localName === 'style') sheetsChanged = true;
        } else if (rec.type === 'attributes') {
          const name = rec.attributeName;
          if (name === 'media' || name === 'disabled' || name === 'rel' || name === 'href') {
            const t = rec.target.localName;
            if (t === 'style' || t === 'link') sheetsChanged = true;
          } else {
            this.pendingElements.add(rec.target);
          }
        }
      }
      if (sheetsChanged) this.queueScan(false);
      if (this.pendingElements.size || this.pendingRoots.size) this.queueElements();
    }

    queueElements() {
      if (this.elementsQueued) return;
      this.elementsQueued = true;
      queueMicrotask(() => {
        this.elementsQueued = false;
        const roots = [...this.pendingRoots];
        const els = [...this.pendingElements];
        this.pendingRoots.clear();
        this.pendingElements.clear();
        for (const node of roots) {
          if (!node.isConnected) continue;
          this.rootOf(node).processTree(node);
        }
        for (const el of els) {
          if (el.isConnected) this.rootOf(el).processElement(el);
        }
      });
    }

    queueScan(deep) {
      if (deep) this.deepQueued = true;
      if (this.scanQueued) return;
      this.scanQueued = true;
      const run = () => {
        this.scanQueued = false;
        const d = this.deepQueued;
        this.deepQueued = false;
        this.scanAll(d);
      };
      // During load react fast to avoid flashes; afterwards coalesce bursts (CSS-in-JS).
      if (this.loading) queueMicrotask(run);
      else setTimeout(run, 50);
    }

    scanAll(deep) {
      for (const [root, ctx] of this.roots) {
        if (root !== document && !root.host.isConnected) {
          ctx.destroy();
          this.roots.delete(root);
          continue;
        }
        ctx.scan(deep);
      }
    }

    processTreeAll() {
      for (const [root, ctx] of this.roots) ctx.processTree(root === document ? document.documentElement : root);
    }
  }

  // ---- filter engine -------------------------------------------------------------------------

  class FilterEngine {
    constructor(adjust) {
      this.sheet = newSheet();
      this.update(adjust);
    }

    css(adjust) {
      const b = (0.6 + (0.8 * adjust.brightness) / 100).toFixed(3);
      const c = ((0.6 + (0.8 * adjust.contrast) / 100) * 0.9).toFixed(3);
      const s = (adjust.saturation / 50).toFixed(3);
      const img = adjust.images || 0;
      const media = 'img,video,canvas,embed,object,svg image';
      const imgDim = img > 0 ? ` brightness(${(1 - img / 200).toFixed(3)})` : '';
      let css = `:root{color-scheme:light !important}`;
      if (isTop) {
        css +=
          `:root{filter:invert(1) hue-rotate(180deg) brightness(${b}) contrast(${c}) saturate(${s}) !important}` +
          `:where(:root){background-color:#fff}`;
      }
      // The top frame's filter also inverts nested frames, so every frame re-inverts its own media.
      css += `${media}{filter:invert(1) hue-rotate(180deg)${imgDim} !important}`;
      css += `:root:has(:fullscreen){filter:none !important}:root:has(:fullscreen) :is(${media}){filter:none !important}`;
      return css;
    }

    update(adjust) {
      try {
        this.sheet.replaceSync(MARKER_RULE + this.css(adjust));
      } catch (e) {
        /* ignore */
      }
    }

    start() {
      this.sync();
      this.poll = setInterval(() => {
        if (document.hidden) return;
        this.sync();
        if (isTop) U.overlay.ensure();
      }, 1500);
    }

    sync() {
      const cur = document.adoptedStyleSheets;
      if (cur[cur.length - 1] === this.sheet) return;
      document.adoptedStyleSheets = [...cur.filter((s) => s !== this.sheet && !isOwnSheet(s)), this.sheet];
    }

    stop() {
      clearInterval(this.poll);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet && !isOwnSheet(s));
    }
  }

  // ---- overlays (blue-light filter and dimming), top frame only --------------------------------

  const overlay = {
    els: {},
    state: { blueLight: 0, dim: 0 },

    set(adjust, active) {
      this.state = active ? { blueLight: adjust.blueLight || 0, dim: adjust.dim || 0 } : { blueLight: 0, dim: 0 };
      this.ensure();
    },

    ensure() {
      if (!isTop) return;
      this.apply('warm', this.state.blueLight, (v) =>
        `background:rgb(255,140,40) !important;mix-blend-mode:multiply !important;opacity:${((v / 100) * 0.5).toFixed(3)} !important;`);
      this.apply('dim', this.state.dim, (v) => `background:#000 !important;opacity:${((v / 100) * 0.7).toFixed(3)} !important;`);
    },

    apply(kind, value, styleFor) {
      let el = this.els[kind];
      if (!value) {
        if (el) el.remove();
        delete this.els[kind];
        return;
      }
      if (!el) {
        el = document.createElement(OVERLAY_TAG);
        el.setAttribute('data-dm', kind);
        el.setAttribute('aria-hidden', 'true');
        this.els[kind] = el;
      }
      const style =
        'all:initial !important;position:fixed !important;inset:0 !important;' +
        'pointer-events:none !important;z-index:2147483647 !important;display:block !important;' + styleFor(value);
      if (el.getAttribute('style') !== style) el.setAttribute('style', style);
      const parent = document.documentElement;
      if (parent && (el.parentNode !== parent || parent.lastElementChild !== el)) parent.appendChild(el);
    },
  };

  /** Remove anything left behind by an older (orphaned) instance of the extension. */
  function cleanupStale() {
    try {
      const cur = document.adoptedStyleSheets;
      const kept = cur.filter((s) => !isOwnSheet(s));
      if (kept.length !== cur.length) document.adoptedStyleSheets = kept;
    } catch (e) {
      /* ignore */
    }
    for (const el of document.querySelectorAll(OVERLAY_TAG)) el.remove();
  }

  U.overlay = overlay;
  U.engine = { DynamicEngine, FilterEngine, cleanupStale, isTop, INLINE_ATTR };
})();
