'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {decide, execute, RecoverableActionError} = require('./agent-core');
const {isPageOrBrowserCrashError} = require('./chromium');

const DEFAULT_STEP_LIMIT = 30;
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const DEFAULT_TRACE_FILE = path.join(os.tmpdir(),
  'agentsearch-action-trace.jsonl');

function safeTraceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '(unavailable)';
  }
}

function cleanTraceText(value, maxLength = 240) {
  return String(value || '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:\d[ -]?){12,19}/g, '[redacted-number]')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function requestedMilestones(task) {
  const normalized = task.toLowerCase();
  return {
    searchSubmitted: /\bsearch\b/.test(normalized),
    productPageOpened: /\b(?:open|select|choose|find)\b.{0,40}\b(?:product|item)\b/.test(normalized),
    addToCartExecuted: /\badd\b.{0,20}\b(?:cart|basket)\b/.test(normalized),
    cartObserved: /\b(?:cart|basket)\b/.test(normalized),
    checkoutReached: /\bcheckout\b|\border confirmation\b/.test(normalized),
    confirmationRequested: /\b(?:buy|purchase|place (?:the )?order|order confirmation)\b/.test(normalized),
  };
}

function observeMilestones(run, observation) {
  let url;
  try { url = new URL(observation.url); } catch { url = null; }
  const pathname = url?.pathname || '';
  const pageText = `${observation.title || ''} ${observation.pageText || ''}`;
  if (/\/(?:dp|gp\/product)\//i.test(pathname)) {
    run.milestones.productPageOpened = true;
    run.milestoneEvidence.product = cleanTraceText(observation.title, 160);
  }
  if (/\/(?:cart|gp\/cart)/i.test(pathname) || /\bshopping cart\b/i.test(pageText)) {
    run.milestones.cartObserved = true;
  }
  if (/\/(?:checkout|gp\/buy|buy\/)/i.test(pathname) ||
      /\bcheckout\b/i.test(observation.title || '')) {
    run.milestones.checkoutReached = true;
  }
}

function missingMilestones(run) {
  return Object.keys(run.requiredMilestones).filter(name =>
    run.requiredMilestones[name] && !run.milestones[name]);
}

function milestoneLabel(name) {
  return ({searchSubmitted: 'submit the search',
    productPageOpened: 'open the requested product page',
    addToCartExecuted: 'add the requested item to the cart',
    cartObserved: 'verify the cart', checkoutReached: 'reach checkout',
    confirmationRequested: 'request purchase confirmation'})[name] || name;
}

function factualCompletionSummary(run, proposedSummary) {
  const completed = [];
  if (run.milestones.searchSubmitted) completed.push('submitted the search');
  if (run.milestones.productPageOpened) completed.push(
    `opened ${run.milestoneEvidence.product || 'a product page'}`);
  if (run.milestones.addToCartExecuted) completed.push('executed Add to Cart');
  if (run.milestones.cartObserved) completed.push('verified the cart page');
  if (run.milestones.checkoutReached) completed.push('reached checkout');
  if (run.milestones.confirmationRequested) completed.push(
    'requested purchase confirmation');
  if (Object.values(run.requiredMilestones).some(Boolean)) {
    return `Task completed: ${completed.join(', ')}.`;
  }
  return cleanTraceText(proposedSummary, 500);
}

function isUngroundedProductRefusal(action, task = '') {
  if (action.action !== 'respond' ||
      !/\b(?:search|buy|purchase|cart|checkout|product|amazon)\b/i.test(task)) {
    return false;
  }
  return /\b(?:does not|doesn't|doesnt) exist\b|\b(?:has|have|was|were|is|are) not (?:been )?released\b|\bnot released yet\b|\bno such product exists\b/i
    .test(action.text || '');
}

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
  if (action.action === 'respond' &&
      (typeof action.text !== 'string' || !action.text.trim())) {
    throw new Error('Grok returned an empty text response.');
  }
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
  if (['click', 'type', 'press_enter', 'accept_autofill'].includes(action.action) &&
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
    this.traceFile = options.traceFile || process.env.AGENTSEARCH_ACTION_TRACE_FILE ||
      DEFAULT_TRACE_FILE;
  }

  create(task, targetId) {
    const now = Date.now();
    const taskTimeout = /\[mock:timeout\]/i.test(task) ? 10 : this.taskTimeoutMs;
    const run = {id: crypto.randomUUID(), task, targetId, status: 'running',
      events: [], sequence: 0, messages: [], paymentFieldTouched: false,
      purchaseAuthorization: null, pendingConfirmation: null, cancelled: false,
      startedAt: now, deadline: now + taskTimeout, loopActive: false,
      lastObservedUrl: null,
      pendingSearchSubmission: false, actionTrace: [],
      requiredMilestones: requestedMilestones(task),
      milestones: {searchSubmitted: false, productPageOpened: false,
        addToCartExecuted: false, cartObserved: false, checkoutReached: false,
        confirmationRequested: false}, milestoneEvidence: {}};
    this.runs.set(run.id, run);
    this.emit(run, 'bridge_received', 'Bridge accepted the task.', false);
    void this.loop(run);
    return run;
  }

  emit(run, type, text, persist = false, data = {}) {
    if (run.cancelled && type !== 'cancelled') return;
    run.events.push({sequence: ++run.sequence, type, text, persist, ...data});
    console.debug(`[AgentSearch ${run.id}] ${type}: ${text}`);
  }

  traceAction(run, action, observation, element, afterUrl, result = 'ok') {
    const entry = {timestamp: new Date().toISOString(), runId: run.id,
      action: action.action, reasoning: cleanTraceText(action.reasoning),
      element: element ? {id: element.id, tag: element.tag,
        type: cleanTraceText(element.type, 40),
        text: cleanTraceText(element.text, 160)} : null,
      beforeUrl: safeTraceUrl(observation?.url),
      afterUrl: safeTraceUrl(afterUrl || observation?.url), result};
    run.actionTrace.push(entry);
    try {
      fs.appendFileSync(this.traceFile, `${JSON.stringify(entry)}\n`,
        {encoding: 'utf8', mode: 0o600});
    } catch (error) {
      console.warn(`AgentSearch action trace write failed: ${error.message || error}`);
    }
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
    let resumeAfterCrash = false;
    try {
      for (let step = 1; step <= this.stepLimit; ++step) {
        if (!this.ensureRunning(run)) return;
        this.emit(run, 'page_observation_started', 'Reading the active page…');
        const observation = await this.connection.observe(run.targetId, run);
        run.lastObservedUrl = observation.url;
        observeMilestones(run, observation);
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
          run.milestones.confirmationRequested = true;
          this.traceAction(run, action, observation, null, observation.url);
          run.mockConfirmationRequested = true;
          const confirmationId = crypto.randomUUID();
          run.pendingConfirmation = {confirmationId,
            toolCallId: action.toolCallId,
            remainingTaskMs: Math.max(1, run.deadline - Date.now()),
            consumed: false};
          run.status = 'awaiting_confirmation';
          this.emit(run, 'confirmation_required',
            action.summary || 'Confirm this action?', true,
            {confirmationId, summary: action.summary || 'Confirm this action?'});
          return;
        }
        if (action.action === 'respond') {
          if (isUngroundedProductRefusal(action, run.task)) {
            const correction = 'The response relied on an ungrounded product ' +
              'existence or release-date assumption. Ignore prior knowledge, ' +
              'continue from the live page evidence, and do not repeat that claim.';
            run.messages.push({role: 'tool', tool_call_id: action.toolCallId,
              content: correction});
            this.traceAction(run, action, observation, null, observation.url,
              'deferred: ungrounded product refusal');
            this.emit(run, 'completion_deferred', correction);
            continue;
          }
          this.traceAction(run, action, observation, null, observation.url);
          this.emit(run, 'assistant_message', action.text.trim(), true);
          run.status = 'done';
          this.invalidateConfirmation(run);
          this.emit(run, 'done', action.reasoning || 'Response complete.');
          return;
        }
        if (action.action === 'done') {
          const missing = missingMilestones(run);
          if (run.pendingSearchSubmission || missing.length) {
            const explanation = run.pendingSearchSubmission ?
              'submit the entered search' : missing.map(milestoneLabel).join(', ');
            run.messages.push({role: 'tool', tool_call_id: action.toolCallId,
              content: `Task is not complete. You must still ${explanation}. ` +
                'Continue using the page and do not claim completion.'});
            this.emit(run, 'completion_deferred',
              `Completion deferred; still required: ${explanation}.`);
            this.traceAction(run, action, observation, null, observation.url,
              'deferred');
            continue;
          }
          const summary = factualCompletionSummary(run, action.summary);
          if (!summary) {
            throw new Error('Task did not complete as requested: the agent ' +
              'provided no factual completion summary.');
          }
          this.traceAction(run, action, observation, null, observation.url);
          this.emit(run, 'assistant_message', summary, true);
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
        const actionElement = observation.elements.find(candidate =>
          candidate.id === action.element_id);
        const navigationLikely = action.action === 'navigate' ||
          (action.action === 'click' && actionElement?.navigationLikely) ||
          (action.action === 'press_enter' &&
            (actionElement?.navigationLikely || actionElement?.type === 'search'));
        try {
          await execute(observation.page, action, run, {navigationLikely});
        } catch (error) {
          this.traceAction(run, action, observation, actionElement,
            observation.page.url?.() || observation.url,
            cleanTraceText(error.message || error));
          if (!(error instanceof RecoverableActionError)) throw error;
          const message = error.message || String(error);
          console.warn(`[AgentSearch ${run.id}] recoverable_action_error: ${message}`);
          run.messages.push({role: 'tool', tool_call_id: action.toolCallId,
            content: `Action result: recoverable error. ${message}`});
          this.emit(run, 'action_retry_required', message, true,
            {action: action.action});
          continue;
        }
        if (!this.ensureRunning(run)) return;
        if (action.action === 'accept_autofill') run.paymentFieldTouched = true;
        if (action.action === 'type') {
          const element = observation.elements.find(candidate =>
            candidate.id === action.element_id);
          if (element?.type === 'search' || /\bsearch\b/i.test(run.task)) {
            run.pendingSearchSubmission = true;
          }
        } else if (action.action === 'press_enter') {
          run.pendingSearchSubmission = false;
          if (actionElement?.type === 'search' || /\bsearch\b/i.test(run.task)) {
            run.milestones.searchSubmitted = true;
          }
        } else if (action.action === 'click' &&
            /\badd(?:ed)? to (?:cart|basket)\b/i.test(actionElement?.text || '')) {
          run.milestones.addToCartExecuted = true;
        }
        const afterUrl = observation.page.url?.() || observation.url;
        run.lastObservedUrl = afterUrl;
        this.traceAction(run, action, observation, actionElement, afterUrl);
        run.messages.push({role: 'tool', tool_call_id: action.toolCallId,
          content: 'Action result: ok'});
        this.emit(run, 'action_completed', `Completed ${action.action}.`, true,
          {action: action.action});
      }
      this.fail(run, `Agent stopped after ${this.stepLimit} steps.`);
    } catch (error) {
      if (isPageOrBrowserCrashError(error)) {
        run.browserPageCrashed = true;
        let recovery = {recovered: false};
        try {
          recovery = await this.connection.recoverAfterCrash?.(
            run.targetId, run.lastObservedUrl) || recovery;
        } catch (recoveryError) {
          console.warn(`AgentSearch crash recovery failed: ${
            recoveryError.message || recoveryError}`);
        }
        if (recovery.recovered && recovery.newTargetId) {
          run.targetId = recovery.newTargetId;
          run.browserPageCrashed = false;
          resumeAfterCrash = true;
          this.emit(run, 'action_retry_required',
            'The browser page crashed, but a replacement page was found. Retrying…',
            true, {targetId: recovery.newTargetId});
        } else {
          this.fail(run, 'The browser page crashed unexpectedly and the task ' +
            'could not continue. Please try again.');
        }
      } else {
        this.fail(run, error.message || String(error));
      }
    } finally {
      if (!run.browserPageCrashed && !resumeAfterCrash) {
        await this.connection.cleanup?.(run.targetId).catch(error => {
          console.warn(`AgentSearch overlay cleanup failed: ${
            error.message || error}`);
        });
      }
      run.loopActive = false;
    }
    if (resumeAfterCrash) void this.loop(run);
  }

  confirm(runId, confirmationId, approved) {
    const run = this.runs.get(runId);
    const pending = run?.pendingConfirmation;
    if (!run || run.cancelled || run.status !== 'awaiting_confirmation' ||
        !pending || pending.consumed || pending.confirmationId !== confirmationId) {
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
    run.deadline = Date.now() + pending.remainingTaskMs;
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

module.exports = {isUngroundedProductRefusal, TaskManager, validateAction};
