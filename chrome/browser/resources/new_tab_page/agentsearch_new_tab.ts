// eslint-disable-next-line no-restricted-imports
import {addWebUiListener, sendWithPromise} from 'chrome://resources/js/cr.js';

const RESULTS_URL = 'chrome://new-tab-page/agentsearch_results.html';
const BACKGROUND_KEY = 'agentsearch.background';

interface LocationData {
  latitude?: number;
  longitude?: number;
  city?: string;
  locality?: string;
  principalSubdivision?: string;
}

interface WeatherData {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
}

interface IdentityState {
  signedIn: boolean;
  name: string;
  email: string;
  avatarUrl: string;
}

const dashboard = document.querySelector<HTMLElement>('#dashboard')!;
const clock = document.querySelector<HTMLTimeElement>('#clock')!;
const clockTime = document.querySelector<HTMLElement>('#clockTime')!;
const clockPeriod = document.querySelector<HTMLElement>('#clockPeriod')!;
const greeting = document.querySelector<HTMLElement>('#greeting')!;
const temperature = document.querySelector<HTMLElement>('#temperature')!;
const city = document.querySelector<HTMLElement>('#city')!;
const weatherIcon = document.querySelector<HTMLElement>('#weatherIcon')!;
const backgroundMenu = document.querySelector<HTMLElement>('#backgroundMenu')!;
const backgroundUpload =
    document.querySelector<HTMLInputElement>('#backgroundUpload')!;
const accountButton =
    document.querySelector<HTMLButtonElement>('#accountButton')!;
const accountSignInLabel =
    document.querySelector<HTMLElement>('#accountSignInLabel')!;
const accountAvatar =
    document.querySelector<HTMLImageElement>('#accountAvatar')!;
const accountInitial =
    document.querySelector<HTMLElement>('#accountInitial')!;
const accountMenu = document.querySelector<HTMLElement>('#accountMenu')!;
const accountEmail = document.querySelector<HTMLElement>('#accountEmail')!;
const accountSignOut =
    document.querySelector<HTMLButtonElement>('#accountSignOut')!;

function updateIdentity(state: IdentityState) {
  accountButton.classList.toggle('signedIn', state.signedIn);
  accountSignInLabel.hidden = state.signedIn;
  accountButton.disabled = false;
  if (!state.signedIn) {
    accountMenu.hidden = true;
    accountEmail.textContent = '';
    accountAvatar.hidden = true;
    accountInitial.hidden = true;
    accountAvatar.removeAttribute('src');
    accountButton.setAttribute('aria-label', 'Sign in');
    return;
  }

  accountEmail.textContent = state.email;
  const displayName = state.name || state.email;
  accountButton.setAttribute(
      'aria-label', displayName ? `Signed in as ${displayName}` : 'Signed in');
  if (state.avatarUrl) {
    accountAvatar.src = state.avatarUrl;
    accountAvatar.hidden = false;
    accountInitial.hidden = true;
  } else {
    accountAvatar.hidden = true;
    accountInitial.textContent = displayName.trim().charAt(0).toUpperCase() || '?';
    accountInitial.hidden = false;
  }
}

accountAvatar.addEventListener('error', () => {
  accountAvatar.hidden = true;
  accountInitial.hidden = false;
});
accountButton.addEventListener('click', () => {
  if (accountButton.classList.contains('signedIn')) {
    accountMenu.hidden = !accountMenu.hidden;
    return;
  }
  void sendWithPromise<boolean>('agentSearchShowSignin');
});
accountSignOut.addEventListener('click', () => {
  accountMenu.hidden = true;
  void sendWithPromise<boolean>('agentSearchSignOut');
});
document.addEventListener('click', event => {
  if (!accountMenu.hidden && event.target instanceof Node &&
      !accountMenu.contains(event.target) &&
      !accountButton.contains(event.target)) {
    accountMenu.hidden = true;
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    accountMenu.hidden = true;
  }
});
addWebUiListener('agent-search-identity-changed', updateIdentity);
void sendWithPromise<IdentityState>('agentSearchIdentity').then(updateIdentity);

function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  clock.dateTime = now.toISOString();
  const timeParts = new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(now);
  clockTime.textContent =
      timeParts.filter(part => part.type !== 'dayPeriod')
          .map(part => part.value)
          .join('')
          .trim();
  clockPeriod.textContent =
      timeParts.find(part => part.type === 'dayPeriod')?.value || '';
  greeting.textContent =
      hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' :
                                               'Good evening';
}

async function getLocation(): Promise<LocationData> {
  const body = await sendWithPromise<string>('agentSearchLocation');
  return JSON.parse(body) as LocationData;
}

