'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {isUngroundedProductRefusal, TaskManager,
  validateAction} = require('../src/task-manager');
const {buildApiMessages, buildPrompt, decide, execute,
  GROUNDING_SYSTEM_MESSAGE,
  persistApiMessagePayload} = require('../src/agent-core');

process.env.AGENT_BRIDGE_MOCK = '1';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('condition was not reached');
};
const connection = {observe: async targetId => ({page: {
  waitForTimeout: delay}, url: 'https://example.test/', title: targetId,
elements: [{id: 0, tag: 'input', type: 'search', text: 'Search'}]})};

test('summary response is emitted before completion with no progress messages', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('summarize this page', 'target');
  await waitFor(() => run.status === 'done');
  assert.deepEqual(run.events.map(event => event.sequence),
    run.events.map((_, index) => index + 1));
  assert.deepEqual(run.events.map(event => event.type), [
    'bridge_received', 'page_observation_started', 'page_observed',
    'model_request_started', 'action_decided', 'assistant_message', 'done'
  ]);
  const userVisibleEvents = run.events.filter(event =>
    ['assistant_message', 'error', 'cancelled'].includes(event.type));
  assert.deepEqual(userVisibleEvents.map(event => event.text),
    ['Mock readable page summary.']);
  assert.ok(run.events.findIndex(event => event.type === 'assistant_message') <
    run.events.findIndex(event => event.type === 'done'));
  assert.equal(run.events.find(event => event.type === 'assistant_message').persist,
    true);
});

test('readable page content is included in the Grok prompt', () => {
  const prompt = buildPrompt({task: 'summarize this page'}, {
    url: 'https://example.test/private?token=secret', title: 'Example',
    pageText: 'Important article content to summarize.', elements: [],
  });
  assert.match(prompt, /Readable page content:\nImportant article content/);
  assert.match(prompt, /call respond with the complete answer/);
  assert.doesNotMatch(prompt, /token=secret/);
});

test('live product listings override stale model assumptions', () => {
  const prompt = buildPrompt({task:
    'Search for an iPhone 17 Pro Max and add one to cart'}, {
    url: 'https://www.amazon.com/s?k=iPhone+17+Pro+Max',
    title: 'Amazon.com : iPhone 17 Pro Max',
    pageText: 'Results for iPhone 17 Pro Max. Apple iPhone 17 Pro Max 256GB.',
    elements: [{id: 7, tag: 'a', type: '',
      text: 'Apple iPhone 17 Pro Max 256GB'}],
  });

  const run = {messages: []};
  const messages = buildApiMessages(run, prompt);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, GROUNDING_SYSTEM_MESSAGE);
  assert.match(messages[0].content, /knowledge.*release dates.*unreliable/is);
  assert.match(messages[0].content, /NEVER refuse or stop/i);
  assert.match(messages[0].content, /Distinguish.*accessories, cases/is);
  assert.equal(messages.at(-1).role, 'user');
});

test('API message payload log preserves an exact hash and sanitized copy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsearch-api-test-'));
  const filename = path.join(directory, 'payloads.jsonl');
  const messages = [{role: 'system', content: GROUNDING_SYSTEM_MESSAGE},
    {role: 'user', content:
      'Email user@example.com card 4111 1111 1111 1111 token?token=secret'}];
  try {
    const entry = persistApiMessagePayload('run-id', messages, filename);
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(saved.sha256, entry.sha256);
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
    assert.equal(saved.runId, 'run-id');
    assert.doesNotMatch(JSON.stringify(saved.messages),
      /user@example|4111|token=secret/);
    assert.match(saved.messages[1].content,
      /\[redacted-email\].*\[redacted-number\].*token=\[redacted\]/);
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
});

