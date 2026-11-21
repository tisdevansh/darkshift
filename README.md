<p align="center"><img src="icons/on-128.png" width="96" alt="DarkShift logo"></p>

<h1 align="center">DarkShift: Dark Mode for Every Website</h1>

<p align="center">
  Free and open-source dark mode for <b>Chrome, Edge and Brave</b> (and other Chromium browsers).<br>
  Make any tab, a few selected tabs, or every site dark, then tune brightness, contrast, blue light and more.<br>
  <b>No subscription. No ads. No tracking.</b>
</p>

---

## Features

- **Three modes**
  - **Dark**: rewrites each site's own CSS into a dark palette. Text stays sharp, images and videos are untouched, and **colored states keep their meaning** (green "correct", red "wrong", yellow highlights, blue buttons).
  - **Filter**: inverts the page and flips images back, for canvas-heavy apps.
  - **Off**: the page as designed.
- **Choose the scope**: *this tab only*, *this site* (remembered, including subdomains), or *all sites*.
- **Selected tabs**: tick several open tabs in the popup and switch them together. Tabs you highlight in the tab strip with Ctrl/Shift+click are pre-selected.
- **Adjustments**: brightness, contrast, saturation, blue-light filter, dim, and image dimming. Use them globally or per site.
- **Schedule**: always on, follow the system's light/dark theme, or custom hours (e.g. 20:00–07:00).
- **Shortcuts**: `Alt+Shift+D` toggles the site, `Alt+Shift+X` toggles the tab, `Alt+Shift+P` is the power switch, `Alt+Shift+U` opens the popup. All of them can be changed.
- **Right-click menu** on any page.
- **Handles modern sites**: cross-origin stylesheets, `@import`, CSS variables (including Bootstrap/Tailwind/shadcn channel triplets like `rgb(var(--x))` and `hsl(var(--x))`), CSS nesting, `@layer`/`@container`, CSS-in-JS (styled-components, emotion), Shadow DOM, inline styles, iframes and legacy `bgcolor` attributes.
- **No white flash on reload**: each tab remembers its state.
- **Private**: everything runs locally. See [PRIVACY.md](PRIVACY.md).

## Install (unpacked, 1 minute)

1. Download this repository (**Code → Download ZIP**) and unzip it, or `git clone` it.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin DarkShift from the puzzle-piece menu. Tabs that are already open switch to dark immediately.

> To use DarkShift on local `file://` pages, open the extension's **Details** and enable **Allow access to file URLs**.

## How it works

```
manifest.json
src/
  background.js        service worker: resolves per-tab config, pushes changes, fetches cross-origin CSS,
                       shortcuts, context menu, schedule alarms, toolbar icon
  shared/core.js       settings model + precedence: power > tab override > site rule > default (+ schedule)
  content/
    hook.js            MAIN-world hook: announces CSSOM edits (insertRule, adoptedStyleSheets) and new shadow roots
    color.js           color parser (hex, rgb, hsl, hwb, named, lab/oklch via canvas) + role-based dark mapping
    css.js             compiles stylesheets into override rules (same selectors, converted colors)
    engine.js          DynamicEngine (Dark), FilterEngine (Filter), blue-light/dim overlay
    main.js            per-frame controller
  popup/               toolbar popup
  options/             settings page
  ui/                  shared theme + support widget
  vendor/qrcode.js     QR generator (MIT, Kazuhiko Arase)
```

**Dark mode** reads every stylesheet the page uses. For each rule it emits an override with the *same selector* in which every color is mapped by **role**:

| role | used for | mapping |
|---|---|---|
| `bg` | backgrounds, gradients | light → dark surface; colored surfaces keep their hue at a readable tint |
| `fg` | text, icons, SVG fill | dark → light; colored text stays colored |
| `bd` | borders, outlines | light → subtle dark lines |
| `sh` | shadows | dark shadows kept, light glows darkened |

Overrides are attached with `adoptedStyleSheets`, so the page's DOM is never rewritten. Because the override keeps the selector, specificity and order of the original, the cascade behaves the same as on the original site. CSS variables get one role-specific copy each (`--dm-bg--name`, `--dm-fg--name`, …), so a single variable can be used for both text and backgrounds.

## Development

```bash
npm install
npx playwright install chromium
npm test                 # end-to-end tests in a real Chromium with the extension loaded
SHOTS=out npm test       # also save screenshots into ./out
SITES=1 SHOTS=out npm test   # also screenshot a few live sites
# Branded Google Chrome ignores --load-extension; to test in Brave/Edge instead:
BROWSER="C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" npm test
npm run package          # dist/darkshift-<version>.zip for the Chrome Web Store / Edge Add-ons
npm run icons            # regenerate icons (Python, no dependencies)
```

## Support

DarkShift is free. If it's easier on your eyes, you can leave a small tip from the **Support** button in the popup (UPI: `tisdevansh@pingpay`). It's completely optional.

## License

[MIT](LICENSE) © Devansh Agarwal
