'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('../src/server');

process.env.AGENT_BRIDGE_MOCK = '1';

async function withServer(callback) {
  const instance = createServer();
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  try { await callback(`http://127.0.0.1:${address.port}`, instance.manager); }
  finally { await new Promise(resolve => instance.server.close(resolve)); }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function createTask(baseUrl, task) {
  return fetch(`${baseUrl}/v1/tasks`, {method: 'POST',
    body: JSON.stringify({task, targetId: 'target'})}).then(response =>
    response.json());
}
async function waitForStatus(baseUrl, runId, expected) {
  for (let attempt = 0; attempt < 100; ++attempt) {
    const response = await fetch(
      `${baseUrl}/v1/tasks/${runId}/events?after=0`).then(value => value.json());
    if (response.status === expected) return response;
    await delay(5);
  }
  throw new Error(`run did not reach ${expected}`);
}

test('health and task event endpoints work without xAI or CDP', async () => {
  await withServer(async baseUrl => {
    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.deepEqual(health, {ok: true, mock: true,
      cdpEndpoint: 'http://127.0.0.1:9222'});
    const createdResponse = await fetch(`${baseUrl}/v1/tasks`, {method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({task: 'safe mock task', targetId: 'target'})});
    assert.equal(createdResponse.status, 202);
    const {runId} = await createdResponse.json();
    let payload;
    for (let attempt = 0; attempt < 50; ++attempt) {
      payload = await fetch(`${baseUrl}/v1/tasks/${runId}/events?after=0`)
        .then(response => response.json());
      if (payload.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(payload.status, 'done');
    assert.deepEqual(payload.events.map(event => event.sequence),
      payload.events.map((_, index) => index + 1));
  });
});

test('summary API queues one assistant answer before done', async () => {
  await withServer(async baseUrl => {
    const created = await createTask(baseUrl, 'summarize this page');
    const payload = await waitForStatus(baseUrl, created.runId, 'done');
    const answerIndex = payload.events.findIndex(event =>
      event.type === 'assistant_message');
    const doneIndex = payload.events.findIndex(event => event.type === 'done');
    assert.ok(answerIndex >= 0 && answerIndex < doneIndex);
    assert.equal(payload.events.filter(event =>
      event.type === 'assistant_message').length, 1);
    assert.equal(payload.events[answerIndex].text,
      'Mock readable page summary.');
  });
});

test('request validation and final cancellation are enforced', async () => {
  await withServer(async baseUrl => {
    const invalidJson = await fetch(`${baseUrl}/v1/tasks`, {method: 'POST',
      body: '{'});
    assert.equal(invalidJson.status, 400);
    const invalidBody = await fetch(`${baseUrl}/v1/tasks`, {method: 'POST',
      body: JSON.stringify({task: '', targetId: 1})});
    assert.equal(invalidBody.status, 400);
    const created = await fetch(`${baseUrl}/v1/tasks`, {method: 'POST',
      body: JSON.stringify({task: '[mock:slow]', targetId: 'target'})})
      .then(response => response.json());
    const cancelUrl = `${baseUrl}/v1/tasks/${created.runId}/cancel`;
    assert.equal((await fetch(cancelUrl, {method: 'POST'})).status, 200);
    assert.equal((await fetch(cancelUrl, {method: 'POST'})).status, 409);
    assert.equal((await fetch(
      `${baseUrl}/v1/tasks/${created.runId}/events?after=bad`)).status, 400);
  });
});

test('confirmation endpoints reject wrong, reused, and cancelled approvals', async () => {
  await withServer(async baseUrl => {
    const approval = await createTask(baseUrl, '[mock:confirmation] approve');
    const awaiting = await waitForStatus(baseUrl, approval.runId,
      'awaiting_confirmation');
    const confirmationId = awaiting.events.find(event =>
      event.type === 'confirmation_required').confirmationId;
    const confirmationUrl =
      `${baseUrl}/v1/tasks/${approval.runId}/confirmation`;
    assert.equal((await fetch(confirmationUrl, {method: 'POST', body:
      JSON.stringify({confirmationId: 'wrong', approved: true})})).status, 409);
    assert.equal((await fetch(confirmationUrl, {method: 'POST', body:
      JSON.stringify({confirmationId, approved: true})})).status, 200);
    assert.equal((await fetch(confirmationUrl, {method: 'POST', body:
      JSON.stringify({confirmationId, approved: true})})).status, 409);
    await waitForStatus(baseUrl, approval.runId, 'done');

    const cancellation = await createTask(baseUrl,
      '[mock:confirmation] cancel');
    const pending = await waitForStatus(baseUrl, cancellation.runId,
      'awaiting_confirmation');
    const cancelledId = pending.events.find(event =>
      event.type === 'confirmation_required').confirmationId;
    await fetch(`${baseUrl}/v1/tasks/${cancellation.runId}/cancel`,
      {method: 'POST'});
    assert.equal((await fetch(
      `${baseUrl}/v1/tasks/${cancellation.runId}/confirmation`,
      {method: 'POST', body: JSON.stringify({confirmationId: cancelledId,
        approved: true})})).status, 409);
  });
});

test('confirmation remains actionable after an arbitrary clock jump', async () => {
  const instance = createServer();
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const realNow = Date.now;
  try {
    const created = await createTask(baseUrl, '[mock:confirmation] waits');
    const pending = await waitForStatus(baseUrl, created.runId,
      'awaiting_confirmation');
    const confirmationId = pending.events.find(event =>
      event.type === 'confirmation_required').confirmationId;
    Date.now = () => realNow() + (7 * 24 * 60 * 60 * 1000);
    const response = await fetch(
      `${baseUrl}/v1/tasks/${created.runId}/confirmation`, {method: 'POST',
        body: JSON.stringify({confirmationId, approved: false})});
    assert.equal(response.status, 200);
    const denied = await waitForStatus(baseUrl, created.runId, 'denied');
    assert.equal(denied.status, 'denied');
  } finally {
    Date.now = realNow;
    await new Promise(resolve => instance.server.close(resolve));
  }
});

test('mock mode can deterministically return an invalid bridge response', async () => {
  await withServer(async baseUrl => {
    const created = await createTask(baseUrl, '[mock:invalid-response]');
    const response = await fetch(
      `${baseUrl}/v1/tasks/${created.runId}/events?after=0`);
    assert.equal(response.status, 200);
    await assert.rejects(response.json());
  });
});
