'use strict';

const {chromium} = require('playwright');
const LABEL_ELEMENTS_SCRIPT = require('./label-elements');

const MAX_PAGE_TEXT_CHARS = 10000;
const REMOVE_LABEL_OVERLAYS_SCRIPT = `
(() => {
  document.querySelectorAll('.agent-label-overlay').forEach(el => el.remove());
})()
`;

async function extractReadableText(page) {
  return page.evaluate(maxLength => {
    const source = document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') || document.body;
    if (!source) return '';
    const clone = source.cloneNode(true);
    clone.querySelectorAll(
      'script, style, noscript, template, svg, canvas, ' +
      '.agent-label-overlay, [data-agentsearch-overlay]')
      .forEach(element => element.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim()
      .slice(0, maxLength);
  }, MAX_PAGE_TEXT_CHARS);
}

async function extractSearchAnswer(page) {
  return page.evaluate(maxLength => {
    const selectors = [
      // Google knowledge panels, featured snippets, and direct answers.
      '[data-attrid]', '.kno-rdesc', '.hgKElc', '[data-snf]',
      // Bing entity panels and answer cards.
      '.b_entityTP', '.b_ans', '.b_wikiRichcard',
      // DuckDuckGo and other engines' answer panels.
      '.module--about', '.zci', '[data-testid="about"]',
    ];
    const seen = new Set();
    const parts = [];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      const text = (element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ').trim();
      if (text.length >= 40 && !seen.has(text)) {
        seen.add(text);
        parts.push(text);
      }
    }
    return parts.join('\n').slice(0, maxLength);
  }, 5000);
}

function searchPageInfo(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, '');
    let engine;
    let parameter = 'q';
    if (/^google\./.test(hostname) && url.pathname === '/search') engine = 'Google';
    else if (hostname === 'bing.com' && url.pathname.startsWith('/search')) engine = 'Bing';
    else if (hostname === 'duckduckgo.com') engine = 'DuckDuckGo';
    else if (/^(?:search\.)?yahoo\./.test(hostname) &&
        url.pathname.startsWith('/search')) {
      engine = 'Yahoo';
      parameter = 'p';
    } else if (hostname === 'search.brave.com' &&
        url.pathname.startsWith('/search')) engine = 'Brave';
    if (!engine) return null;
    const query = (url.searchParams.get(parameter) || '').trim();
    return query ? {engine, query} : null;
  } catch {
    return null;
  }
}

function safeTargetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unavailable)';
  }
}

function isDestroyedContextError(error) {
  return /execution context was destroyed|cannot find context with specified id|navigation interrupted the evaluation/i
    .test(error?.message || String(error));
}

function isPageOrBrowserCrashError(error) {
  const message = error?.message || String(error);
  return /page crashed|page has crashed|browser has disconnected|browser disconnected|browser process (?:crashed|exited)|target crashed|target page, context or browser has been closed/i
    .test(message);
}

function loopbackCandidateEndpoints(endpoint) {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return [endpoint];
    const suffix = `${url.port ? `:${url.port}` : ''}${url.pathname}`;
    return [`${url.protocol}//127.0.0.1${suffix}`,
      `${url.protocol}//[::1]${suffix}`];
  } catch {
    return [endpoint];
  }
}

function isUnsupportedBrowserContextError(error) {
  return /Browser context management is not supported/i
    .test(error?.message || String(error));
}

