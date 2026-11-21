/*
 * DarkShift — support (UPI tip) widget shared by the popup and the options page.
 * Expects markup with: .amounts [data-amount], #customWrap, #customAmount, #qr, #qrAmount,
 * #upiId, #copyUpi inside `root`. Uses the vendored qrcode-generator (global `qrcode`).
 */
import { SUPPORT, upiLink } from '../shared/core.js';

function drawQr(canvas, text) {
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const cssSize = parseInt(canvas.getAttribute('width'), 10) || 180;
  const dpr = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const ctx = canvas.getContext('2d');
  const cell = canvas.width / (count + quiet * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f1020';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      // Snap to whole device pixels so modules never blur or leave hairline gaps.
      const x = Math.floor((c + quiet) * cell);
      const y = Math.floor((r + quiet) * cell);
      ctx.fillRect(x, y, Math.ceil((c + quiet + 1) * cell) - x, Math.ceil((r + quiet + 1) * cell) - y);
    }
  }
}

export function mountSupport(root) {
  const amountBtns = [...root.querySelectorAll('.amounts [data-amount]')];
  const customWrap = root.querySelector('#customWrap');
  const customInput = root.querySelector('#customAmount');
  const canvas = root.querySelector('#qr');
  const amountLabel = root.querySelector('#qrAmount');
  const upiEl = root.querySelector('#upiId');
  const copyBtn = root.querySelector('#copyUpi');
  let selected = String(SUPPORT.amounts[0]);

  upiEl.textContent = SUPPORT.upiId;

  function currentAmount() {
    if (selected !== 'custom') return Number(selected);
    const v = Math.floor(Number(customInput.value));
    return Number.isFinite(v) && v >= 1 && v <= 100000 ? v : 0;
  }

  function refresh() {
    for (const b of amountBtns) b.setAttribute('aria-pressed', String(b.dataset.amount === selected));
    customWrap.hidden = selected !== 'custom';
    const amount = currentAmount();
    amountLabel.textContent = amount ? `₹${amount}` : 'Any amount';
    drawQr(canvas, upiLink(amount));
  }

  for (const b of amountBtns) {
    b.addEventListener('click', () => {
      selected = b.dataset.amount;
      refresh();
      if (selected === 'custom') customInput.focus();
    });
  }
  customInput.addEventListener('input', refresh);

  copyBtn.addEventListener('click', async () => {
    const label = copyBtn.querySelector('span');
    try {
      await navigator.clipboard.writeText(SUPPORT.upiId);
      label.textContent = 'Copied';
    } catch (e) {
      label.textContent = 'Press Ctrl+C';
      const range = document.createRange();
      range.selectNodeContents(upiEl);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    setTimeout(() => (label.textContent = 'Copy'), 1600);
  });

  refresh();
  return { refresh };
}

export async function markSupported() {
  const { support = {} } = await chrome.storage.local.get('support');
  await chrome.storage.local.set({ support: { ...support, supportedAt: Date.now(), lastReminder: Date.now() } });
}

export async function markReminded() {
  const { support = {} } = await chrome.storage.local.get('support');
  await chrome.storage.local.set({ support: { ...support, lastReminder: Date.now() } });
}
