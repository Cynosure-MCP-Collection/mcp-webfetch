import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import {
    CSS_CHUNK_SIZE,
    DESKTOP_UA,
    DESKTOP_VIEWPORT,
    MOBILE_UA,
    MOBILE_VIEWPORT,
    NAVIGATION_TIMEOUT,
} from './constants.js';
import {
    type FilterBundle,
    getCosmeticSelectorsForUrl,
    getFilterBundle,
    shouldBlockRequest,
} from './filters.js';

// ── State ──────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let desktopContext: BrowserContext | null = null;
let mobileContext: BrowserContext | null = null;
let desktopContextPromise: Promise<BrowserContext> | null = null;
let mobileContextPromise: Promise<BrowserContext> | null = null;

// ── Route Helpers ──────────────────────────────────────────────────────────────

function getRequestFrameInfo(request: ReturnType<Route['request']>): {
    frameUrl: string | null;
    hasParentFrame: boolean;
} {
    try {
        const frame = request.frame();
        return {
            frameUrl: frame.url(),
            hasParentFrame: frame.parentFrame() !== null,
        };
    } catch {
        return {
            frameUrl: null,
            hasParentFrame: false,
        };
    }
}

// ── Page Cleanup ───────────────────────────────────────────────────────────────

export async function applyPageCleanup(page: Page, filters: FilterBundle, url: string): Promise<void> {
    const selectors = getCosmeticSelectorsForUrl(filters, url);
    if (selectors.length === 0) {
        return;
    }

    for (let i = 0; i < selectors.length; i += CSS_CHUNK_SIZE) {
        const chunk = selectors.slice(i, i + CSS_CHUNK_SIZE);
        await page.evaluate((nodes) => {
            for (const selector of nodes) {
                try {
                    for (const node of document.querySelectorAll(selector)) {
                        node.remove();
                    }
                } catch {
                    // Invalid selector for current browser engine.
                }
            }
        }, chunk).catch(() => { });
    }

    await page.evaluate(() => {
        const noisePattern = /cookie|consent|gdpr|onetrust|didomi|trustarc|quantcast|cmp|newsletter|subscribe|advert|sponsored|popup|overlay|modal|social|share/i;

        const candidates = Array.from(document.querySelectorAll('[id], [class], [aria-label], [role], [data-testid]'));
        for (const el of candidates) {
            const htmlEl = el as HTMLElement;
            const style = window.getComputedStyle(htmlEl);
            const zIndex = Number.parseInt(style.zIndex || '0', 10);
            const overlayLike =
                style.position === 'fixed' ||
                style.position === 'sticky' ||
                zIndex >= 1000 ||
                htmlEl.getAttribute('role') === 'dialog';

            if (!overlayLike) {
                continue;
            }

            const attrs = [
                htmlEl.id,
                htmlEl.className,
                htmlEl.getAttribute('aria-label') || '',
                htmlEl.getAttribute('role') || '',
                htmlEl.getAttribute('data-testid') || '',
            ].join(' ');
            const snippet = (htmlEl.innerText || '').slice(0, 500);

            if (noisePattern.test(attrs) || noisePattern.test(snippet)) {
                htmlEl.remove();
            }
        }

        document.documentElement.style.overflow = 'auto';
        if (document.body) {
            document.body.style.overflow = 'auto';
        }
    }).catch(() => { });
}

// ── Browser Lifecycle ──────────────────────────────────────────────────────────

export async function ensureBrowser(): Promise<Browser> {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-sandbox',
            ],
        });
        desktopContext = null;
        mobileContext = null;
    }
    return browser;
}

async function createStealthContext(ua: string, viewport: { width: number; height: number }, isMobile: boolean): Promise<BrowserContext> {
    const b = await ensureBrowser();
    const ctx = await b.newContext({
        userAgent: ua,
        viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        javaScriptEnabled: true,
        isMobile,
        hasTouch: isMobile,
        extraHTTPHeaders: {
            DNT: '1',
            'Sec-GPC': '1',
        },
    });

    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(window, 'chrome', {
            get: () => ({
                runtime: {},
                loadTimes: () => ({}),
                csi: () => ({}),
            }),
        });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: 'denied' } as PermissionStatus)
                : originalQuery(parameters);
    });

    await ctx.route('**/*', async (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const { frameUrl, hasParentFrame } = getRequestFrameInfo(request);

        if (resourceType === 'document' && !hasParentFrame) {
            const protocol = new URL(request.url()).protocol;
            if (protocol !== 'http:' && protocol !== 'https:') {
                await route.abort('blockedbyclient').catch(() => { });
                return;
            }
            await route.continue().catch(() => { });
            return;
        }

        const filters = await getFilterBundle();
        if (shouldBlockRequest(request.url(), frameUrl, filters.blockedDomains)) {
            await route.abort('blockedbyclient').catch(() => route.abort().catch(() => { }));
            return;
        }

        await route.continue().catch(() => { });
    });

    return ctx;
}

export async function getBrowserContext(mobile = false): Promise<BrowserContext> {
    if (mobile) {
        if (!mobileContextPromise) {
            mobileContextPromise = createStealthContext(MOBILE_UA, MOBILE_VIEWPORT, true)
                .then(ctx => { mobileContext = ctx; return ctx; })
                .catch(err => { mobileContextPromise = null; throw err; });
        }
        return mobileContextPromise;
    }
    if (!desktopContextPromise) {
        desktopContextPromise = createStealthContext(DESKTOP_UA, DESKTOP_VIEWPORT, false)
            .then(ctx => { desktopContext = ctx; return ctx; })
            .catch(err => { desktopContextPromise = null; throw err; });
    }
    return desktopContextPromise;
}

export async function closeBrowser(): Promise<void> {
    desktopContextPromise = null;
    mobileContextPromise = null;
    if (desktopContext) { await desktopContext.close().catch(() => { }); desktopContext = null; }
    if (mobileContext) { await mobileContext.close().catch(() => { }); mobileContext = null; }
    if (browser) { await browser.close().catch(() => { }); browser = null; }
}

// ── Page Navigation Helper ─────────────────────────────────────────────────────

export async function navigateAndCleanup(
    url: string,
    options: { mobile?: boolean; waitTime?: number } = {},
): Promise<{ page: Page; filters: FilterBundle; finalUrl: string }> {
    const { mobile = false, waitTime = 0 } = options;
    const [ctx, filters] = await Promise.all([getBrowserContext(mobile), getFilterBundle()]);
    const page = await ctx.newPage();
    try {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT,
        });

        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
        if (waitTime > 0) {
            await page.waitForTimeout(Math.min(waitTime, 10) * 1000);
        }

        await applyPageCleanup(page, filters, page.url());

        return { page, filters, finalUrl: page.url() };
    } catch (error) {
        await page.close().catch(() => { });
        throw error;
    }
}
