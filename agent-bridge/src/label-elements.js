'use strict';

module.exports = `
(() => {
  document.querySelectorAll('.agent-label-overlay').forEach(el => el.remove());
  const selector = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[onclick]', '[contenteditable="true"]'
  ].join(',');
  const map = [];
  let index = 0;
  for (const el of document.querySelectorAll(selector)) {
    const fieldDescriptor = [el.getAttribute('type'), el.getAttribute('name'),
      el.getAttribute('id'), el.getAttribute('autocomplete'),
      el.getAttribute('placeholder'), el.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    if (/password|passcode|one-time-code|cc-|card|cvv|cvc|security.code|iban|routing|account.number/.test(fieldDescriptor))
      continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
      rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
      style.visibility !== 'hidden' && style.display !== 'none';
    if (!visible) continue;
    const id = index++;
    el.setAttribute('data-agent-id', String(id));
    const label = document.createElement('div');
    label.className = 'agent-label-overlay';
    label.textContent = String(id);
    label.style.cssText = 'position:fixed;top:' + Math.max(0, rect.top) +
      'px;left:' + Math.max(0, rect.left) +
      'px;background:#ff3366;color:white;font:11px monospace;padding:1px 4px;' +
      'border-radius:3px;z-index:2147483647;pointer-events:none;line-height:1.4';
    document.documentElement.appendChild(label);
    const text = (el.innerText || '').trim().slice(0, 60) ||
      el.getAttribute('placeholder') || el.getAttribute('aria-label') ||
      el.getAttribute('alt') || '';
    map.push({id, tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '', text,
      role: el.getAttribute('role') || ''});
  }
  return map;
})()
`;
