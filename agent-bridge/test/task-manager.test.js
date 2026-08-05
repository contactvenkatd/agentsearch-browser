'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {TaskManager} = require('../src/task-manager');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('purchase confirmation is scoped to its run and confirmation id', async () => {
  process.env.AGENT_BRIDGE_MOCK = '1';
  const connection = {observe: async targetId => ({
    page: {}, url: 'https://shop.example/', title: targetId, elements: []
  })};
  const manager = new TaskManager(connection);
  const first = manager.create('buy the item', 'target-one');
  const second = manager.create('buy another item', 'target-two');
  await tick();
  assert.equal(first.status, 'awaiting_confirmation');
  assert.equal(second.status, 'awaiting_confirmation');
  assert.notEqual(first.pendingConfirmation.confirmationId,
                  second.pendingConfirmation.confirmationId);
  assert.equal(manager.confirm(first.id,
    second.pendingConfirmation.confirmationId, true), false);
  assert.equal(manager.confirm(first.id,
    first.pendingConfirmation.confirmationId, true), true);
  await tick();
  assert.equal(first.status, 'done');
  assert.equal(second.status, 'awaiting_confirmation');
});

test('mock mode verifies the non-purchase message path without xAI', async () => {
  process.env.AGENT_BRIDGE_MOCK = '1';
  const manager = new TaskManager({observe: async () => ({
    page: {}, url: 'https://example.test/', title: 'Example', elements: []
  })});
  const run = manager.create('summarize this page', 'target');
  await tick();
  assert.equal(run.status, 'done');
  assert.deepEqual(run.events.map(event => event.type), [
    'bridge_received', 'page_observation_started', 'page_observed',
    'model_request_started', 'action_decided', 'done'
  ]);
});
