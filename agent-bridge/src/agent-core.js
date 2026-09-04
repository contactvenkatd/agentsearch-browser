'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const OpenAI = require('openai');

const GROUNDING_SYSTEM_MESSAGE =
  'You control a live browser. The current browser observation is the ' +
  'authoritative source of truth. Your own knowledge of product release ' +
  'dates, product existence, and current availability is unreliable and may ' +
  'be stale. NEVER refuse or stop a task because you believe a requested ' +
  'product does not exist, has not been released, or should not yet be ' +
  'available. Search and inspect the live page instead. Genuine visible ' +
  'product listings override your prior beliefs. Carefully distinguish the ' +
  'requested product from accessories, cases, sponsored results, and similarly ' +
  'named products. You may accurately report that only accessories or no ' +
  'direct product listings were found, but must not invent release-date or ' +
  'nonexistence claims from memory.';

function sanitizeLoggedContent(content) {
  return String(content || '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:\d[ -]?){12,19}/g, '[redacted-number]')
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 20000);
}

function persistApiMessagePayload(runId, messages, filename =
    process.env.AGENTSEARCH_API_PAYLOAD_LOG ||
      path.join(os.tmpdir(), 'agentsearch-api-payloads.jsonl')) {
  const serialized = JSON.stringify(messages);
  const entry = {timestamp: new Date().toISOString(), runId,
    sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    messages: messages.map(message => ({...message,
      content: sanitizeLoggedContent(message.content)}))};
  fs.appendFileSync(filename, `${JSON.stringify(entry)}\n`,
    {encoding: 'utf8', mode: 0o600});
  return entry;
}

function buildApiMessages(run, prompt) {
  if (run.messages[0]?.role !== 'system') {
    run.messages.unshift({role: 'system', content: GROUNDING_SYSTEM_MESSAGE});
  }
  return [...run.messages, {role: 'user', content: prompt}];
}

const TOOL = [{type: 'function', function: {
  name: 'browser_action',
  description: 'Perform exactly one browser action and observe the result.',
  parameters: {type: 'object', properties: {
    action: {type: 'string', enum: ['click', 'type', 'press_enter', 'navigate', 'scroll',
      'accept_autofill', 'request_purchase_confirmation', 'respond', 'wait', 'done']},
    element_id: {type: 'integer'},
    text: {type: 'string', description: 'Text to type, or the answer for respond.'},
    url: {type: 'string'},
    summary: {type: 'string', description: 'For purchase confirmation: item, price, quantity, and total. For done: a factual summary of what was accomplished.'},
    reasoning: {type: 'string'}
  }, required: ['action', 'reasoning']}
}}];

