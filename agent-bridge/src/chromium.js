'use strict';

const {chromium} = require('playwright');
const LABEL_ELEMENTS_SCRIPT = require('./label-elements');

function safeTargetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unavailable)';
  }
}

class ChromiumConnection {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.browser = null;
    this.connecting = null;
  }

  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.connecting) {
      this.connecting = chromium.connectOverCDP(this.endpoint).then(browser => {
        this.browser = browser;
        browser.on('disconnected', () => { this.browser = null; });
        return browser;
      }).finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async pageForTarget(targetId) {
    let liveTargets = [];
    let candidates = [];
    for (let attempt = 0; attempt < 4; ++attempt) {
      const browser = await this.connect();
      const browserSession = await browser.newBrowserCDPSession();
      try {
        ({targetInfos: liveTargets} = await browserSession.send(
          'Target.getTargets', {filter: [{exclude: false}]}));
      } finally {
        await browserSession.detach().catch(() => {});
      }
      const requestedTarget = liveTargets.find(target =>
        target.targetId === targetId);
      if (!requestedTarget) {
        await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
        continue;
      }
      candidates = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          let session;
          try {
            session = await context.newCDPSession(page);
            const {targetInfo} = await session.send('Target.getTargetInfo');
            const isMatch = targetInfo.targetId === targetId;
            let title = '(unavailable)';
            try {
              title = await page.title();
            } catch {
              // A title is diagnostic only and must not prevent target matching.
            }
            candidates.push({targetId: targetInfo.targetId, url: page.url(),
              title, browserContextId:
                targetInfo.browserContextId || '(default)',
              selectable: targetInfo.type === 'page',
              comparison: isMatch ? 'match' :
                `target id differs from ${targetId}`});
            if (isMatch) return page;
          } catch (error) {
            candidates.push({targetId: '(unavailable)', url: page.url(),
              title: '(unavailable)', browserContextId: '(unavailable)',
              selectable: false, comparison: `CDP inspection failed: ${error}`});
          } finally {
            if (session) await session.detach().catch(() => {});
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
    }
    const pageTargets = liveTargets.filter(target => target.type === 'page')
      .map(target => `${target.targetId} (${safeTargetUrl(target.url)})`)
      .join(', ');
    const requestedTarget = liveTargets.find(target =>
      target.targetId === targetId);
    const diagnostic = {receivedTargetId: targetId,
      receivedTargetType: requestedTarget?.type || '(not live)',
      candidates: candidates.map(candidate => ({...candidate,
        url: process.env.AGENT_BRIDGE_CDP_DIAGNOSTICS === '1' ? candidate.url :
          safeTargetUrl(candidate.url)}))};
    console.error(`AgentSearch CDP target resolution failed: ${
      JSON.stringify(diagnostic)}`);
    throw new Error(`CDP target ${targetId} is not available in Playwright pages; ` +
      `live page targets: ${pageTargets || '(none)'}`);
  }

  async observe(targetId) {
    const page = await this.pageForTarget(targetId);
    const elements = await page.evaluate(LABEL_ELEMENTS_SCRIPT);
    return {page, url: page.url(), title: await page.title(), elements};
  }
}

class MockChromiumConnection {
  async observe(targetId, run) {
    if (/\[mock:observation-failure\]/i.test(run.task)) {
      throw new Error('Mock page observation failed.');
    }
    return {page: {waitForTimeout: delay => new Promise(resolve =>
      setTimeout(resolve, delay))}, url: 'https://example.test/',
    title: `Mock page ${targetId}`,
    elements: [{id: 0, tag: 'input', type: 'search', text: 'Search'}]};
  }
}

module.exports = {ChromiumConnection, MockChromiumConnection};
