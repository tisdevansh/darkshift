/*
 * DarkShift — color parsing and dark-palette transformation.
 * Runs in the content-script isolated world. Exposes globalThis.__dm.color.
 */
'use strict';
(() => {
  const U = (globalThis.__dm = globalThis.__dm || {});
  if (U.color) return;

  const NAMED_SRC =
    'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,' +
    'black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,' +
    'chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,' +
    'darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
    'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
    'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
    'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,' +
    'dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
    'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,' +
    'honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
    'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,' +
    'lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
    'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
    'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,' +
    'mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,' +
    'midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,' +
    'oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
    'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,' +
    'pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,' +
    'sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
    'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,' +
    'violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

  const NAMED = new Map();
  for (const pair of NAMED_SRC.split(',')) {
    const [name, hex] = pair.split(':');
    NAMED.set(name, [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1]);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function parseHex(h) {
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    const n = h.length;
    if (n === 3 || n === 4) {
      const c = (i) => parseInt(h[i] + h[i], 16);
      return [c(0), c(1), c(2), n === 4 ? c(3) / 255 : 1];
    }
    if (n === 6 || n === 8) {
      const c = (i) => parseInt(h.slice(i, i + 2), 16);
      return [c(0), c(2), c(4), n === 8 ? c(6) / 255 : 1];
    }
    return null;
  }

  // Number with optional %; `full` is the value that 100% maps to.
  function num(tok, full) {
    if (tok === 'none') return 0;
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * full;
    return parseFloat(tok);
  }

  // Percentage for hsl/hwb; modern syntax allows bare numbers meaning percent.
  function pct(tok) {
    if (tok === 'none') return 0;
    return parseFloat(tok) / 100;
  }

  function hue(tok) {
    if (tok === 'none') return 0;
    const v = parseFloat(tok);
    if (tok.endsWith('turn')) return v * 360;
    if (tok.endsWith('grad')) return v * 0.9;
    if (tok.endsWith('rad')) return (v * 180) / Math.PI;
    return v;
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) {
      const v = l * 255;
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  function parseFn(name, inner) {
    const parts = inner.trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const a = parts.length === 4 ? clamp(num(parts[3], 1), 0, 1) : 1;
    let rgb;
    if (name === 'rgb' || name === 'rgba') {
      rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
    } else if (name === 'hsl' || name === 'hsla') {
      rgb = hslToRgb(hue(parts[0]), clamp(pct(parts[1]), 0, 1), clamp(pct(parts[2]), 0, 1));
    } else if (name === 'hwb') {
      let w = clamp(pct(parts[1]), 0, 1);
      let bl = clamp(pct(parts[2]), 0, 1);
      if (w + bl >= 1) {
        const g = (w / (w + bl)) * 255;
        rgb = [g, g, g];
      } else {
        rgb = hslToRgb(hue(parts[0]), 1, 0.5).map((c) => c * (1 - w - bl) + w * 255);
      }
    } else {
      return null;
    }
    if (rgb.some((c) => !Number.isFinite(c)) || !Number.isFinite(a)) return null;
    return [clamp(Math.round(rgb[0]), 0, 255), clamp(Math.round(rgb[1]), 0, 255), clamp(Math.round(rgb[2]), 0, 255), a];
  }

  // Resolve any other color syntax (lab, oklch, color-mix, color()...) by painting one pixel.
  let ctx2d = null;
  function canvasParse(str) {
    try {
      if (!ctx2d) ctx2d = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      ctx2d.fillStyle = '#010203';
      ctx2d.fillStyle = str;
      if (ctx2d.fillStyle === '#010203') {
        ctx2d.fillStyle = '#030201';
        ctx2d.fillStyle = str;
        if (ctx2d.fillStyle === '#030201') return null;
      }
      ctx2d.clearRect(0, 0, 1, 1);
      ctx2d.fillRect(0, 0, 1, 1);
      const d = ctx2d.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch (e) {
      return null;
    }
  }

  const BASIC_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb']);
  const CANVAS_FNS = new Set(['lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix']);
  const parseCache = new Map();

  /** Parse a CSS color string into [r, g, b, a] (0-255, 0-1) or null. */
  function parseColor(input) {
    const s = input.trim().toLowerCase();
    if (parseCache.has(s)) return parseCache.get(s);
    let res = null;
    if (s[0] === '#') {
      res = parseHex(s.slice(1));
    } else if (NAMED.has(s)) {
      res = NAMED.get(s).slice();
    } else if (s === 'transparent') {
      res = [0, 0, 0, 0];
    } else {
      const m = /^([a-z-]+)\(([\s\S]*)\)$/.exec(s);
      if (m && !/var\(|attr\(|env\(/.test(s)) {
        if (BASIC_FNS.has(m[1]) && !/calc\(|from\s/.test(s)) res = parseFn(m[1], m[2]);
        if (!res && (BASIC_FNS.has(m[1]) || CANVAS_FNS.has(m[1]))) res = canvasParse(s);
      }
    }
    if (parseCache.size > 8000) parseCache.clear();
    parseCache.set(s, res);
    return res;
  }

  const isNamedColor = (ident) => NAMED.has(ident);

  /*
   * Lightness mapping per role. All work in HSL lightness (0..1).
   *  bg  — backgrounds: dark colors stay, light colors flip into a dark band (white -> ~0.10).
   *  fg  — text/icons: light colors stay, dark colors flip into a light band (black -> ~0.88).
   *  bd  — borders: light borders become subtle dark lines, very dark ones lift so they stay visible.
   *  sh  — shadows: dark shadows stay, light glows flip dark.
   */
  // WCAG relative luminance of an sRGB triple (0-255).
  function luminance(rgb) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  /**
   * Move HSL lightness until luminance crosses `target`: raise=true finds the darkest l with
   * lum >= target, raise=false the lightest l with lum <= target. HSL lightness alone misjudges
   * hues (yellow looks far brighter than blue at the same l), so contrast is checked on luminance.
   */
  function fitLuminance(h, s, l, target, raise) {
    const lum = luminance(hslToRgb(h, s, l));
    if (raise ? lum >= target : lum <= target) return l;
    let lo = raise ? l : 0;
    let hi = raise ? 1 : l;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (luminance(hslToRgb(h, s, mid)) > target) hi = mid;
      else lo = mid;
    }
    return raise ? hi : lo;
  }

  const BG_MAX_LUM = 0.12; // light text (lum >= 0.25) stays >= 4.5:1 on any converted surface
  const FG_MIN_LUM = 0.25; // text stays >= 4.5:1 on the darkest surfaces

  /*
   * Lightness mapping per role (HSL lightness 0..1, then a luminance guard).
   *  bg  — backgrounds: light neutrals flip to a dark band (white -> ~0.10); colored surfaces
   *        (green "correct", red "wrong", brand buttons, badges) keep a clear, vivid tint.
   *  fg  — text/icons: dark colors flip into a light band (black -> ~0.88), hue preserved.
   *  bd  — borders: light borders become subtle dark lines, very dark ones lift to stay visible.
   *  sh  — shadows: dark shadows stay, light glows flip dark.
   */
  function mapRole(role, h, s, l, a) {
    switch (role) {
      case 'bg': {
        // Faint black overlays (hover tints like rgba(0,0,0,.05)) become faint white overlays.
        if (a <= 0.25 && s < 0.2 && l < 0.2) return [s, 1 - l];
        const chroma = s * (1 - Math.abs(2 * l - 1)); // HSL chroma, 0..1
        if (chroma < 0.08) {
          // Neutrals and near-white tints: plain dark surface, darker for lighter originals.
          const out = l <= 0.4 ? l : 0.4 - ((l - 0.4) / 0.6) * 0.3;
          return [l > 0.4 ? s * 0.6 : s, fitLuminance(h, s, out, BG_MAX_LUM, false)];
        }
        // Real colors keep their lightness (up to 0.42); pastels settle into a 0.20-0.42 band.
        const out = l < 0.55 ? Math.min(Math.max(l * 0.9, 0.18), 0.42) : Math.max(0.2, 0.42 - ((l - 0.55) / 0.3) * 0.2);
        const sat = l > 0.7 ? Math.min(s, 0.55) : s;
        return [sat, fitLuminance(h, sat, out, BG_MAX_LUM, false)];
      }
      case 'fg': {
        const out = l < 0.6 ? 0.6 + ((0.6 - l) / 0.6) * 0.28 : l;
        return [s, fitLuminance(h, s, out, FG_MIN_LUM, true)];
      }
      case 'bd':
        if (l > 0.5) return [s, 0.4 - ((l - 0.5) / 0.5) * 0.2];
        return [s, Math.max(l, 0.28)];
      case 'sh':
        if (l > 0.6) return [s, 0.4 - ((l - 0.6) / 0.4) * 0.3];
        return [s, l];
      default:
        return [s, l];
    }
  }

  let transformerVersion = 0;

  /**
   * Build a color transformer for a set of adjustments
   * (brightness/contrast/saturation 0..100, 50 = neutral).
   */
  function createTransformer(adjust) {
    const bF = 0.6 + (0.8 * adjust.brightness) / 100;
    const cF = 0.6 + (0.8 * adjust.contrast) / 100;
    const sF = adjust.saturation / 50;
    const cache = new Map();
    const version = ++transformerVersion;

    function apply(rgba, role) {
      const [h, s0, l0] = rgbToHsl(rgba[0], rgba[1], rgba[2]);
      let [s, l] = mapRole(role, h, s0, l0, rgba[3]);
      l = ((l - 0.5) * cF + 0.5) * bF;
      s *= sF;
      const rgb = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
      return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), rgba[3]];
    }

    /**
     * Format a transformed color. `fmt`: undefined -> CSS color,
     * 'c' -> "r, g, b", 's' -> "r g b", 'h' -> "h s% l%" (channel-triplet custom properties).
     */
    function str(rgba, role, fmt) {
      const key = role + (fmt || '') + rgba.join(',');
      let out = cache.get(key);
      if (out !== undefined) return out;
      const [r, g, b, a] = apply(rgba, role);
      if (fmt === 'c') out = `${r}, ${g}, ${b}`;
      else if (fmt === 's') out = `${r} ${g} ${b}`;
      else if (fmt === 'h') {
        const [h, s, l] = rgbToHsl(r, g, b);
        out = `${+h.toFixed(1)} ${+(s * 100).toFixed(1)}% ${+(l * 100).toFixed(1)}%`;
      } else out = a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
      if (cache.size > 20000) cache.clear();
      cache.set(key, out);
      return out;
    }

    return {
      version,
      apply,
      str,
      bg: str([255, 255, 255, 1], 'bg'),
      fg: str([0, 0, 0, 1], 'fg'),
      bd: str([255, 255, 255, 1], 'bd'),
    };
  }

  U.color = { parseColor, isNamedColor, rgbToHsl, hslToRgb, luminance, createTransformer, clamp };
})();