test('ungrounded product refusal is deferred but accessories-only result passes',
  async () => {
  const manager = new TaskManager(connection, {stepLimit: 2});
  const refused = manager.create(
    '[mock:ungrounded-refusal] search Amazon and buy this product', 'target');
  await waitFor(() => refused.status === 'error');
  assert.equal(refused.events.some(event =>
    event.type === 'assistant_message'), false);
  assert.equal(refused.events.filter(event =>
    event.type === 'completion_deferred').length, 2);
  assert.match(refused.events.find(event =>
    event.type === 'completion_deferred').text,
  /ungrounded product existence or release-date assumption/i);

  const grounded = manager.create(
    '[mock:accessories-only] search Amazon for this product', 'target');
  await waitFor(() => grounded.status === 'done');
  assert.match(grounded.events.find(event =>
    event.type === 'assistant_message').text,
  /only accessories were found.*no direct product listing/i);
  assert.equal(isUngroundedProductRefusal({action: 'respond',
    text: 'Only accessories were found in the search results.'},
  'search Amazon'), false);
});

test('substantive search answer is summarized as the topic, not page layout',
  async () => {
    const directAnswerText = 'Texas is the second-largest U.S. state by area ' +
      'and population. Its capital is Austin, while Houston is its largest ' +
      'city. It spans deserts, plains, forests, and Gulf Coast shoreline. ' +
      'Texas has more than 30 million residents and a diverse economy led by ' +
      'energy, technology, agriculture, manufacturing, and trade. It joined ' +
      'the United States in 1845 after existing as an independent republic.';
    const observation = {
      url: 'https://www.google.com/search?q=texas', title: 'texas - Google Search',
      pageText: 'Search results About Texas Wikipedia Visit Texas',
      directAnswerText, searchPage: {engine: 'Google', query: 'texas'},
      elements: [{id: 4, tag: 'a', text: 'Texas - Wikipedia',
        organicResultRank: 1}],
    };

    const prompt = buildPrompt({task:
      'search for texas and summarize the page after you landed'}, observation);
    const action = await decide({task:
      'search for texas and summarize the page after you landed'}, observation);

    assert.match(prompt, /wants to know ABOUT that topic/i);
    assert.match(prompt, /Summarize its facts now without navigating/i);
    assert.match(prompt, /capital is Austin/);
    assert.doesNotMatch(action.text, /page (?:layout|structure)|list of results/i);
    assert.equal(action.action, 'respond');
    assert.match(action.text, /Texas.*capital is Austin/is);
  });

test('thin search results open the top organic result before summarizing',
  async () => {
    const observation = {
      url: 'https://www.google.com/search?q=texas', title: 'texas - Google Search',
      pageText: 'Texas - Wikipedia. Official state website. Visit Texas.',
      directAnswerText: '', searchPage: {engine: 'Google', query: 'texas'},
      elements: [
        {id: 7, tag: 'a', text: 'Texas - Wikipedia', organicResultRank: 1},
        {id: 9, tag: 'a', text: 'Travel Texas', organicResultRank: 2},
      ],
    };

    const prompt = buildPrompt({task: 'search for texas and summarize'},
      observation);
    const action = await decide({task: 'search for texas and summarize'},
      observation);

    assert.match(prompt, /Do not summarize the result list or respond yet/i);
    assert.match(prompt, /read that page, then summarize its actual content/i);
    assert.deepEqual(action, {action: 'click', element_id: 7,
      reasoning: 'Opening the top result for substantive source content',
      toolCallId: 'mock-followup-result'});
  });

test('empty response fails instead of silently completing', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('[mock:empty-response]', 'target');
  await waitFor(() => run.status === 'error');
  assert.equal(run.events.some(event => event.type === 'assistant_message'), false);
  assert.equal(run.events.some(event => event.type === 'done'), false);
  assert.match(run.events.at(-1).text, /empty text response/i);
});

