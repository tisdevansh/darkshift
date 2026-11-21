/*
 * DarkShift — CSS compiler.
 * Turns page CSS rules into "override" rules that keep the same selectors but swap every
 * color for its dark-palette counterpart. Compiled output is a template (strings + color
 * tokens) so changing brightness/contrast only re-renders text instead of re-parsing CSS.
 */
'use strict';
(() => {
  const U = (globalThis.__dm = globalThis.__dm || {});
  if (U.css) return;
  const { parseColor, isNamedColor } = U.color;

  const VAR_PREFIX = '--dm-';
  const VAR_ROLES = ['bg', 'fg', 'bd', 'sh'];

  // Longhand property -> role.
  const ROLES = Object.create(null);
  for (const p of ['background-color', 'background-image']) ROLES[p] = 'bg';
  for (const p of [
    'color', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'caret-color',
    'text-decoration-color', 'text-emphasis-color', '-webkit-text-emphasis-color', 'fill', 'stroke',
  ]) ROLES[p] = 'fg';
  for (const side of ['top', 'right', 'bottom', 'left', 'block-start', 'block-end', 'inline-start', 'inline-end']) {
    ROLES[`border-${side}-color`] = 'bd';
  }
  for (const p of ['outline-color', 'column-rule-color', 'scrollbar-color']) ROLES[p] = 'bd';
  for (const p of ['box-shadow', 'text-shadow']) ROLES[p] = 'sh';

  // Shorthands that only appear in CSSOM when their value contains var() (longhands are then '').
  const SHORTHANDS = {
    background: 'bg',
    border: 'bd', 'border-top': 'bd', 'border-right': 'bd', 'border-bottom': 'bd', 'border-left': 'bd',
    'border-color': 'bd', 'border-block': 'bd', 'border-inline': 'bd', 'border-block-color': 'bd',
    'border-inline-color': 'bd', 'border-block-start': 'bd', 'border-block-end': 'bd',
    'border-inline-start': 'bd', 'border-inline-end': 'bd',
    outline: 'bd', 'column-rule': 'bd', 'text-decoration': 'fg', '-webkit-text-stroke': 'fg',
  };

  const COLOR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix']);
  const NOT_COLOR = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none']);

  const isIdentChar = (c) => c !== undefined && (/[\w-]/.test(c) || c.charCodeAt(0) > 127 || c === '\\');
  const isIdentStart = (c, next) =>
    c !== undefined && (/[a-zA-Z_]/.test(c) || c.charCodeAt(0) > 127 || (c === '-' && next !== undefined && /[a-zA-Z_-]/.test(next)));

  function skipString(s, i) {
    const q = s[i];
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') j += 2;
      else if (s[j] === q) return j + 1;
      else j++;
    }
    return s.length;
  }

  function matchParen(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"' || ch === "'") {
        j = skipString(s, j) - 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return j;
    }
    return -1;
  }

  function topLevelComma(s) {
    let depth = 0;
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"' || ch === "'") {
        j = skipString(s, j) - 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) return j;
    }
    return -1;
  }

  function absolutizeUrl(full, inner, base) {
    if (!base) return full;
    let u = inner.trim();
    if ((u[0] === '"' || u[0] === "'") && u[u.length - 1] === u[0]) u = u.slice(1, -1);
    if (!u || /^(data:|blob:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(u)) return full;
    try {
      return `url("${new URL(u, base).href.replace(/["\\]/g, '\\$&')}")`;
    } catch (e) {
      return full;
    }
  }

  // ---- value compilation -------------------------------------------------------------

  function emitColor(ctx, c, role, f) {
    if (ctx.buf) {
      ctx.parts.push(ctx.buf);
      ctx.buf = '';
    }
    ctx.parts.push({ c, r: role, f });
    ctx.changed = true;
  }

  function emitVar(inner, role, base, ctx) {
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!name.startsWith('--')) {
      ctx.buf += `var(${inner})`;
      return;
    }
    ctx.buf += `var(${VAR_PREFIX}${role}${name}, var(${name}`;
    if (comma >= 0) {
      ctx.buf += ',';
      walk(inner.slice(comma + 1), role, base, ctx);
    }
    ctx.buf += '))';
    ctx.changed = true;
  }

  function walk(s, role, base, ctx) {
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const e = skipString(s, i);
        ctx.buf += s.slice(i, e);
        i = e;
        continue;
      }
      if (ch === '#') {
        let j = i + 1;
        while (j < n && /[0-9a-fA-F]/.test(s[j])) j++;
        const len = j - i - 1;
        if ((len === 3 || len === 4 || len === 6 || len === 8) && !isIdentChar(s[j])) {
          const c = parseColor(s.slice(i, j));
          if (c) {
            emitColor(ctx, c, role);
            i = j;
            continue;
          }
        }
        ctx.buf += ch;
        i++;
        continue;
      }
      if (isIdentStart(ch, s[i + 1])) {
        let j = i;
        while (j < n && isIdentChar(s[j])) j += s[j] === '\\' ? 2 : 1;
        const ident = s.slice(i, j);
        const lower = ident.toLowerCase();
        if (s[j] === '(') {
          const end = matchParen(s, j);
          if (end < 0) {
            ctx.buf += s.slice(i);
            return;
          }
          const inner = s.slice(j + 1, end);
          if (lower === 'url') {
            ctx.buf += absolutizeUrl(s.slice(i, end + 1), inner, base);
          } else if (lower === 'var') {
            emitVar(inner, role, base, ctx);
          } else if (COLOR_FNS.has(lower) && !/var\(/i.test(inner)) {
            const c = parseColor(s.slice(i, end + 1));
            if (c) emitColor(ctx, c, role);
            else ctx.buf += s.slice(i, end + 1);
          } else {
            // Gradients, color functions containing var(), light-dark(), calc()...: recurse.
            ctx.buf += ident + '(';
            walk(inner, role, base, ctx);
            ctx.buf += ')';
          }
          i = end + 1;
          continue;
        }
        if (!NOT_COLOR.has(lower) && isNamedColor(lower)) emitColor(ctx, parseColor(lower), role);
        else ctx.buf += ident;
        i = j;
        continue;
      }
      ctx.buf += ch;
      i++;
    }
  }

  /** Compile a property value for a role. Returns a template array, or null if nothing changed. */
  function compileValue(value, role, base) {
    const ctx = { parts: [], buf: '', changed: false };
    walk(value, role, base, ctx);
    if (!ctx.changed) return null;
    if (ctx.buf) ctx.parts.push(ctx.buf);
    return ctx.parts;
  }

  // Channel triplets used as rgb(var(--x)) / hsl(var(--x)) (Bootstrap, Tailwind, shadcn...).
  const RGB_TRIPLET = /^(\d{1,3}(?:\.\d+)?)(\s*,\s*|\s+)(\d{1,3}(?:\.\d+)?)\2(\d{1,3}(?:\.\d+)?)$/;
  const HSL_TRIPLET = /^(-?\d*\.?\d+)(?:deg)?\s+(\d*\.?\d+)%\s+(\d*\.?\d+)%$/;

  function triplet(v) {
    let m = RGB_TRIPLET.exec(v);
    if (m) {
      const c = [+m[1], +m[3], +m[4]];
      if (c.every((x) => x <= 255)) return { c: [...c.map(Math.round), 1], f: m[2].includes(',') ? 'c' : 's' };
    }
    m = HSL_TRIPLET.exec(v);
    if (m) {
      const rgb = U.color.hslToRgb(+m[1], Math.min(+m[2], 100) / 100, Math.min(+m[3], 100) / 100);
      return { c: [...rgb.map(Math.round), 1], f: 'h' };
    }
    return null;
  }

  // A custom property becomes one role-specific copy per role: --dm-bg--x, --dm-fg--x, ...
  function compileCustomProp(name, value, base, imp, out) {
    const v = value.trim();
    if (!v) return false;
    const tri = triplet(v);
    let any = false;
    for (const role of VAR_ROLES) {
      const parts = tri ? [{ c: tri.c, r: role, f: tri.f }] : compileValue(v, role, base);
      if (parts) {
        out.push({ p: VAR_PREFIX + role + name, v: parts, imp });
        any = true;
      }
    }
    return any;
  }

  /**
   * Compile a CSSStyleDeclaration. With keepAll (keyframes) non-color declarations are kept
   * verbatim. Returns { d: decls, changed } or null when nothing is worth emitting.
   */
  function compileStyle(style, base, keepAll) {
    const d = [];
    let changed = false;
    let pending = false;
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      const imp = style.getPropertyPriority(p) === 'important';
      const val = style.getPropertyValue(p);
      if (p.startsWith('--')) {
        if (compileCustomProp(p, val, base, imp, d)) changed = true;
        if (keepAll) d.push({ p, v: [val], imp });
        continue;
      }
      const role = ROLES[p];
      if (val === '') {
        pending = true;
        continue;
      }
      const parts = role ? compileValue(val, role, base) : null;
      if (parts) {
        d.push({ p, v: parts, imp });
        changed = true;
      } else if (keepAll) {
        d.push({ p, v: [val], imp });
      }
    }
    if (pending) {
      for (const sh in SHORTHANDS) {
        const v = style.getPropertyValue(sh);
        if (!v || !v.includes('var(')) continue;
        const imp = style.getPropertyPriority(sh) === 'important';
        const parts = compileValue(v, SHORTHANDS[sh], base);
        if (parts) {
          d.push({ p: sh, v: parts, imp });
          changed = true;
        } else if (keepAll) {
          d.push({ p: sh, v: [v], imp });
        }
      }
    }
    return changed ? { d, changed } : null;
  }

  // ---- rule compilation ----------------------------------------------------------------

  const leafCache = new WeakMap();
  const has = (name) => typeof globalThis[name] === 'function';

  function groupPrelude(rule) {
    if (rule instanceof CSSMediaRule) return '@media ' + rule.media.mediaText;
    if (rule instanceof CSSSupportsRule) return '@supports ' + rule.conditionText;
    if (has('CSSLayerBlockRule') && rule instanceof CSSLayerBlockRule) return rule.name ? '@layer ' + rule.name : '@layer';
    if (has('CSSContainerRule') && rule instanceof CSSContainerRule && rule.containerQuery !== undefined) {
      return '@container ' + (rule.containerName ? rule.containerName + ' ' : '') + rule.containerQuery;
    }
    if (has('CSSScopeRule') && rule instanceof CSSScopeRule) {
      return '@scope' + (rule.start ? ` (${rule.start})` : '') + (rule.end ? ` to (${rule.end})` : '');
    }
    if (has('CSSStartingStyleRule') && rule instanceof CSSStartingStyleRule) return '@starting-style';
    const text = rule.cssText;
    const brace = text.indexOf('{');
    return brace > 0 ? text.slice(0, brace).trim() : null;
  }

  /**
   * Compile a CSSRuleList into nodes:
   *   {t:'s', sel, d, k}  style rule (k = nested rules)
   *   {t:'n', d}          nested declarations
   *   {t:'g', pre, k}     grouping at-rule
   *   {t:'k', pre, f}     keyframes
   * `env` = { base, depth, remote(url) -> nodes|null } for @import handling.
   */
  function compileRules(rules, env, out = []) {
    for (let i = 0; i < rules.length; i++) {
      let node = null;
      try {
        node = compileRule(rules[i], env);
      } catch (e) {
        node = null;
      }
      if (node) out.push(node);
    }
    return out;
  }

  function compileRule(rule, env) {
    if (rule instanceof CSSStyleRule) {
      const kidsList = rule.cssRules;
      const hasKids = kidsList && kidsList.length > 0;
      if (!hasKids && leafCache.has(rule)) return leafCache.get(rule);
      const st = compileStyle(rule.style, env.base, false);
      const k = hasKids ? compileRules(kidsList, env) : null;
      const node = st || (k && k.length) ? { t: 's', sel: rule.selectorText, d: st ? st.d : null, k } : null;
      if (!hasKids) leafCache.set(rule, node);
      return node;
    }
    if (has('CSSNestedDeclarations') && rule instanceof CSSNestedDeclarations) {
      const st = compileStyle(rule.style, env.base, false);
      return st ? { t: 'n', d: st.d } : null;
    }
    if (rule instanceof CSSImportRule) return compileImport(rule, env);
    if (rule instanceof CSSKeyframesRule) {
      const f = [];
      let changed = false;
      for (let i = 0; i < rule.cssRules.length; i++) {
        const kf = rule.cssRules[i];
        const st = compileStyle(kf.style, env.base, true);
        if (st) changed = true;
        f.push({ key: kf.keyText, d: st ? st.d : rawDecls(kf.style) });
      }
      return changed ? { t: 'k', pre: '@keyframes ' + CSS.escape(rule.name), f } : null;
    }
    if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) {
      const pre = groupPrelude(rule);
      if (!pre) return null;
      const k = compileRules(rule.cssRules, env);
      return k.length ? { t: 'g', pre, k } : null;
    }
    return null;
  }

  function rawDecls(style) {
    const d = [];
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      const v = style.getPropertyValue(p);
      if (v) d.push({ p, v: [v], imp: style.getPropertyPriority(p) === 'important' });
    }
    return d;
  }

  function wrapImport(nodes, layerName, mediaText, supportsText) {
    let k = nodes;
    if (!k || !k.length) return null;
    if (mediaText && mediaText !== 'all') k = [{ t: 'g', pre: '@media ' + mediaText, k }];
    if (supportsText) k = [{ t: 'g', pre: '@supports (' + supportsText + ')', k }];
    if (layerName !== null && layerName !== undefined) k = [{ t: 'g', pre: layerName ? '@layer ' + layerName : '@layer', k }];
    return k.length === 1 ? k[0] : { t: 'g', pre: '', k };
  }

  function compileImport(rule, env) {
    if (env.depth > 4) return null;
    const media = rule.media ? rule.media.mediaText : '';
    let href;
    try {
      href = new URL(rule.href, env.base).href;
    } catch (e) {
      return null;
    }
    let nodes = null;
    let rules = null;
    try {
      rules = rule.styleSheet && rule.styleSheet.cssRules;
    } catch (e) {
      rules = null;
    }
    if (rules) nodes = compileRules(rules, { ...env, base: href, depth: env.depth + 1 });
    else if (env.remote) nodes = env.remote(href, env.depth + 1);
    return wrapImport(nodes, rule.layerName, media, rule.supportsText);
  }

  /**
   * Compile raw CSS text (cross-origin sheets fetched by the background worker).
   * replaceSync() drops @import rules, so imports are extracted first and resolved via env.remote.
   */
  function compileText(text, env) {
    const out = [];
    const importRe = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi;
    let m;
    // @import must precede other rules (only @charset/@layer statements may come before).
    const head = text.slice(0, 20000);
    while ((m = importRe.exec(head))) {
      if (env.depth > 4 || !env.remote) break;
      let href;
      try {
        href = new URL(m[2], env.base).href;
      } catch (e) {
        continue;
      }
      const rest = m[3].trim();
      const layer = /\blayer\(([^)]*)\)|\blayer\b/.exec(rest);
      const supports = /supports\(([^)]*)\)/.exec(rest);
      const media = rest.replace(/\blayer\([^)]*\)|\blayer\b|supports\([^)]*\)/g, '').trim();
      const node = wrapImport(env.remote(href, env.depth + 1), layer ? layer[1] || '' : null, media, supports ? supports[1] : '');
      if (node) out.push(node);
    }
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(text);
    } catch (e) {
      return out;
    }
    return compileRules(sheet.cssRules, env, out);
  }

  // ---- rendering -------------------------------------------------------------------------

  function renderDecls(d, T, forceImportant) {
    let s = '';
    if (!d) return s;
    for (const decl of d) {
      let v = '';
      for (const part of decl.v) v += typeof part === 'string' ? part : T.str(part.c, part.r, part.f);
      s += decl.p + ':' + v + (decl.imp || forceImportant ? ' !important;' : ';');
    }
    return s;
  }

  function renderNode(n, T) {
    if (n._v === T.version) return n._s;
    let s = '';
    switch (n.t) {
      case 's':
        s = n.sel + '{' + renderDecls(n.d, T) + (n.k ? renderNodes(n.k, T) : '') + '}';
        break;
      case 'n':
        s = renderDecls(n.d, T);
        break;
      case 'g': {
        const inner = renderNodes(n.k, T);
        s = inner ? (n.pre ? n.pre + '{' + inner + '}' : inner) : '';
        break;
      }
      case 'k':
        s = n.pre + '{';
        for (const f of n.f) s += f.key + '{' + renderDecls(f.d, T) + '}';
        s += '}';
        break;
    }
    n._v = T.version;
    n._s = s;
    return s;
  }

  function renderNodes(nodes, T) {
    let s = '';
    for (const n of nodes) s += renderNode(n, T);
    return s;
  }

  U.css = {
    compileValue,
    compileStyle,
    compileRules,
    compileText,
    renderNodes,
    renderDecls,
    VAR_PREFIX,
  };
})();