class ChromiumConnection {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.endpoints = loopbackCandidateEndpoints(endpoint);
    this.connectOverCDP = options.connectOverCDP ||
      (candidate => chromium.connectOverCDP(candidate));
    this.browsers = new Map();
    this.connecting = new Map();
  }

  async connect(endpoint = this.endpoint) {
    const cached = this.browsers.get(endpoint);
    if (cached && cached.isConnected?.() !== false) return cached;
    this.browsers.delete(endpoint);
    if (!this.connecting.has(endpoint)) {
      const connecting = this.connectOverCDP(endpoint).then(browser => {
        // connectOverCDP resolves only after Playwright finishes initializing
        // the default context, including download behavior.
        this.browsers.set(endpoint, browser);
        browser.on?.('disconnected', () => {
          if (this.browsers.get(endpoint) === browser) {
            this.browsers.delete(endpoint);
          }
        });
        return browser;
      }).finally(() => { this.connecting.delete(endpoint); });
      this.connecting.set(endpoint, connecting);
    }
    return this.connecting.get(endpoint);
  }

  async pageForTarget(targetId) {
    let liveTargets = [];
    let candidates = [];
    let connectionErrors = [];
    for (let attempt = 0; attempt < 4; ++attempt) {
      liveTargets = [];
      candidates = [];
      connectionErrors = [];
      const connections = await Promise.all(this.endpoints.map(async endpoint => {
        try {
          return {endpoint, browser: await this.connect(endpoint)};
        } catch (error) {
          this.browsers.delete(endpoint);
          connectionErrors.push({endpoint,
            error: isUnsupportedBrowserContextError(error) ?
              'browser context unavailable' : String(error)});
          return null;
        }
      }));
      for (const connection of connections.filter(Boolean)) {
        const {endpoint, browser} = connection;
        const browserSession = await browser.newBrowserCDPSession();
        let endpointTargets;
        try {
          ({targetInfos: endpointTargets} = await browserSession.send(
            'Target.getTargets', {filter: [{exclude: false}]}));
          liveTargets.push(...endpointTargets);
        } finally {
          await browserSession.detach().catch(() => {});
        }
        if (!endpointTargets.some(target => target.targetId === targetId)) {
          continue;
        }
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
              candidates.push({endpoint, targetId: targetInfo.targetId,
                url: page.url(), title, browserContextId:
                  targetInfo.browserContextId || '(default)',
                selectable: targetInfo.type === 'page',
                comparison: isMatch ? 'match' :
                  `target id differs from ${targetId}`});
              if (isMatch) return page;
            } catch (error) {
              candidates.push({endpoint, targetId: '(unavailable)',
                url: page.url(), title: '(unavailable)',
                browserContextId: '(unavailable)', selectable: false,
                comparison: `CDP inspection failed: ${error}`});
            } finally {
              if (session) await session.detach().catch(() => {});
            }
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
      connectionErrors,
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
    for (let attempt = 0; attempt < 3; ++attempt) {
      try {
        await page.waitForLoadState('domcontentloaded');
        const searchPage = searchPageInfo(page.url());
        const [elements, title, pageText, directAnswerText] = await Promise.all([
          page.evaluate(LABEL_ELEMENTS_SCRIPT), page.title(),
          extractReadableText(page),
          searchPage ? extractSearchAnswer(page) : Promise.resolve(''),
        ]);
        return {page, url: page.url(), title, elements, pageText,
          searchPage, directAnswerText};
      } catch (error) {
        if (!isDestroyedContextError(error) || attempt === 2) throw error;
      }
    }
  }

  async cleanup(targetId) {
    const page = await this.pageForTarget(targetId);
    await page.evaluate(REMOVE_LABEL_OVERLAYS_SCRIPT);
  }

  async recoverAfterCrash(targetId, lastKnownUrl) {
    for (const [endpoint, browser] of this.browsers) {
      if (browser.isConnected?.() === false) this.browsers.delete(endpoint);
    }

    const livePages = new Map();
    const connections = await Promise.all(this.endpoints.map(async endpoint => {
      try {
        return {endpoint, browser: await this.connect(endpoint)};
      } catch (error) {
        this.browsers.delete(endpoint);
        console.warn(`AgentSearch crash recovery could not connect to ${endpoint}: ${
          error.message || error}`);
        return null;
      }
    }));

    for (const connection of connections.filter(Boolean)) {
      const {endpoint, browser} = connection;
      let browserSession;
      try {
        browserSession = await browser.newBrowserCDPSession();
        const {targetInfos} = await browserSession.send('Target.getTargets',
          {filter: [{exclude: false}]});
        for (const target of targetInfos) {
          if (target.type === 'page' && target.targetId !== targetId) {
            livePages.set(target.targetId, target);
          }
        }
      } catch (error) {
        console.warn(`AgentSearch crash recovery could not inspect ${endpoint}: ${
          error.message || error}`);
      } finally {
        await browserSession?.detach().catch(() => {});
      }
    }

    const candidates = [...livePages.values()];
    if (candidates.length === 1) {
      return {recovered: true, newTargetId: candidates[0].targetId};
    }
    if (candidates.length > 1 && lastKnownUrl) {
      let lastOrigin;
      try {
        lastOrigin = new URL(lastKnownUrl).origin;
      } catch {
        lastOrigin = null;
      }
      if (lastOrigin) {
        const originMatches = candidates.filter(candidate => {
          try {
            return new URL(candidate.url).origin === lastOrigin;
          } catch {
            return false;
          }
        });
        if (originMatches.length === 1) {
          return {recovered: true, newTargetId: originMatches[0].targetId};
        }
      }
    }
    return {recovered: false};
  }
}

class MockChromiumConnection {
  async observe(targetId, run) {
    if (/\[mock:observation-failure\]/i.test(run.task)) {
      throw new Error('Mock page observation failed.');
    }
    return {page: {waitForTimeout: delay => new Promise(resolve =>
      setTimeout(resolve, delay))}, url: 'https://example.test/',
    title: `Mock page ${targetId}`, pageText: 'Mock readable page content.',
    elements: [{id: 0, tag: 'input', type: 'search', text: 'Search'}]};
  }

  async cleanup() {}
}

module.exports = {ChromiumConnection, MockChromiumConnection,
  MAX_PAGE_TEXT_CHARS, REMOVE_LABEL_OVERLAYS_SCRIPT, extractReadableText,
  extractSearchAnswer, isPageOrBrowserCrashError,
  isUnsupportedBrowserContextError, loopbackCandidateEndpoints, searchPageInfo};