test('search task types and then submits with Enter before completion', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('search for trump', 'target');
  await waitFor(() => run.status === 'done');
  assert.equal(run.events.some(event =>
    event.type === 'confirmation_required'), false);
  assert.deepEqual(run.mockExecutedActions,
    ['navigate', 'type', 'press_enter', 'wait']);
  assert.equal(run.events.filter(event =>
    event.type === 'action_completed').length, 4);
});

test('shopping task cannot finish on search results without outcome evidence',
  async () => {
  const manager = new TaskManager(connection, {stepLimit: 2});
  const run = manager.create(
    '[mock:premature-shopping-done] search for iPhone, add it to cart, and checkout',
    'target');
  await waitFor(() => run.status === 'error');
  assert.equal(run.events.some(event => event.type === 'assistant_message'), false);
  assert.equal(run.events.filter(event =>
    event.type === 'completion_deferred').length, 2);
  assert.match(run.events.find(event =>
    event.type === 'completion_deferred').text,
  /submit the search|add the requested item|verify the cart|reach checkout/i);
  assert.match(run.events.at(-1).text, /stopped after 2 steps/i);
  assert.equal(run.actionTrace.every(entry => entry.result === 'deferred'), true);
});

test('done without a factual summary becomes an explicit task error', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('[mock:missing-done-summary]', 'target');
  await waitFor(() => run.status === 'error');
  assert.equal(run.events.some(event => event.type === 'assistant_message'), false);
  assert.match(run.events.at(-1).text,
    /did not complete as requested.*no factual completion summary/i);
});

test('action trace persists sanitized decisions and element descriptions',
  async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsearch-trace-test-'));
  const traceFile = path.join(directory, 'actions.jsonl');
  const traceConnection = {observe: async () => ({page: {waitForTimeout: delay},
    url: 'https://example.test/page?token=secret#private', title: 'Example',
    pageText: '', elements: [{id: 0, tag: 'input', type: 'search',
      text: 'Search user@example.com 4111 1111 1111 1111'}]}),
  cleanup: async () => {}};
  try {
    const manager = new TaskManager(traceConnection, {traceFile});
    const run = manager.create('search for phones', 'target');
    await waitFor(() => run.status === 'done');
    const entries = fs.readFileSync(traceFile, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line));
    assert.equal(entries.every(entry => entry.runId === run.id), true);
    const typed = entries.find(entry => entry.action === 'type');
    assert.deepEqual(typed.element, {id: 0, tag: 'input', type: 'search',
      text: 'Search [redacted-email] [redacted-number]'});
    assert.equal(typed.beforeUrl, 'https://example.test/page');
    assert.doesNotMatch(JSON.stringify(entries),
      /secret|private|user@example|4111/);
    assert.equal(run.actionTrace.length, entries.length);
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
});

test('press_enter executes Enter on the observed element', async () => {
  const previousMock = process.env.AGENT_BRIDGE_MOCK;
  process.env.AGENT_BRIDGE_MOCK = '0';
  let pressed;
  const page = {locator: selector => ({count: async () => 1, press: async key => {
    pressed = {selector, key};
  }})};
  try {
    await execute(page, {action: 'press_enter', element_id: 7}, {});
  } finally {
    process.env.AGENT_BRIDGE_MOCK = previousMock;
  }
  assert.deepEqual(pressed,
    {selector: '[data-agent-id="7"]', key: 'Enter'});
});

test('duplicate element labels produce a recoverable action error', async () => {
  const previousMock = process.env.AGENT_BRIDGE_MOCK;
  process.env.AGENT_BRIDGE_MOCK = '0';
  let clicked = false;
  const page = {locator: () => ({count: async () => 2,
    click: async () => { clicked = true; }})};
  try {
    await assert.rejects(
      execute(page, {action: 'click', element_id: 8}, {}),
      error => error.name === 'RecoverableActionError' &&
        /resolved to 2 elements.*re-scan/i.test(error.message));
  } finally {
    process.env.AGENT_BRIDGE_MOCK = previousMock;
  }
  assert.equal(clicked, false);
});

