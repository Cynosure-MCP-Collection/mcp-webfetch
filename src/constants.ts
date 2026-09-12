// ── Limits & Timing ────────────────────────────────────────────────────────────

export const MAX_CONTENT_LENGTH = 100_000;
export const NAVIGATION_TIMEOUT = 30_000;
export const FILTER_FETCH_TIMEOUT = 15_000;
export const FILTER_REFRESH_MS = 24 * 60 * 60 * 1000;
export const CSS_CHUNK_SIZE = 400;
export const SERVER_VERSION = '1.0.4';

// ── Filter Lists ───────────────────────────────────────────────────────────────

export const FILTER_LISTS = [
    'https://easylist.to/easylist/easylist.txt',
    'https://easylist.to/easylist/easyprivacy.txt',
    'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
];

// ── Built-in Cosmetic Selectors ────────────────────────────────────────────────

export const BUILTIN_COSMETIC_SELECTORS = [
    '[id*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]',
    '[id*="gdpr" i]',
    '[class*="gdpr" i]',
    '[id*="onetrust" i]',
    '[class*="onetrust" i]',
    '[id*="didomi" i]',
    '[class*="didomi" i]',
    '[id*="trustarc" i]',
    '[class*="trustarc" i]',
    '[id*="quantcast" i]',
    '[class*="quantcast" i]',
    '[aria-label*="cookie" i]',
    '[aria-label*="consent" i]',
    'div[role="dialog"][aria-modal="true"]',
    'iframe[src*="doubleclick" i]',
    'iframe[src*="googlesyndication" i]',
    'iframe[src*="adservice" i]',
    '[class*="sponsored" i]',
    '[id*="sponsored" i]',
    '[class*="advert" i]',
    '[id*="advert" i]',
];

// ── User Agents & Viewports ────────────────────────────────────────────────────

export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
export const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
export const MOBILE_VIEWPORT = { width: 412, height: 915 };
