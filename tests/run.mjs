// DarkShift end-to-end tests: loads the unpacked extension into Chromium and checks real rendering.
// Usage: npm test            (set SHOTS=dir to save screenshots, SITES=1 to also visit a few live sites)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const SHOTS = process.env.SHOTS || '';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  -> ${detail}`}`);
}

function serve(port, xport) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(FIX, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(FIX) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end();
      }
      const ext = path.extname(file);
      const type = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
      let body = fs.readFileSync(file, 'utf8');
      body = body.replaceAll('__XPORT__', String(xport));
      // Cross-origin server sends no CORS headers, like most CDNs for <link> CSS.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Relative luminance helpers evaluated in the page.
const PAGE_HELPERS = () => {
  window.__rgb = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  window.__lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  window.__style = (el, prop) => getComputedStyle(el)[prop];
};

async function colors(page, selector, root = 'document') {
  return page.evaluate(
    ({ selector, root }) => {
      let scope = document;
      if (root !== 'document') scope = document.querySelector(root).shadowRoot;
      const el = scope.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      // Walk up to find the effective (non-transparent) background.
      let bgEl = el;
      let bg = window.__rgb(getComputedStyle(bgEl).backgroundColor);
      while (bg && bg.a === 0 && bgEl.parentElement) {
        bgEl = bgEl.parentElement;
        bg = window.__rgb(getComputedStyle(bgEl).backgroundColor);
      }
      const fg = window.__rgb(cs.color);
      return { bg, fg, bgL: bg ? window.__lum(bg) : null, fgL: fg ? window.__lum(fg) : null, raw: cs.backgroundColor, filter: cs.filter };
    },
    { selector, root },
  );
}

async function setStorage(sw, area, data) {
  await sw.evaluate(({ area, data }) => chrome.storage[area].set(data), { area, data });
}