test('navigation completes before the next page read', async () => {
  const previousMock = process.env.AGENT_BRIDGE_MOCK;
  process.env.AGENT_BRIDGE_MOCK = '0';
  let navigationComplete = false;
  let resolveNavigation;
  const navigation = new Promise(resolve => { resolveNavigation = resolve; });
  const page = {
    waitForNavigation: async options => {
      assert.deepEqual(options,
        {waitUntil: 'domcontentloaded', timeout: 5000});
      await navigation;
      navigationComplete = true;
    },
    waitForLoadState: async state => assert.equal(state, 'networkidle'),
    locator: () => ({count: async () => 1, press: async () => {
      setImmediate(resolveNavigation);
    }}),
    evaluate: async () => {
      if (!navigationComplete) {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return 'Texas page content';
    },
  };
  try {
    await execute(page, {action: 'press_enter', element_id: 0}, {},
      {navigationLikely: true});
    assert.equal(await page.evaluate(() => document.body.textContent),
      'Texas page content');
  } finally {
    process.env.AGENT_BRIDGE_MOCK = previousMock;
  }
});

test('runs have unpredictable distinct ids and isolated events', async () => {
  const manager = new TaskManager(connection);
  const first = manager.create('first task', 'target-one');
  const second = manager.create('second task', 'target-two');
  await waitFor(() => first.status === 'done' && second.status === 'done');
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.id, second.id);
  assert.ok(first.events.every(event => !event.text.includes('target-two')));
  assert.ok(second.events.every(event => !event.text.includes('target-one')));
});

test('cancellation is final and does not affect another run', async () => {
  const manager = new TaskManager(connection);
  const slow = manager.create('[mock:slow] task', 'slow-target');
  const other = manager.create('normal task', 'other-target');
  await waitFor(() => slow.events.some(event => event.type === 'action_started'));
  assert.equal(manager.cancel(slow.id), true);
  assert.equal(manager.cancel(slow.id), false);
  await delay(60);
  assert.equal(slow.status, 'cancelled');
  assert.equal(slow.events.at(-1).type, 'cancelled');
  assert.equal(slow.events.some(event => event.type === 'action_completed'), false);
  await waitFor(() => other.status === 'done');
});

test('denial is scoped, single-use, and final', async () => {
  const manager = new TaskManager(connection);
  const first = manager.create('[mock:confirmation] first', 'target-one');
  const second = manager.create('[mock:confirmation] second', 'target-two');
  await waitFor(() => first.status === 'awaiting_confirmation' &&
    second.status === 'awaiting_confirmation');
  const firstId = first.pendingConfirmation.confirmationId;
  assert.equal(manager.confirm(first.id,
    second.pendingConfirmation.confirmationId, false), false);
  assert.equal(manager.confirm(first.id, firstId, false), true);
  assert.equal(manager.confirm(first.id, firstId, true), false);
  assert.equal(first.status, 'denied');
  assert.equal(first.events.at(-1).type, 'confirmation_resolved');
  assert.equal(first.events.at(-1).approved, false);
  assert.equal(second.status, 'awaiting_confirmation');
});

test('approval is scoped, single-use, and resumes exactly once', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('[mock:confirmation] harmless action', 'target');
  await waitFor(() => run.status === 'awaiting_confirmation');
  const confirmationId = run.pendingConfirmation.confirmationId;
  assert.match(confirmationId, /^[0-9a-f-]{36}$/);
  assert.equal(manager.confirm('00000000-0000-4000-8000-000000000000',
    confirmationId, true), false);
  assert.equal(manager.confirm(run.id, 'wrong-confirmation', true), false);
  assert.equal(manager.confirm(run.id, confirmationId, true), true);
  assert.equal(manager.confirm(run.id, confirmationId, true), false);
  await waitFor(() => run.status === 'done');
  assert.equal(run.events.filter(event =>
    event.type === 'confirmation_resolved').length, 1);
  assert.equal(run.pendingConfirmation, null);
  assert.equal(run.purchaseAuthorization, null);
});

