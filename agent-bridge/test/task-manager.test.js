'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TaskManager, validateAction} = require('../src/task-manager');

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

test('normal mock task emits ordered events and completes', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create('summarize this page', 'target');
  await waitFor(() => run.status === 'done');
  assert.deepEqual(run.events.map(event => event.sequence),
    run.events.map((_, index) => index + 1));
  assert.deepEqual(run.events.map(event => event.type), [
    'bridge_received', 'page_observation_started', 'page_observed',
    'model_request_started', 'action_decided', 'done'
  ]);
});

test('safe do-not-purchase task does not request confirmation', async () => {
  const manager = new TaskManager(connection);
  const run = manager.create(
    'Go to google.com and search for wireless headphones. Do not purchase anything.',
    'target');
  await waitFor(() => run.status === 'done');
  assert.equal(run.events.some(event =>
    event.type === 'confirmation_required'), false);
  assert.deepEqual(run.mockExecutedActions,
    ['navigate', 'type', 'scroll', 'wait']);
  assert.equal(run.events.filter(event =>
    event.type === 'action_completed').length, 4);
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

test('expired confirmation and approval after cancellation fail closed', async () => {
  const expiringManager = new TaskManager(connection,
    {confirmationTimeoutMs: 1});
  const expired = expiringManager.create('[mock:confirmation] expires', 'target');
  await waitFor(() => expired.status === 'awaiting_confirmation');
  const expiredId = expired.pendingConfirmation.confirmationId;
  await delay(5);
  assert.equal(expiringManager.confirm(expired.id, expiredId, true), false);
  assert.equal(expired.status, 'error');
  assert.match(expired.events.at(-1).text, /expired/i);

  const manager = new TaskManager(connection);
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
