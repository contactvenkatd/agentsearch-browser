'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ChromiumConnection, MAX_PAGE_TEXT_CHARS,
  extractReadableText} = require('../src/chromium');

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

test('resolves the exact Playwright page target id', async () => {
  const {connection, page} = connectionWithTargets([
    {targetId: 'page-id', type: 'page', browserContextId: 'context'},
    {targetId: 'tab-id', type: 'tab', browserContextId: 'context'},
  ]);
  assert.equal(await connection.pageForTarget('page-id'), page);
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