test('confirmation remains pending indefinitely and cancellation fails closed',
  async () => {
  const realNow = Date.now;
  const manager = new TaskManager(connection);
  const pending = manager.create('[mock:confirmation] waits', 'target');
  await waitFor(() => pending.status === 'awaiting_confirmation');
  const pendingId = pending.pendingConfirmation.confirmationId;
  try {
    Date.now = () => realNow() + (24 * 60 * 60 * 1000);
    assert.equal(pending.status, 'awaiting_confirmation');
    assert.equal(manager.confirm(pending.id, pendingId, true), true);
  } finally {
    Date.now = realNow;
  }
  await waitFor(() => pending.status === 'done');

  const cancelled = manager.create('[mock:confirmation] cancel', 'target');
  await waitFor(() => cancelled.status === 'awaiting_confirmation');
  const cancelledId = cancelled.pendingConfirmation.confirmationId;
  assert.equal(manager.cancel(cancelled.id), true);
  assert.equal(manager.confirm(cancelled.id, cancelledId, true), false);
  assert.equal(cancelled.pendingConfirmation, null);
});

test('timeout and maximum step limit render terminal errors', async () => {
  const timeoutManager = new TaskManager(connection, {taskTimeoutMs: 10});
  const timeout = timeoutManager.create('[mock:timeout] task', 'target');
  await waitFor(() => timeout.status === 'error');
  assert.match(timeout.events.at(-1).text, /timed out/i);

  const stepManager = new TaskManager(connection, {stepLimit: 2});
  const steps = stepManager.create('[mock:max-steps] task', 'target');
  await waitFor(() => steps.status === 'error');
  assert.match(steps.events.at(-1).text, /after 2 steps/i);
});

test('task failure clears pending authorization and emits a safe error', async () => {
  const failingConnection = {observe: async () => {
    throw new Error('navigation failed');
  }};
  const manager = new TaskManager(failingConnection);
  const run = manager.create('failure', 'target');
  await waitFor(() => run.status === 'error');
  assert.match(run.events.at(-1).text, /navigation failed/i);
  assert.equal(run.pendingConfirmation, null);
  assert.equal(run.purchaseAuthorization, null);
});

test('page crash reattaches the same run to a replacement target',
  async () => {
  let observations = 0;
  let recoveries = 0;
  const recoveryArguments = [];
  const cleanedTargets = [];
  const crashThenReconnect = {
    observe: async (targetId, run) => {
      observations += 1;
      if (observations === 1) {
        throw new Error(
          'page.waitForLoadState: Navigation failed because page crashed!');
      }
      assert.equal(targetId, 'new-target');
      assert.deepEqual(run.messages, []);
      return {page: {waitForTimeout: delay}, url: 'https://example.test/',
        title: `Reconnected ${targetId}`, pageText: 'Complete replacement page',
        elements: [{id: 0, tag: 'input', type: 'search', text: 'Search'}]};
    },
    recoverAfterCrash: async (targetId, lastObservedUrl) => {
      recoveries += 1;
      recoveryArguments.push({targetId, lastObservedUrl});
      return {recovered: true, newTargetId: 'new-target'};
    },
    cleanup: async targetId => cleanedTargets.push(targetId),
  };
  const manager = new TaskManager(crashThenReconnect);

  const recovered = manager.create('first task', 'crashed-target');
  await waitFor(() => recovered.status === 'done' && !recovered.loopActive);
  assert.equal(recovered.targetId, 'new-target');
  assert.equal(recoveries, 1);
  assert.deepEqual(recoveryArguments,
    [{targetId: 'crashed-target', lastObservedUrl: null}]);
  assert.equal(recovered.events.some(event =>
    event.type === 'action_retry_required' &&
      event.targetId === 'new-target'), true);
  assert.equal(recovered.events.some(event => event.type === 'error'), false);
  assert.equal(recovered.events.some(event => event.type === 'page_observed'),
    true);
  assert.equal(recovered.events.some(event =>
    event.type === 'assistant_message' && /completed/i.test(event.text)), true);
  assert.deepEqual(cleanedTargets, ['new-target']);
});