function iconForWeatherCode(code: number): string {
  if (code === 0) {
    return '●';
  }
  if (code <= 3) {
    return '◒';
  }
  if (code === 45 || code === 48) {
    return '≋';
  }
  if (code >= 51 && code <= 67) {
    return '╱';
  }
  if (code >= 71 && code <= 77) {
    return '✦';
  }
  if (code >= 95) {
    return 'ϟ';
  }
  return '●';
}

async function updateWeather() {
  try {
    const location = await getLocation();
    if (location.latitude === undefined || location.longitude === undefined) {
      throw new Error('Location did not include coordinates');
    }
    const body = await sendWithPromise<string>(
        'agentSearchWeather', String(location.latitude),
        String(location.longitude));
    const weather = JSON.parse(body) as WeatherData;
    const degrees = weather.current?.temperature_2m;
    const code = weather.current?.weather_code ?? 0;
    temperature.textContent =
        degrees === undefined ? '--°' : `${Math.round(degrees)}°F`;
    city.textContent = location.city || location.locality ||
        location.principalSubdivision || 'Local weather';
    weatherIcon.textContent = iconForWeatherCode(code);
  } catch {
    temperature.textContent = '--°';
    city.textContent = 'Weather unavailable';
    weatherIcon.textContent = '○';
  }
}

function applyBackground(value: string|null) {
  if (!value) {
    dashboard.style.backgroundImage = 'var(--dusk)';
    return;
  }
  if (value.startsWith('data:image/')) {
    dashboard.style.backgroundImage = `url("${value}")`;
    return;
  }
  dashboard.style.backgroundImage = `var(--${value})`;
}

function saveBackground(value: string) {
  localStorage.setItem(BACKGROUND_KEY, value);
  applyBackground(value);
}

function faviconUrl(pageUrl: string): string {
  const url = new URL('chrome://favicon2/');
  url.searchParams.set('size', '32');
  url.searchParams.set('scaleFactor', '2x');
  url.searchParams.set('allowGoogleServerFallback', '1');
  url.searchParams.set('fallbackToHost', '1');
  url.searchParams.set('showFallbackMonogram', '');
  url.searchParams.set('pageUrl', pageUrl);
  return url.href;
}

document.querySelectorAll<HTMLAnchorElement>('#shortcuts a.shortcut')
    .forEach(shortcut => {
      const icon = shortcut.querySelector<HTMLElement>('.shortcutIcon');
      if (!icon) {
        return;
      }
      const image = new Image();
      image.className = 'shortcutFavicon';
      image.alt = '';
      image.addEventListener('load', () => icon.classList.add('hasFavicon'));
      image.addEventListener('error', () => image.remove());
      image.src = faviconUrl(shortcut.href);
      icon.appendChild(image);
    });

const searchForm = document.querySelector<HTMLFormElement>('#searchForm')!;
searchForm.addEventListener('submit', event => {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>('#searchInput')!;
  const query = input.value.trim();
  if (!query) {
    return;
  }
  const destination =
      `${RESULTS_URL}?${new URLSearchParams({q: query, category: 'general'})}`;
  console.info(`AgentSearch dashboard destination: ${destination}`);
  location.assign(destination);
});

document.querySelector('#backgroundButton')!.addEventListener('click', () => {
  backgroundMenu.hidden = !backgroundMenu.hidden;
});

document.querySelectorAll<HTMLButtonElement>('[data-gradient]').forEach(
    button => {
      button.addEventListener('click', () => {
        saveBackground(button.dataset['gradient']!);
        backgroundMenu.hidden = true;
      });
    });

document.querySelector('#uploadButton')!.addEventListener(
    'click', () => backgroundUpload.click());

backgroundUpload.addEventListener('change', () => {
  const file = backgroundUpload.files?.[0];
  if (!file || !file.type.startsWith('image/')) {
    return;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    if (typeof reader.result === 'string') {
      try {
        saveBackground(reader.result);
        backgroundMenu.hidden = true;
      } catch {
        city.textContent = 'Background image is too large to save';
      }
    }
  });
  reader.readAsDataURL(file);
});

document.querySelector('#resetBackground')!.addEventListener('click', () => {
  localStorage.removeItem(BACKGROUND_KEY);
  applyBackground(null);
  backgroundMenu.hidden = true;
});

document.querySelector('#addShortcut')!.addEventListener('click', () => {
  document.querySelector<HTMLInputElement>('#searchInput')!.focus();
});

document.addEventListener('click', event => {
  const target = event.target as Node;
  if (!backgroundMenu.contains(target) &&
      !document.querySelector('#backgroundButton')!.contains(target)) {
    backgroundMenu.hidden = true;
  }
});

applyBackground(localStorage.getItem(BACKGROUND_KEY));
updateClock();
setInterval(updateClock, 1000);
void updateWeather();