async function main() {
  const port = 47811;
  const xport = 47812;
  const s1 = await serve(port, xport);
  const s2 = await serve(xport, xport);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkshift-test-'));
  const context = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.BROWSER || undefined,
    headless: false,
    viewport: { width: 1000, height: 900 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--headless=new'],
  });

  const errors = [];
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  console.log(`extension id: ${extId}`);

  // Close the welcome tab opened on install.
  await new Promise((r) => setTimeout(r, 800));
  for (const p of context.pages()) if (p.url().includes('options.html')) await p.close();

  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.evaluate(PAGE_HELPERS);
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'fixture-dark.png'), fullPage: true });

  console.log('\nDark mode (default for all sites)');
  const dark = (c) => c && c.bgL !== null && c.bgL < 0.06;
  const light = (c) => c && c.fgL !== null && c.fgL > 0.35;
  const body = await colors(page, 'body');
  check('page background is dark', dark(body), JSON.stringify(body));
  check('page text is light', light(body), JSON.stringify(body));
  for (const [sel, name] of [
    ['#same', 'same-origin stylesheet'],
    ['#cross', 'cross-origin stylesheet (no CORS)'],
    ['#varcard', 'rgb(var(--triplet)) Bootstrap-style'],
    ['#hslcard', 'hsl(var(--triplet)) shadcn-style'],
    ['#media', '@media rule'],
    ['#nested', 'CSS nesting'],
    ['#inline', 'inline style'],
    ['#inlineVar', 'inline style using var()'],
    ['#bgcolor', 'legacy bgcolor attribute'],
    ['#cssinjs', 'CSS-in-JS insertRule'],
    ['#later', 'element added after load'],
    ['#btn', 'button'],
  ]) {
    const c = await colors(page, sel);
    check(`${name} is dark`, dark(c), JSON.stringify(c));
  }
  const imported = await colors(page, '#imported');
  check('@import stylesheet converted (cream -> dark amber tint)', imported && imported.bgL < 0.12 && imported.bg.r > imported.bg.b, JSON.stringify(imported));
  const inner = await colors(page, '#inner', '#host');
  check('shadow DOM content is dark', dark(inner), JSON.stringify(inner));

  const correct = await colors(page, '#correct');
  const greenish = (c) => c && c.bg && c.bg.g > c.bg.r + 25 && c.bg.g > c.bg.b + 10;
  check('"correct" pastel green stays visibly green', greenish(correct) && correct.bgL > 0.03, JSON.stringify(correct));
  check('"correct" text readable (light)', light(correct), JSON.stringify(correct));
  const strong = await colors(page, '#correctStrong');
  check('strong green stays green', greenish(strong) && strong.bgL > 0.05, JSON.stringify(strong));
  const wrong = await colors(page, '#wrong');
  check('"wrong" stays red-tinted', wrong && wrong.bg.r > wrong.bg.g + 20, JSON.stringify(wrong));

  const contrastOk = (c) => c && (Math.max(c.bgL, c.fgL) + 0.05) / (Math.min(c.bgL, c.fgL) + 0.05) >= 4.5;
  for (const sel of ['body', '#correct', '#wrong', '#same', '#cross', '#correctStrong']) {
    check(`contrast ≥ 4.5:1 for ${sel}`, contrastOk(await colors(page, sel)));
  }
  const img = await colors(page, '#img');
  check('colorful images are not filtered', img.filter === 'none', img.filter);
  const logos = await page.evaluate(() => ['logo', 'xlogo', 'img'].map((id) => document.getElementById(id).getAttribute('data-dm-img')));
  check('dark transparent logo is inverted (same-origin)', logos[0] === 'inv', String(logos[0]));
  check('dark transparent logo is inverted (cross-origin)', logos[1] === 'inv', String(logos[1]));
  check('colorful image is left alone', logos[2] === null, String(logos[2]));

  const frame = page.frameLocator('#frame');
  const fbg = await frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  check('same-origin iframe is dark', /rgb\((\d+), (\d+), (\d+)\)/.test(fbg) && Number(fbg.match(/\d+/)[0]) < 60, fbg);

  console.log('\nLive changes');
  await setStorage(sw, 'local', { sites: { '127.0.0.1': { mode: 'off' } } });
  await page.waitForTimeout(600);
  let c = await colors(page, 'body');
  check('site rule "off" restores the original light page', c.bgL > 0.9, JSON.stringify(c));
  const leftovers = await page.evaluate(() => document.adoptedStyleSheets.length + document.querySelectorAll('[data-dm-i]').length);
  check('turning off leaves no injected sheets/attributes', leftovers === 0, String(leftovers));

  await setStorage(sw, 'local', { sites: { '127.0.0.1': { mode: 'filter' } } });
  await page.waitForTimeout(600);
  const filter = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
  check('filter mode inverts the page', filter.includes('invert'), filter);
  const imgFilter = await page.evaluate(() => getComputedStyle(document.getElementById('img')).filter);
  check('filter mode re-inverts images', imgFilter.includes('invert'), imgFilter);

  await setStorage(sw, 'local', { sites: {} });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0].id);
  await setStorage(sw, 'session', { tabs: { [tabId]: 'off' } });
  await page.waitForTimeout(600);
  c = await colors(page, 'body');
  check('tab override "off" beats default', c.bgL > 0.9, JSON.stringify(c));
  await setStorage(sw, 'session', { tabs: {} });
  await page.waitForTimeout(600);
  const before = await colors(page, 'body');
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, adjust: { ...settings.adjust, brightness: 90, blueLight: 40 } } });
  });
  await page.waitForTimeout(700);
  const after = await colors(page, 'body');
  check('brightness slider brightens the dark palette', after.bgL > before.bgL, `${before.bgL} -> ${after.bgL}`);
  const overlays = await page.evaluate(() => document.querySelectorAll('dm-overlay').length);
  check('blue-light overlay present', overlays === 1, String(overlays));
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, adjust: { ...settings.adjust, brightness: 50, blueLight: 0 } } });
  });

  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
  });
  await page.waitForTimeout(600);
  c = await colors(page, 'body');
  check('power off restores the page', c.bgL > 0.9, JSON.stringify(c));
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true } });
  });
  await page.waitForTimeout(600);

  console.log('\nReload uses the tab hint (no white flash)');
  await page.reload({ waitUntil: 'commit' });
  const early = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor).catch(() => '');
  await page.waitForLoadState('load');
  check('html background dark right after navigation commit', /rgb\((\d+)/.test(early) && Number(early.match(/\d+/)[0]) < 60, early);

  console.log('\nExtension pages');
  for (const [name, url] of [
    ['popup', `chrome-extension://${extId}/src/popup/popup.html`],
    ['options', `chrome-extension://${extId}/src/options/options.html#welcome`],
  ]) {
    const p = await context.newPage();
    const pErr = [];
    p.on('pageerror', (e) => pErr.push(e.message));
    p.on('console', (m) => m.type() === 'error' && pErr.push(m.text()));
    if (name === 'popup') await p.setViewportSize({ width: 380, height: 600 });
    await p.goto(url);
    await p.waitForTimeout(800);
    check(`${name} loads without errors`, pErr.length === 0, pErr.join(' | '));
    if (name === 'popup') {
      await p.click('#tabsToggle');
      await p.waitForTimeout(200);
      const rows = await p.locator('.tab-item').count();
      check('popup lists open tabs', rows >= 2, String(rows));
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'popup.png'), fullPage: true });
      await p.click('#supportBtn');
      await p.waitForTimeout(400);
      await p.click('.amounts [data-amount="49"]');
      const qrDark = await p.evaluate(() => {
        const cv = document.getElementById('qr');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++;
        return dark;
      });
      check('support QR is drawn', qrDark > 1000, String(qrDark));
      check('QR label shows ₹49', (await p.textContent('#qrAmount')) === '₹49');
      if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'popup-support.png'), fullPage: true });
    } else if (SHOTS) {
      await p.screenshot({ path: path.join(SHOTS, 'options.png'), fullPage: true });
    }
    await p.close();
  }

  if (process.env.SITES) {
    console.log('\nLive sites (screenshots only)');
    for (const url of (process.env.SITES === '1' ? 'https://en.wikipedia.org/wiki/Dark_mode,https://github.com/microsoft/vscode,https://afterboards.in' : process.env.SITES).split(',')) {
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
      try {
        await p.goto(url, { waitUntil: 'load', timeout: 30000 });
        await p.waitForTimeout(2500);
        const bg = await p.evaluate(() => {
          const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body;
          let e = el;
          while (e && getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)') e = e.parentElement;
          return e ? getComputedStyle(e).backgroundColor : getComputedStyle(document.documentElement).backgroundColor;
        });
        console.log(`  ${url} centre background: ${bg}`);
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, new URL(url).hostname + '.png') });
      } catch (e) {
        console.log(`  ${url}: ${e.message.split('\n')[0]}`);
      }
      await p.close();
    }
  }

  check('no page errors from the extension', errors.length === 0, errors.join(' | '));

  await context.close();
  s1.close();
  s2.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