test('page crash remains terminal when no replacement target is found',
  async () => {
    const connection = {
      observe: async () => {
        throw new Error(
          'page.waitForLoadState: Navigation failed because page crashed!');
      },
      recoverAfterCrash: async () => ({recovered: false}),
      cleanup: async () => assert.fail('dead page must not be cleaned up'),
    };
    const manager = new TaskManager(connection);
    const run = manager.create('task', 'dead-target');

    await waitFor(() => run.status === 'error' && !run.loopActive);
    assert.equal(run.events.at(-1).text,
      'The browser page crashed unexpectedly and the task could not continue. ' +
      'Please try again.');
  });

test('crash recovery receives the last successfully observed URL', async () => {
  let observations = 0;
  let recoveryUrl;
  const page = {url: () => 'https://www.amazon.com/s?k=iphone',
    waitForTimeout: delay};
  const connection = {
    observe: async (targetId, run) => {
      observations += 1;
      if (observations === 2) {
        throw new Error(
          'page.waitForLoadState: Navigation failed because page crashed!');
      }
      if (observations > 2) run.task = 'replacement task';
      return {page, url: observations === 1 ?
        'https://www.amazon.com/s?k=iphone' : 'https://www.amazon.com/',
      title: targetId, pageText: 'Replacement page',
      elements: [{id: 0, tag: 'input', type: 'search', text: 'Search'}]};
    },
    recoverAfterCrash: async (targetId, lastObservedUrl) => {
      assert.equal(targetId, 'dead-target');
      recoveryUrl = lastObservedUrl;
      return {recovered: true, newTargetId: 'replacement-target'};
    },
    cleanup: async () => {},
  };
  const manager = new TaskManager(connection);
  const run = manager.create('[mock:max-steps]', 'dead-target');

  await waitFor(() => run.status === 'done' && !run.loopActive);
  assert.equal(recoveryUrl, 'https://www.amazon.com/s?k=iphone');
  assert.equal(run.targetId, 'replacement-target');
  assert.equal(run.lastObservedUrl, 'https://www.amazon.com/');
});

test('page overlays are cleaned up after successful and failed tasks', async () => {
  const cleanedTargets = [];
  const successfulConnection = {
    ...connection,
    cleanup: async targetId => cleanedTargets.push(targetId),
  };
  const successfulManager = new TaskManager(successfulConnection);
  const successful = successfulManager.create('normal task', 'success-target');
  await waitFor(() => successful.status === 'done' && !successful.loopActive);

  const failedConnection = {
    observe: async () => { throw new Error('observation failed'); },
    cleanup: async targetId => cleanedTargets.push(targetId),
  };
  const failedManager = new TaskManager(failedConnection);
  const failed = failedManager.create('failure', 'failure-target');
  await waitFor(() => failed.status === 'error' && !failed.loopActive);

  assert.deepEqual(cleanedTargets, ['success-target', 'failure-target']);
});

test('model actions cannot navigate locally or target unobserved elements', () => {
  const observation = {elements: [{id: 4}]};
  assert.doesNotThrow(() => validateAction(
    {action: 'navigate', url: 'https://www.google.com/search'}, observation));
  assert.throws(() => validateAction(
    {action: 'navigate', url: 'http://127.0.0.1:9333/health'}, observation),
  /blocked/i);
  assert.throws(() => validateAction(
    {action: 'navigate', url: 'file:///etc/passwd'}, observation), /blocked/i);
  assert.throws(() => validateAction(
    {action: 'click', element_id: 99}, observation), /not in/i);
});
