'use strict';

const crypto = require('node:crypto');
const {decide, execute} = require('./agent-core');

const DEFAULT_STEP_LIMIT = 30;
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60000;

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' ||
    normalized.endsWith('.localhost') || /^127\./.test(normalized) ||
    /^10\./.test(normalized) || /^192\.168\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^(fc|fd|fe80:)/i.test(normalized);
}

function validateAction(action, observation) {
  if (action.action === 'navigate') {
    let url;
    try {
      url = new URL(action.url);
    } catch {
      throw new Error('Invalid navigation URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username ||
        url.password || isPrivateHostname(url.hostname)) {
      throw new Error(
        'Navigation to local, private, credentialed, or non-HTTP URLs is blocked.');
    }
  }
  if (['click', 'type', 'accept_autofill'].includes(action.action) &&
      !observation.elements.some(element => element.id === action.element_id)) {
    throw new Error('The requested element is not in the current page observation.');
  }
}

class TaskManager {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.runs = new Map();
    this.stepLimit = options.stepLimit || DEFAULT_STEP_LIMIT;
    this.taskTimeoutMs = options.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ||
      DEFAULT_CONFIRMATION_TIMEOUT_MS;
  }

  create(task, targetId) {
    const now = Date.now();
    const taskTimeout = /\[mock:timeout\]/i.test(task) ? 10 : this.taskTimeoutMs;
    const run = {id: crypto.randomUUID(), task, targetId, status: 'running',
      events: [], sequence: 0, messages: [], paymentFieldTouched: false,
      purchaseAuthorization: null, pendingConfirmation: null, cancelled: false,
      startedAt: now, deadline: now + taskTimeout, loopActive: false};
    this.runs.set(run.id, run);
    this.emit(run, 'bridge_received', 'Bridge accepted the task.', false);
    void this.loop(run);
    return run;
  }

  emit(run, type, text, persist = false, data = {}) {
    if (run.cancelled && type !== 'cancelled') return;
    run.events.push({sequence: ++run.sequence, type, text, persist, ...data});
  }

  invalidateConfirmation(run) {
    run.pendingConfirmation = null;
    run.purchaseAuthorization = null;
  }

  ensureRunning(run) {
    if (run.cancelled || run.status === 'cancelled') return false;
    if (Date.now() >= run.deadline) {
      this.fail(run, 'Task timed out.');
      return false;
    }
    return run.status === 'running';
  }

  fail(run, message) {
    if (run.cancelled || ['done', 'denied', 'error'].includes(run.status)) return;
    run.status = 'error';
    this.invalidateConfirmation(run);
    this.emit(run, 'error', message, true);
  }

  async loop(run) {
    if (run.loopActive || !this.ensureRunning(run)) return;
    run.loopActive = true;
    try {
      for (let step = 1; step <= this.stepLimit; ++step) {
        if (!this.ensureRunning(run)) return;
        this.emit(run, 'page_observation_started', 'Reading the active page…');
        const observation = await this.connection.observe(run.targetId, run);
        if (!this.ensureRunning(run)) return;
        this.emit(run, 'page_observed',
          `Observed ${observation.title || observation.url} (${observation.elements.length} elements).`);
        this.emit(run, 'model_request_started', 'Asking Grok for the next action…');
        const action = await decide(run, observation);
        if (!this.ensureRunning(run)) return;
        validateAction(action, observation);
        this.emit(run, 'action_decided',
          action.reasoning || `Decided to ${action.action}.`, true,
          {action: action.action});
        if (action.action === 'request_purchase_confirmation') {
          run.mockConfirmationRequested = true;
          const confirmationId = crypto.randomUUID();
          run.pendingConfirmation = {confirmationId,
            toolCallId: action.toolCallId, expiresAt: Date.now() +
              (/\[mock:expired-confirmation\]/i.test(run.task) ? 10 :
                this.confirmationTimeoutMs), consumed: false};
          run.status = 'awaiting_confirmation';
          this.emit(run, 'confirmation_required',
            action.summary || 'Confirm this action?', true,
            {confirmationId, summary: action.summary || 'Confirm this action?'});
          return;
        }
        if (action.action === 'done') {
          run.status = 'done';
          this.invalidateConfirmation(run);
          this.emit(run, 'done', action.reasoning || 'Task complete.', true);
          return;
        }
        if (action.action === 'click' && run.paymentFieldTouched) {
          if (!run.purchaseAuthorization?.approved) {
            throw new Error('Purchase action blocked: no scoped approval');
          }
          run.purchaseAuthorization = null;
        }
        this.emit(run, 'action_started', `Executing ${action.action}…`);
        if (!this.ensureRunning(run)) return;
        await execute(observation.page, action, run);
        if (!this.ensureRunning(run)) return;
        if (action.action === 'accept_autofill') run.paymentFieldTouched = true;
        run.messages.push({role: 'tool', tool_call_id: action.toolCallId,
          content: 'Action result: ok'});
        this.emit(run, 'action_completed', `Completed ${action.action}.`, true,
          {action: action.action});
      }
      this.fail(run, `Agent stopped after ${this.stepLimit} steps.`);
    } catch (error) {
      this.fail(run, error.message || String(error));
    } finally {
      run.loopActive = false;
    }
  }

  confirm(runId, confirmationId, approved) {
    const run = this.runs.get(runId);
    const pending = run?.pendingConfirmation;
    if (!run || run.cancelled || run.status !== 'awaiting_confirmation' ||
        !pending || pending.consumed || pending.confirmationId !== confirmationId) {
      return false;
    }
    if (Date.now() >= pending.expiresAt) {
      this.fail(run, 'Confirmation expired. The action was not performed.');
      return false;
    }
    pending.consumed = true;
    run.pendingConfirmation = null;
    run.messages.push({role: 'tool', tool_call_id: pending.toolCallId,
      content: approved ? 'Human approved this action.' :
        'Human denied this action. Do not complete it.'});
    this.emit(run, 'confirmation_resolved',
      approved ? 'Action approved.' : 'Action denied. Nothing was performed.',
      true, {approved, confirmationId});
    if (!approved) {
      run.status = 'denied';
      run.purchaseAuthorization = null;
      return true;
    }
    run.purchaseAuthorization = {approved: true, confirmationId,
      toolCallId: pending.toolCallId};
    run.status = 'running';
    setImmediate(() => void this.loop(run));
    return true;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || ['cancelled', 'done', 'denied', 'error'].includes(run.status)) {
      return false;
    }
    run.cancelled = true;
    run.status = 'cancelled';
    this.invalidateConfirmation(run);
    run.events.push({sequence: ++run.sequence, type: 'cancelled',
      text: 'Task cancelled. No further actions will run.', persist: true});
    return true;
  }
}

module.exports = {TaskManager, validateAction};
