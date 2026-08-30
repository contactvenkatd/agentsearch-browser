'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ChromiumConnection, MAX_PAGE_TEXT_CHARS,
  REMOVE_LABEL_OVERLAYS_SCRIPT, extractReadableText,
  isPageOrBrowserCrashError, loopbackCandidateEndpoints,
  searchPageInfo} = require('../src/chromium');
const LABEL_ELEMENTS_SCRIPT = require('../src/label-elements');

function connectionWithTargets(targets) {
  const page = {url: () => 'https://example.test/page',
    title: async () => 'Example page'};
  const context = {pages: () => [page], newCDPSession: async () => ({
    send: async method => {
      assert.equal(method, 'Target.getTargetInfo');
      return {targetInfo: targets.find(target => target.type === 'page')};
    },
    detach: async () => {},
  })};
  const browser = {contexts: () => [context], newBrowserCDPSession: async () => ({
    send: async (method, parameters) => {
      assert.equal(method, 'Target.getTargets');
      assert.deepEqual(parameters, {filter: [{exclude: false}]});
      return {targetInfos: targets};
    },
    detach: async () => {},
  })};
  const connection = new ChromiumConnection('unused');
  connection.connect = async () => browser;
  return {connection, page};
}

function browserWithTarget(targetId) {
  const target = {targetId, type: 'page', browserContextId: 'context',
    url: `https://${targetId}.example.test/`};
  const page = {url: () => target.url, title: async () => targetId};
  const context = {pages: () => [page], newCDPSession: async () => ({
    send: async () => ({targetInfo: target}), detach: async () => {},
  })};
  const browser = {isConnected: () => true, on: () => {},
    contexts: () => [context], newBrowserCDPSession: async () => ({
      send: async () => ({targetInfos: [target]}), detach: async () => {},
    })};
  return {browser, page};
}

test('resolves the exact Playwright page target id', async () => {
  const {connection, page} = connectionWithTargets([
    {targetId: 'page-id', type: 'page', browserContextId: 'context'},
    {targetId: 'tab-id', type: 'tab', browserContextId: 'context'},
  ]);
  assert.equal(await connection.pageForTarget('page-id'), page);
});

test('probes IPv4 and IPv6 and skips unsupported stale browser context',
  async () => {
  const attempts = [];
  const {browser, page} = browserWithTarget('fresh-target');
  const connection = new ChromiumConnection('http://127.0.0.1:9222',
    {connectOverCDP: async endpoint => {
      attempts.push(endpoint);
      if (endpoint.includes('127.0.0.1')) {
        throw new Error('browserType.connectOverCDP: Protocol error ' +
          '(Browser.setDownloadBehavior): Browser context management is not supported.');
      }
      return browser;
    }});

  assert.equal(await connection.pageForTarget('fresh-target'), page);
  assert.deepEqual(attempts,
    ['http://127.0.0.1:9222/', 'http://[::1]:9222/']);
  assert.equal(connection.browsers.has('http://127.0.0.1:9222/'), false);
  assert.equal(connection.browsers.get('http://[::1]:9222/'), browser);
});

test('chooses the healthy browser that owns the requested target', async () => {
  const first = browserWithTarget('other-target');
  const second = browserWithTarget('requested-target');
  const connection = new ChromiumConnection('http://127.0.0.1:9222',
    {connectOverCDP: async endpoint => endpoint.includes('127.0.0.1') ?
      first.browser : second.browser});

  assert.equal(await connection.pageForTarget('requested-target'), second.page);
  assert.equal(connection.browsers.size, 2);
});

test('crash recovery selects the sole replacement page target', async () => {
  const targets = [
    {targetId: 'dead-target', type: 'page', url: 'https://old.example/'},
    {targetId: 'replacement', type: 'page', url: 'https://shop.example/item'},
    {targetId: 'worker', type: 'service_worker', url: 'https://shop.example/sw'},
  ];
  const browser = {isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (method, parameters) => {
        assert.equal(method, 'Target.getTargets');
        assert.deepEqual(parameters, {filter: [{exclude: false}]});
        return {targetInfos: targets};
      },
      detach: async () => {},
    })};
  const connection = new ChromiumConnection('http://remote.test:9222');
  connection.connect = async () => browser;

  assert.deepEqual(await connection.recoverAfterCrash('dead-target'),
    {recovered: true, newTargetId: 'replacement'});
});

test('crash recovery prefers a replacement with the last observed origin',
  async () => {
    const targets = [
      {targetId: 'unrelated', type: 'page', url: 'https://news.example/'},
      {targetId: 'replacement', type: 'page',
        url: 'https://www.amazon.com/dp/example'},
    ];
    const browser = {isConnected: () => true,
      newBrowserCDPSession: async () => ({
        send: async () => ({targetInfos: targets}), detach: async () => {},
      })};
    const connection = new ChromiumConnection('http://remote.test:9222');
    connection.connect = async () => browser;

    assert.deepEqual(await connection.recoverAfterCrash('dead-target',
      'https://www.amazon.com/s?k=iphone'),
    {recovered: true, newTargetId: 'replacement'});
  });

test('crash recovery returns failure when replacement is ambiguous', async () => {
  const targets = [
    {targetId: 'first', type: 'page', url: 'https://one.example/'},
    {targetId: 'second', type: 'page', url: 'https://two.example/'},
  ];
  const browser = {isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async () => ({targetInfos: targets}), detach: async () => {},
    })};
  const connection = new ChromiumConnection('http://remote.test:9222');
  connection.connect = async () => browser;

  assert.deepEqual(await connection.recoverAfterCrash('dead-target',
    'https://missing.example/'), {recovered: false});
});

