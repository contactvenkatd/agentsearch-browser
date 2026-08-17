'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OpenAI = require('openai');

const TOOL = [{type: 'function', function: {
  name: 'browser_action',
  description: 'Perform exactly one browser action and observe the result.',
  parameters: {type: 'object', properties: {
    action: {type: 'string', enum: ['click', 'type', 'press_enter', 'navigate', 'scroll',
      'accept_autofill', 'request_purchase_confirmation', 'respond', 'wait', 'done']},
    element_id: {type: 'integer'},
    text: {type: 'string', description: 'Text to type, or the answer for respond.'},
    url: {type: 'string'},
    summary: {type: 'string', description: 'Item, price, quantity, and total.'},
    reasoning: {type: 'string'}
  }, required: ['action', 'reasoning']}
}}];

function apiKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY.trim();
  const filename = process.env.AGENTSEARCH_XAI_KEY_FILE ||
    path.join(os.homedir(), 'agentsearch-xai-key.txt');
  try { return fs.readFileSync(filename, 'utf8').trim(); } catch { return ''; }
}

function formatElements(elements) {
  if (!elements.length) return '(no interactive elements detected)';
  return elements.map(e => `[${e.id}] ${e.tag}${e.type ? `[type=${e.type}]` : ''}` +
    `${e.role ? ` role=${e.role}` : ''} "${e.text}"`).join('\n');
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
    `Interactive elements on screen:\n${formatElements(observation.elements)}\n\n` +
    'Decide the single next action. For questions, summaries, and other ' +
    'requests that need a textual answer, call respond with the complete ' +
    'answer in text. Typing only changes a field and never submits it. For a ' +
    'search task, use press_enter on the search field after type, then ' +
    'observe the resulting page before calling done. Call ' +
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
    if (/\bsummar(?:ize|ise|y)\b/i.test(run.task))
      return {action: 'respond', text: 'Mock readable page summary.',
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
        {action: 'done', reasoning: 'Mock search task completed'}
      ];
      const index = run.mockActionIndex || 0;
      run.mockActionIndex = index + 1;
      return {...actions[Math.min(index, actions.length - 1)],
        toolCallId: `mock-action-${index}`};
    }
    if (/\[mock:(?:confirmation|expired-confirmation)\]|\b(?:buy|checkout)\b/i.test(run.task) &&
        !run.mockConfirmationRequested)
      return {action: 'request_purchase_confirmation', reasoning: 'Mock purchase gate',
        summary: 'Mock item; quantity 1; total $1.00', toolCallId: 'mock-purchase'};
    return {action: 'done', reasoning: 'Mock task completed', toolCallId: 'mock-done'};
  }
  const key = apiKey();
  if (!key) throw new Error('xAI API key not found in XAI_API_KEY or ~/agentsearch-xai-key.txt');
  const prompt = buildPrompt(run, observation);
  const messages = [...run.messages, {role: 'user', content: prompt}];
  const client = new OpenAI({apiKey: key, baseURL: 'https://api.x.ai/v1'});
  const response = await client.chat.completions.create({model: 'grok-4.3',
    max_tokens: 1024, tools: TOOL,
    tool_choice: {type: 'function', function: {name: 'browser_action'}}, messages});
  const call = response.choices[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('Grok returned no browser_action tool call');
  run.messages = messages.concat(response.choices[0].message);
  return {...JSON.parse(call.function.arguments), toolCallId: call.id};
}

async function execute(page, action, run) {
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
  switch (action.action) {
    case 'navigate': await page.goto(action.url); break;
    case 'click': await page.locator(`[data-agent-id="${action.element_id}"]`).click(); break;
    case 'type': await page.locator(`[data-agent-id="${action.element_id}"]`).fill(action.text || ''); break;
    case 'press_enter':
      await page.locator(`[data-agent-id="${action.element_id}"]`).press('Enter');
      break;
    case 'accept_autofill':
      await page.locator(`[data-agent-id="${action.element_id}"]`).click();
      await page.waitForTimeout(400); await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter'); break;
    case 'scroll': await page.evaluate(() => scrollBy(0, 800)); break;
    case 'wait': await page.waitForTimeout(1500); break;
  }
}

module.exports = {buildPrompt, decide, execute};
