import {
    BUILTIN_COSMETIC_SELECTORS,
    DESKTOP_UA,
    FILTER_FETCH_TIMEOUT,
    FILTER_LISTS,
    FILTER_REFRESH_MS,
} from './constants.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FilterBundle {
    blockedDomains: Set<string>;
    genericCosmeticSelectors: string[];
    domainCosmeticSelectors: Map<string, string[]>;
}

// ── State ──────────────────────────────────────────────────────────────────────

let filterBundlePromise: Promise<FilterBundle> | null = null;
let filterBundleExpiresAt = 0;

// ── Domain Helpers ─────────────────────────────────────────────────────────────

function isLikelyDomain(value: string): boolean {
    return /^(?:[a-z0-9-]+\.)+[a-z0-9-]{2,}$/i.test(value);
}

function normalizeDomain(value: string): string | null {
    const cleaned = value
        .trim()
        .toLowerCase()
        .replace(/^\.+/, '')
        .replace(/^\*\./, '')
        .replace(/\.+$/, '');
    if (!cleaned || !isLikelyDomain(cleaned)) {
        return null;
    }
    return cleaned;
}

function extractDomainFromNetworkRule(line: string): string | null {
    const hostsMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([^\s#]+)/);
    if (hostsMatch) {
        return normalizeDomain(hostsMatch[1]);
    }

    const rule = line.split('$', 1)[0]?.trim() ?? '';
    if (!rule || rule.startsWith('@@') || rule.startsWith('/') || rule.includes('#')) {
        return null;
    }

    if (rule.startsWith('||')) {
        const host = rule.slice(2).split(/[\^\/*|]/, 1)[0] ?? '';
        return normalizeDomain(host);
    }

    if (rule.startsWith('|http://') || rule.startsWith('|https://')) {
        try {
            return normalizeDomain(new URL(rule.slice(1)).hostname);
        } catch {
            return null;
        }
    }

    const genericMatch = rule.match(/^([a-z0-9.-]+\.[a-z0-9-]{2,})(?:\^|\/|\*|$)/i);
    if (genericMatch) {
        return normalizeDomain(genericMatch[1]);
    }

    return null;
}

// ── Cosmetic Rule Helpers ──────────────────────────────────────────────────────

function normalizeCosmeticSelector(rawSelector: string): string | null {
    const selector = rawSelector.trim();
    if (!selector) {
        return null;
    }

    if (
        selector.startsWith('+js(') ||
        selector.includes(':style(') ||
        selector.includes(':has-text(') ||
        selector.includes(':contains(') ||
        selector.includes(':matches-css(') ||
        selector.includes(':upward(') ||
        selector.includes(':xpath(')
    ) {
        return null;
    }

    return selector;
}

function normalizeCosmeticDomainToken(rawToken: string): string | null {
    const token = rawToken.trim().toLowerCase();
    if (!token || token.startsWith('~')) {
        return null;
    }

    const cleaned = token.replace(/^\|\|/, '').replace(/^\./, '').replace(/\.$/, '');
    if (!cleaned || cleaned.includes('*') || cleaned.includes('/') || cleaned.includes('^')) {
        return null;
    }

    return normalizeDomain(cleaned);
}

function addDomainScopedSelector(
    domainMap: Map<string, Set<string>>,
    domain: string,
    selector: string,
): void {
    const existing = domainMap.get(domain);
    if (existing) {
        existing.add(selector);
        return;
    }
    domainMap.set(domain, new Set<string>([selector]));
}

// ── Filter Parsing ─────────────────────────────────────────────────────────────

export function parseFilterText(
    text: string,
    blockedDomains: Set<string>,
    genericSelectors: Set<string>,
    domainSelectors: Map<string, Set<string>>,
): void {
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('!') || line.startsWith('[')) {
            continue;
        }

        if (line.includes('##')) {
            const [domainSpec = '', cosmeticRule = ''] = line.split('##', 2);
            const normalized = normalizeCosmeticSelector(cosmeticRule);
            if (normalized) {
                if (!domainSpec) {
                    genericSelectors.add(normalized);
                } else {
                    const domains = domainSpec.split(',').map((token) => normalizeCosmeticDomainToken(token));
                    for (const domain of domains) {
                        if (domain) {
                            addDomainScopedSelector(domainSelectors, domain, normalized);
                        }
                    }
                }
            }
            continue;
        }

        if (line.includes('#@#')) {
            continue;
        }

        const domain = extractDomainFromNetworkRule(line);
        if (domain) {
            blockedDomains.add(domain);
        }
    }
}

// ── Fetch & Load ───────────────────────────────────────────────────────────────

async function fetchFilterList(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FILTER_FETCH_TIMEOUT);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'user-agent': DESKTOP_UA,
                accept: 'text/plain,*/*;q=0.9',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed with status ${response.status}`);
        }
        return await response.text();
    } finally {
        clearTimeout(timeout);
    }
}

async function loadFilterBundle(): Promise<FilterBundle> {
    const blockedDomains = new Set<string>();
    const genericSelectors = new Set<string>(BUILTIN_COSMETIC_SELECTORS);
    const domainSelectors = new Map<string, Set<string>>();

    const results = await Promise.allSettled(FILTER_LISTS.map((url) => fetchFilterList(url)));
    for (const result of results) {
        if (result.status === 'fulfilled') {
            parseFilterText(result.value, blockedDomains, genericSelectors, domainSelectors);
        }
    }

    const domainCosmeticSelectors = new Map<string, string[]>();
    for (const [domain, selectors] of domainSelectors) {
        domainCosmeticSelectors.set(domain, Array.from(selectors));
    }

    return {
        blockedDomains,
        genericCosmeticSelectors: Array.from(genericSelectors),
        domainCosmeticSelectors,
    };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function getFilterBundle(): Promise<FilterBundle> {
    const now = Date.now();
    if (!filterBundlePromise || now >= filterBundleExpiresAt) {
        filterBundleExpiresAt = now + FILTER_REFRESH_MS;
        filterBundlePromise = loadFilterBundle().catch((err) => {
            console.error('Failed to load filter lists, using built-in selectors only:', err);
            filterBundleExpiresAt = 0;
            return {
                blockedDomains: new Set<string>(),
                genericCosmeticSelectors: Array.from(new Set(BUILTIN_COSMETIC_SELECTORS)),
                domainCosmeticSelectors: new Map<string, string[]>(),
            };
        });
    }
    return filterBundlePromise;
}

export function getCosmeticSelectorsForUrl(filters: FilterBundle, url: string): string[] {
    const selectors = new Set<string>(filters.genericCosmeticSelectors);
    const host = getHostname(url);
    if (!host) {
        return Array.from(selectors);
    }

    for (const suffix of hostnameSuffixes(host)) {
        const scopedSelectors = filters.domainCosmeticSelectors.get(suffix);
        if (!scopedSelectors) {
            continue;
        }
        for (const selector of scopedSelectors) {
            selectors.add(selector);
        }
    }

    return Array.from(selectors);
}

export function hostnameSuffixes(hostname: string): string[] {
    const labels = hostname.split('.').filter(Boolean);
    const suffixes: string[] = [];
    for (let i = 0; i < labels.length - 1; i += 1) {
        suffixes.push(labels.slice(i).join('.'));
    }
    return suffixes;
}

export function getHostname(input: string): string | null {
    try {
        const parsed = new URL(input);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.hostname.toLowerCase();
    } catch {
        return null;
    }
}

export function shouldBlockRequest(requestUrl: string, frameUrl: string | null, blockedDomains: Set<string>): boolean {
    const requestHost = getHostname(requestUrl);
    if (!requestHost) {
        return false;
    }

    const frameHost = frameUrl ? getHostname(frameUrl) : null;
    if (frameHost && (requestHost === frameHost || requestHost.endsWith(`.${frameHost}`))) {
        return false;
    }

    for (const suffix of hostnameSuffixes(requestHost)) {
        if (blockedDomains.has(suffix)) {
            return true;
        }
    }

    return false;
}