test('derives both loopback CDP candidates without changing remote endpoints',
  () => {
  assert.deepEqual(loopbackCandidateEndpoints('http://127.0.0.1:9222'),
    ['http://127.0.0.1:9222/', 'http://[::1]:9222/']);
  assert.deepEqual(loopbackCandidateEndpoints('http://remote.test:9222'),
    ['http://remote.test:9222']);
});

test('does not substitute a Playwright page for a tab target id', async () => {
  const {connection} = connectionWithTargets([
    {targetId: 'page-id', type: 'page', url: 'https://example.test/page',
      browserContextId: 'context'},
    {targetId: 'tab-id', type: 'tab', url: 'https://example.test/page',
      browserContextId: 'context'},
  ]);
  const originalError = console.error;
  const diagnostics = [];
  console.error = value => diagnostics.push(value);
  try {
    await assert.rejects(connection.pageForTarget('tab-id'), /not available/);
  } finally {
    console.error = originalError;
  }
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /"receivedTargetType":"tab"/);
  assert.match(diagnostics[0], /target id differs from tab-id/);
});

test('extracts normalized readable text and excludes non-content elements',
  async () => {
    const parts = {content: `  Main heading\n\n${'article '.repeat(2000)}`,
      script: 'secret script', style: 'hidden style', overlay: 'overlay label'};
    const clone = {
      get textContent() { return Object.values(parts).join(' '); },
      querySelectorAll: selector => {
        assert.match(selector, /script/);
        assert.match(selector, /\.agent-label-overlay/);
        return [
          {remove: () => { parts.script = ''; }},
          {remove: () => { parts.style = ''; }},
          {remove: () => { parts.overlay = ''; }},
        ];
      },
    };
    const previousDocument = global.document;
    global.document = {querySelector: selector => selector === 'main' ?
      {cloneNode: () => clone} : null, body: null};
    const page = {evaluate: async (callback, argument) =>
      callback(argument)};
    try {
      const text = await extractReadableText(page);
      assert.equal(text.length, MAX_PAGE_TEXT_CHARS);
      assert.match(text, /^Main heading article/);
      assert.doesNotMatch(text, /secret script|hidden style|overlay label/);
      assert.doesNotMatch(text, /\s{2,}/);
    } finally {
      global.document = previousDocument;
    }
  });

test('recognizes search result topics without exposing unrelated URL data', () => {
  assert.deepEqual(searchPageInfo('https://www.google.com/search?q=texas&x=secret'),
    {engine: 'Google', query: 'texas'});
  assert.deepEqual(searchPageInfo('https://www.bing.com/search?q=texas'),
    {engine: 'Bing', query: 'texas'});
  assert.deepEqual(searchPageInfo('https://search.yahoo.com/search?p=texas'),
    {engine: 'Yahoo', query: 'texas'});
  assert.equal(searchPageInfo('https://en.wikipedia.org/wiki/Texas'), null);
});

test('element observation never creates visible numbered overlays', () => {
  assert.match(LABEL_ELEMENTS_SCRIPT, /data-agent-id/);
  assert.match(LABEL_ELEMENTS_SCRIPT,
    /querySelectorAll\('\[data-agent-id\]'\)/);
  assert.match(LABEL_ELEMENTS_SCRIPT, /removeAttribute\('data-agent-id'\)/);
  assert.doesNotMatch(LABEL_ELEMENTS_SCRIPT,
    /createElement|appendChild|background:#ff3366/);
});

test('cleanup removes legacy label overlays from the page', async () => {
  let evaluatedScript;
  const {connection, page} = connectionWithTargets([
    {targetId: 'page-id', type: 'page', browserContextId: 'context'},
  ]);
  page.evaluate = async script => { evaluatedScript = script; };
  await connection.cleanup('page-id');
  assert.equal(evaluatedScript, REMOVE_LABEL_OVERLAYS_SCRIPT);
  assert.match(evaluatedScript, /\.agent-label-overlay/);
  assert.match(evaluatedScript, /\.remove\(\)/);
});

test('observation retries page reads destroyed by navigation', async () => {
  let labelAttempts = 0;
  let loadWaits = 0;
  const page = {
    waitForLoadState: async state => {
      assert.equal(state, 'domcontentloaded');
      loadWaits += 1;
    },
    evaluate: async script => {
      if (typeof script === 'string') {
        labelAttempts += 1;
        if (labelAttempts === 1) {
          throw new Error(
            'page.evaluate: Execution context was destroyed, most likely because of a navigation');
        }
        return [{id: 0, tag: 'a', type: '', text: 'Texas'}];
      }
      return 'Texas page content';
    },
    title: async () => 'Texas results',
    url: () => 'https://example.test/texas',
  };
  const connection = new ChromiumConnection('unused');
  connection.pageForTarget = async () => page;

  const observation = await connection.observe('page-id');

  assert.equal(labelAttempts, 2);
  assert.equal(loadWaits, 2);
  assert.equal(observation.title, 'Texas results');
  assert.equal(observation.pageText, 'Texas page content');
});

test('classifies page and browser crashes without treating timeouts as crashes',
  () => {
  assert.equal(isPageOrBrowserCrashError(new Error(
    'page.waitForLoadState: Navigation failed because page crashed!')), true);
  assert.equal(isPageOrBrowserCrashError(new Error(
    'browser has disconnected unexpectedly')), true);
  assert.equal(isPageOrBrowserCrashError(new Error(
    'Target page, context or browser has been closed')), true);
  assert.equal(isPageOrBrowserCrashError(new Error(
    'page.waitForLoadState: Timeout 5000ms exceeded')), false);
  assert.equal(isPageOrBrowserCrashError(new Error(
    'Execution context was destroyed because of a navigation')), false);
});