function apiKey() {
  if (process.env.XAI_API_KEY?.trim()) return process.env.XAI_API_KEY.trim();
  const filename = process.env.AGENTSEARCH_XAI_KEY_FILE ||
    path.join(os.homedir(), 'agentsearch-xai-key.txt');
  try {
    const key = fs.readFileSync(filename, 'utf8').trim();
    if (key) {
      console.warn(`XAI_API_KEY is not set; using fallback key file: ${filename}`);
      return key;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to read xAI fallback key file ${filename}: ${error.message}`);
    }
  }
  throw new Error(
    'xAI API key not found; set XAI_API_KEY or provide ~/agentsearch-xai-key.txt');
}

function formatElements(elements) {
  if (!elements.length) return '(no interactive elements detected)';
  return elements.map(e => `[${e.id}] ${e.tag}${e.type ? `[type=${e.type}]` : ''}` +
    `${e.role ? ` role=${e.role}` : ''}` +
    `${e.organicResultRank ? ` organic-result=${e.organicResultRank}` : ''}` +
    ` "${e.text}"`).join('\n');
}

function isSubstantiveAnswer(text) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length >= 240 && normalized.split(' ').length >= 40;
}

function summaryInstructions(observation) {
  const searchPage = observation.searchPage;
  if (!searchPage) {
    return 'Summaries must explain what the topic or content is about and ' +
      'answer the user\'s underlying intent. Never describe the webpage\'s ' +
      'layout, DOM structure, sections, links, or visual organization.';
  }
  const substantive = isSubstantiveAnswer(observation.directAnswerText);
  return `This is a ${searchPage.engine} results page for "${searchPage.query}". ` +
    'The user wants to know ABOUT that topic, not what the search-results ' +
    'page looks like. ' + (substantive ?
      'The directly visible answer panel below is substantive. Summarize its ' +
      'facts now without navigating elsewhere.' :
      'No sufficiently substantive direct-answer panel was found. Do not ' +
      'summarize the result list or respond yet. Click the top relevant organic ' +
      'result (prefer organic-result=1), read that page, then summarize its ' +
      'actual content and briefly note that a follow-up source was opened.');
}

function safePageUrl(rawUrl) {
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

function buildPrompt(run, observation) {
  return `Task: ${run.task}\n\nCurrent URL: ${safePageUrl(observation.url)}\n` +
    `Page title: ${observation.title}\n\nReadable page content:\n` +
    `${observation.pageText || '(no readable page content detected)'}\n\n` +
    `Direct answer panel content:\n${observation.directAnswerText ||
      '(no substantive answer panel extracted)'}\n\n` +
    `Interactive elements on screen:\n${formatElements(observation.elements)}\n\n` +
    `${summaryInstructions(observation)}\n\nDecide the single next action. ` +
    'For questions, summaries, and other ' +
    'requests that need a textual answer, call respond with the complete ' +
    'answer in text. Typing only changes a field and never submits it. For a ' +
    'search task, use press_enter on the search field after type, then ' +
    'observe the resulting page before calling done. Every done action must ' +
    'include a non-empty factual summary supported by the observed page and ' +
    'completed actions. Never call done merely because a search ran. Call ' +
    'request_purchase_confirmation before a final purchase action.';
}

async function decide(run, observation) {
  if (process.env.AGENT_BRIDGE_MOCK === '1') {
    if (/\[mock:navigation-failure\]/i.test(run.task))
      return {action: 'navigate', url: 'https://navigation-failure.example/',
        reasoning: 'Testing navigation failure', toolCallId: 'mock-navigation'};
    if (/\[mock:slow\]/i.test(run.task) && !run.mockSlowStep)
      return {action: 'wait', reasoning: 'Testing a cancellable slow action',
        toolCallId: 'mock-slow'};
    if (/\[mock:max-steps\]/i.test(run.task))
      return {action: 'scroll', reasoning: 'Testing the maximum step limit',
        toolCallId: `mock-step-${run.sequence}`};
    if (/\[mock:timeout\]/i.test(run.task))
      return {action: 'wait', reasoning: 'Testing task timeout',
        toolCallId: 'mock-timeout'};
    if (/\[mock:empty-response\]/i.test(run.task))
      return {action: 'respond', text: '   ', reasoning: 'Testing empty answer',
        toolCallId: 'mock-empty-response'};
    if (/\[mock:premature-shopping-done\]/i.test(run.task))
      return {action: 'done', reasoning: 'Incorrectly stopping after search',
        summary: 'Done shopping.', toolCallId: `mock-premature-${run.sequence}`};
    if (/\[mock:missing-done-summary\]/i.test(run.task))
      return {action: 'done', reasoning: 'Testing missing completion summary',
        toolCallId: 'mock-missing-done-summary'};
    if (/\[mock:ungrounded-refusal\]/i.test(run.task))
      return {action: 'respond', reasoning: 'Relying on stale product knowledge',
        text: 'The requested product does not exist and has not been released yet.',
        toolCallId: `mock-ungrounded-${run.sequence}`};
    if (/\[mock:accessories-only\]/i.test(run.task))
      return {action: 'respond', reasoning: 'Reporting observed search results',
        text: 'Only accessories were found in the visible search results; no direct product listing was found.',
        toolCallId: 'mock-accessories-only'};
    if (/\bsummar(?:ize|ise|y)\b/i.test(run.task) && observation.searchPage &&
        !isSubstantiveAnswer(observation.directAnswerText)) {
      const result = observation.elements.find(element =>
        element.organicResultRank === 1) || observation.elements.find(element =>
        element.tag === 'a');
      if (result) return {action: 'click', element_id: result.id,
        reasoning: 'Opening the top result for substantive source content',
        toolCallId: 'mock-followup-result'};
    }
    if (/\bsummar(?:ize|ise|y)\b/i.test(run.task))
      return {action: 'respond', text: observation.searchPage ?
        `Mock summary of ${observation.searchPage.query}: ${
          observation.directAnswerText}` : 'Mock readable page summary.',
        reasoning: 'Summarizing the readable page content',
        toolCallId: 'mock-response'};
    const mockSearch = run.task.match(/\bsearch(?: the web)? for ([^.[\]]+)/i);
    if (mockSearch) {
      const query = mockSearch[1].trim();
      const actions = [
        {action: 'navigate', url: 'https://www.google.com/',
          reasoning: 'Opening Google'},
        {action: 'type', element_id: 0, text: query,
          reasoning: 'Entering the requested search'},
        {action: 'press_enter', element_id: 0,
          reasoning: 'Submitting the requested search'},
        {action: 'wait', reasoning: 'Waiting for visible results'},
        {action: 'done', reasoning: 'Mock search task completed',
          summary: 'Submitted the requested search and observed the results.'}
      ];
      const index = run.mockActionIndex || 0;
      run.mockActionIndex = index + 1;
      return {...actions[Math.min(index, actions.length - 1)],
        toolCallId: `mock-action-${index}`};
    }
    if (/\[mock:confirmation\]|\b(?:buy|checkout)\b/i.test(run.task) &&
        !run.mockConfirmationRequested)
      return {action: 'request_purchase_confirmation', reasoning: 'Mock purchase gate',
        summary: 'Mock item; quantity 1; total $1.00', toolCallId: 'mock-purchase'};
    return {action: 'done', reasoning: 'Mock task completed',
      summary: 'Completed the requested mock task.', toolCallId: 'mock-done'};
  }
  const key = apiKey();
  const prompt = buildPrompt(run, observation);
  const messages = buildApiMessages(run, prompt);
  try {
    persistApiMessagePayload(run.id, messages);
  } catch (error) {
    console.warn(`AgentSearch API payload log failed: ${error.message || error}`);
  }
  const client = new OpenAI({apiKey: key, baseURL: 'https://api.x.ai/v1'});
  const response = await client.chat.completions.create({model: 'grok-4.3',
    max_tokens: 1024, tools: TOOL,
    tool_choice: {type: 'function', function: {name: 'browser_action'}}, messages});
  const call = response.choices[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('Grok returned no browser_action tool call');
  run.messages = messages.concat(response.choices[0].message);
  return {...JSON.parse(call.function.arguments), toolCallId: call.id};
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '');
}

class RecoverableActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoverableActionError';
  }
}

async function uniqueActionLocator(page, action) {
  const selector = `[data-agent-id="${action.element_id}"]`;
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count !== 1) {
    throw new RecoverableActionError(
      `Element ${action.element_id} resolved to ${count} elements. ` +
      'The page labels may be stale; re-scan the page and retry the action.');
  }
  return locator;
}

async function waitForNetworkIdle(page) {
  try {
    await page.waitForLoadState('networkidle', {timeout: 5000});
  } catch (error) {
    // Some pages continuously poll. DOMContentLoaded is sufficient in that case.
    if (!isTimeoutError(error)) throw error;
  }
}

async function execute(page, action, run, {navigationLikely = false} = {}) {
  if (process.env.AGENT_BRIDGE_MOCK === '1') {
    if (action.action === 'navigate' &&
        /\[mock:navigation-failure\]/i.test(run.task)) {
      throw new Error('Mock navigation failed.');
    }
    if (action.action === 'wait') {
      const delay = /\[mock:timeout\]/i.test(run.task) ? 100 : 30;
      await page.waitForTimeout(delay);
      run.mockSlowStep = true;
    }
    run.mockExecutedActions ||= [];
    run.mockExecutedActions.push(action.action);
    return;
  }
  if (action.action === 'navigate') {
    await page.goto(action.url, {waitUntil: 'domcontentloaded'});
    await waitForNetworkIdle(page);
    return;
  }
  const targetsElement = ['click', 'type', 'press_enter',
    'accept_autofill'].includes(action.action);
  const locator = targetsElement ? await uniqueActionLocator(page, action) : null;
  if (navigationLikely && ['click', 'press_enter'].includes(action.action)) {
    const navigation = page.waitForNavigation({
      waitUntil: 'domcontentloaded', timeout: 5000,
    }).then(() => true).catch(error => {
      if (isTimeoutError(error)) return false;
      throw error;
    });
    if (action.action === 'click') await locator.click();
    else await locator.press('Enter');
    if (await navigation) await waitForNetworkIdle(page);
    return;
  }
  switch (action.action) {
    case 'click': await locator.click(); break;
    case 'type': await locator.fill(action.text || ''); break;
    case 'press_enter': await locator.press('Enter'); break;
    case 'accept_autofill':
      await locator.click();
      await page.waitForTimeout(400); await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter'); break;
    case 'scroll': await page.evaluate(() => scrollBy(0, 800)); break;
    case 'wait': await page.waitForTimeout(1500); break;
  }
}

module.exports = {buildApiMessages, buildPrompt, decide, execute,
  GROUNDING_SYSTEM_MESSAGE, isSubstantiveAnswer, persistApiMessagePayload,
  RecoverableActionError, summaryInstructions};
