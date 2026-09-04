'use strict';

require('dotenv').config();

const http = require('node:http');
const {ChromiumConnection, MockChromiumConnection} = require('./chromium');
const {TaskManager} = require('./task-manager');

const host = '127.0.0.1';
const port = Number(process.env.AGENT_BRIDGE_PORT || 9333);

function json(res, status, value) {
  const responseBody = JSON.stringify(value);
  res.writeHead(status, {'content-type': 'application/json',
    'content-length': Buffer.byteLength(responseBody), 'cache-control': 'no-store'});
  res.end(responseBody);
}

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 65536) throw new Error('request too large');
  }
  if (!value) return {};
  try { return JSON.parse(value); } catch { throw new SyntaxError('invalid JSON'); }
}

function createServer(options = {}) {
  const cdpEndpoint = options.cdpEndpoint || process.env.AGENTSEARCH_CDP_URL ||
    'http://127.0.0.1:9222';
  const connection = options.connection ||
    (process.env.AGENT_BRIDGE_MOCK === '1' ? new MockChromiumConnection() :
      new ChromiumConnection(cdpEndpoint));
  const manager = options.manager || new TaskManager(connection, options.managerOptions);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {ok: true, mock: process.env.AGENT_BRIDGE_MOCK === '1',
          cdpEndpoint});
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const input = await body(req);
        if (typeof input.task !== 'string' || !input.task.trim() ||
            input.task.length > 10000 || typeof input.targetId !== 'string' ||
            !input.targetId.trim() || input.targetId.length > 256) {
          return json(res, 400, {error: 'valid task and targetId are required'});
        }
        const run = manager.create(input.task.trim(), input.targetId.trim());
        return json(res, 202, {runId: run.id});
      }
      const match = url.pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]+)\/(events|confirmation|cancel)$/i);
      const run = match && manager.runs.get(match[1]);
      if (!run) return json(res, 404, {error: 'run not found'});
      if (req.method === 'GET' && match[2] === 'events') {
        const afterValue = url.searchParams.get('after') || '0';
        if (!/^\d+$/.test(afterValue)) {
          return json(res, 400, {error: 'after must be a non-negative integer'});
        }
        const after = Number(afterValue);
        if (process.env.AGENT_BRIDGE_MOCK === '1' &&
            /\[mock:invalid-response\]/i.test(run.task)) {
          res.writeHead(200, {'content-type': 'application/json',
            'cache-control': 'no-store'});
          return res.end('{invalid mock response');
        }
        return json(res, 200, {status: run.status,
          events: run.events.filter(event => event.sequence > after)});
      }
      if (req.method === 'POST' && match[2] === 'confirmation') {
        const input = await body(req);
        if (typeof input.confirmationId !== 'string' ||
            typeof input.approved !== 'boolean') {
          return json(res, 400, {error: 'confirmationId and approved are required'});
        }
        return manager.confirm(run.id, input.confirmationId, input.approved) ?
          json(res, 200, {ok: true}) :
          json(res, 409, {error: 'confirmation is stale or invalid'});
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        return manager.cancel(run.id) ? json(res, 200, {ok: true}) :
          json(res, 409, {error: 'task is already final'});
      }
      return json(res, 404, {error: 'not found'});
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(res, status, {error: status === 400 ? error.message :
        'internal bridge error'});
    }
  });
  return {server, manager};
}

const instance = createServer();
if (require.main === module) instance.server.listen(port, host, () =>
  console.log(`AgentSearch bridge listening on http://${host}:${port}`));
module.exports = {createServer};
