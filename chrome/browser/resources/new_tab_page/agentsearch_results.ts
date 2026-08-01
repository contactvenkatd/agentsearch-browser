// eslint-disable-next-line no-restricted-imports
import {sendWithPromise} from 'chrome://resources/js/cr.js';

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

interface SearxResponse {
  query?: string;
  number_of_results?: number;
  results?: SearxResult[];
}

const params = new URLSearchParams(location.search);
const query = params.get('q')?.trim() || '';
const category = params.get('category') || 'general';
const queryInput = document.querySelector<HTMLInputElement>('#query')!;
const results = document.querySelector<HTMLElement>('#results')!;
const resultMeta = document.querySelector<HTMLElement>('#resultMeta')!;
const RESULTS_URL = 'chrome://new-tab-page/agentsearch_results.html';

queryInput.value = query;

function categoryUrl(nextCategory: string): string {
  const next = new URLSearchParams({q: query});
  if (nextCategory !== 'general') {
    next.set('category', nextCategory);
  }
  return `${RESULTS_URL}?${next}`;
}

document.querySelectorAll<HTMLAnchorElement>('[data-category]').forEach(link => {
  const linkCategory = link.dataset['category']!;
  link.href = categoryUrl(linkCategory);
  link.classList.toggle('active', linkCategory === category);
});

document.querySelector<HTMLFormElement>('#resultsSearch')!.addEventListener(
    'submit', event => {
      event.preventDefault();
      const nextQuery = queryInput.value.trim();
      if (nextQuery) {
        const destination = `${RESULTS_URL}?${
            new URLSearchParams({q: nextQuery, category})}`;
        console.info(`AgentSearch results destination: ${destination}`);
        location.assign(destination);
      }
    });

function badgeColor(domain: string): string {
  const colors = ['#3978c5', '#8b5fc2', '#c05c6d', '#bf7b35', '#357f74'];
  let hash = 0;
  for (const character of domain) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return colors[hash % colors.length]!;
}

function appendResult(item: SearxResult) {
  if (!item.url) {
    return;
  }
  const url = new URL(item.url);
  const domain = url.hostname.replace(/^www\./, '');
  const article = document.createElement('article');
  article.className = 'result';

  const source = document.createElement('div');
  source.className = 'resultSource';
  const badge = document.createElement('span');
  badge.className = 'domainBadge';
  badge.style.color = badgeColor(domain);
  badge.textContent = domain.charAt(0);
  const sourceText = document.createElement('span');
  sourceText.className = 'sourceText';
  const domainName = document.createElement('span');
  domainName.className = 'domainName';
  domainName.textContent = domain;
  const breadcrumb = document.createElement('span');
  breadcrumb.className = 'breadcrumb';
  breadcrumb.textContent = item.url;
  sourceText.append(domainName, breadcrumb);
  source.append(badge, sourceText);

  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.href = item.url;
  link.textContent = item.title || item.url;
  heading.appendChild(link);

  const snippet = document.createElement('p');
  snippet.textContent = item.content || `Result from ${domain}`;
  article.append(source, heading, snippet);
  results.appendChild(article);
}

async function loadResults() {
  if (!query) {
    resultMeta.textContent = 'Enter a search above to get started.';
    return;
  }
  const start = performance.now();
  try {
    const body = await sendWithPromise<string>('agentSearch', query, category);
    const data = JSON.parse(body) as SearxResponse;
    const items = data.results || [];
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const count = data.number_of_results || items.length;
    resultMeta.textContent =
        `About ${count.toLocaleString()} results (${elapsed} seconds)`;
    items.forEach(appendResult);
    if (!items.length) {
      results.innerHTML =
          '<div class="statusCard">No results matched this search.</div>';
    }
  } catch (error) {
    resultMeta.textContent = 'AgentSearch backend unavailable';
    const message = error instanceof Error ? error.message : 'Unknown error';
    const card = document.createElement('div');
    card.className = 'statusCard';
    card.textContent = `${message}. Please try the search again.`;
    results.appendChild(card);
  }
}

void loadResults();
