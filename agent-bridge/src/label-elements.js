'use strict';

module.exports = `
(() => {
  document.querySelectorAll('.agent-label-overlay').forEach(el => el.remove());
  document.querySelectorAll('[data-agent-id]').forEach(el =>
    el.removeAttribute('data-agent-id'));
  const selector = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[onclick]', '[contenteditable="true"]'
  ].join(',');
  const map = [];
  let index = 0;
  let organicResultRank = 0;
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
    const text = (el.innerText || '').trim().slice(0, 60) ||
      el.getAttribute('placeholder') || el.getAttribute('aria-label') ||
      el.getAttribute('alt') || '';
    let resultRank = null;
    if (el.matches('a[href]') &&
        el.closest('#search, #b_results, main, [data-testid="mainline"]')) {
      try {
        const destination = new URL(el.href, location.href);
        const searchHost = location.hostname.replace(/^www\./, '');
        const destinationHost = destination.hostname.replace(/^www\./, '');
        if (destination.protocol.startsWith('http') &&
            destinationHost !== searchHost &&
            !/^(?:google|bing|duckduckgo|yahoo)\./.test(destinationHost)) {
          resultRank = ++organicResultRank;
        }
      } catch {}
    }
    map.push({id, tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '', text,
      role: el.getAttribute('role') || '',
      organicResultRank: resultRank,
      navigationLikely: Boolean(el.closest('a[href], form')) ||
        ['submit', 'image'].includes(el.getAttribute('type')) ||
        el.getAttribute('role') === 'link'});
  }
  return map;
})()
`;
