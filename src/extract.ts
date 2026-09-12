import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
// @ts-expect-error — no type declarations available
import { gfm } from 'turndown-plugin-gfm';
import type { Page } from 'playwright';
import { MAX_CONTENT_LENGTH } from './constants.js';
import { getFilterBundle } from './filters.js';
import { applyPageCleanup, getBrowserContext } from './browser.js';
import { NAVIGATION_TIMEOUT } from './constants.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ExtractedContent {
    title: string;
    content: string;
    excerpt: string;
    byline: string;
    url: string;
}

interface ParsedCandidate {
    title: string;
    excerpt: string;
    byline: string;
    contentHtml: string;
    textLength: number;
}

// ── Turndown ───────────────────────────────────────────────────────────────────

export function createTurndownService(): TurndownService {
    const td = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
    });
    td.use(gfm);

    td.remove(['script', 'style', 'noscript', 'iframe']);
    td.addRule('remove-svg', {
        filter: (node) => node.nodeName.toLowerCase() === 'svg',
        replacement: () => '',
    });

    return td;
}

// ── Link Extraction ────────────────────────────────────────────────────────────

export function extractLinks(html: string, baseUrl: string): { text: string; href: string }[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const anchors = doc.querySelectorAll('a[href]');
    const seen = new Set<string>();
    const links: { text: string; href: string }[] = [];

    for (const anchor of anchors) {
        const href = anchor.getAttribute('href');
        if (!href) continue;

        try {
            const resolved = new URL(href, baseUrl).href;
            if (resolved.startsWith('javascript:') || resolved.startsWith('mailto:') ||
                resolved.startsWith('tel:') || resolved.startsWith('data:') ||
                resolved.includes('#') && new URL(resolved).pathname === new URL(baseUrl).pathname) {
                continue;
            }
            if (seen.has(resolved)) continue;
            seen.add(resolved);

            const text = (anchor.textContent || '').trim().replace(/\s+/g, ' ');
            if (text.length > 0 && text.length < 200) {
                links.push({ text, href: resolved });
            }
        } catch {
            // Invalid URL, skip
        }
    }
    return links;
}

// ── Content Parsing ────────────────────────────────────────────────────────────

async function parseCandidate(html: string, url: string): Promise<ParsedCandidate | null> {
    const dom = new JSDOM(html, { url });

    const result = await Defuddle(dom.window.document, url);
    if (!result || !result.content) {
        return null;
    }

    return {
        title: result.title || '',
        excerpt: result.description || '',
        byline: result.author || '',
        contentHtml: result.content || '',
        textLength: (result.content || '').length,
    };
}

function pickBestCandidate(
    cleanedCandidate: ParsedCandidate | null,
    originalCandidate: ParsedCandidate | null,
): ParsedCandidate | null {
    if (!cleanedCandidate) {
        return originalCandidate;
    }
    if (!originalCandidate) {
        return cleanedCandidate;
    }

    if (cleanedCandidate.textLength >= originalCandidate.textLength * 0.6) {
        return cleanedCandidate;
    }

    return originalCandidate;
}

// ── Main Extraction ────────────────────────────────────────────────────────────

export async function fetchAndExtract(
    url: string,
    options: {
        waitTime?: number;
        onlyMainContent?: boolean;
        mobile?: boolean;
    } = {}
): Promise<ExtractedContent> {
    const {
        waitTime = 0,
        onlyMainContent = true,
        mobile = false,
    } = options;

    const [ctx, filters] = await Promise.all([getBrowserContext(mobile), getFilterBundle()]);
    const page: Page = await ctx.newPage();

    try {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT,
        });

        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
        if (waitTime > 0) {
            await page.waitForTimeout(Math.min(waitTime, 10) * 1000);
        }

        const originalHtml = await page.content();

        await applyPageCleanup(page, filters, page.url());

        const finalUrl = page.url();
        const cleanedHtml = await page.content();

        let title = '';
        let content = '';
        let excerpt = '';
        let byline = '';

        if (onlyMainContent) {
            const cleanedCandidate = await parseCandidate(cleanedHtml, finalUrl);
            const isThin = !cleanedCandidate || cleanedCandidate.textLength < originalHtml.length * 0.05;
            const article = (isThin && originalHtml !== cleanedHtml)
                ? pickBestCandidate(cleanedCandidate, await parseCandidate(originalHtml, finalUrl))
                : cleanedCandidate;

            if (article) {
                title = article.title || '';
                byline = article.byline || '';
                excerpt = article.excerpt || '';
                const td = createTurndownService();
                content = td.turndown(article.contentHtml || '');
            } else {
                title = await page.title();
                const td = createTurndownService();
                const cleanedBody = await page.evaluate(() => document.body?.innerHTML || '');
                content = td.turndown(cleanedBody);

                // Fallback: if cleanup stripped too much, use the original HTML
                if (content.trim().length < 100 && originalHtml.length > 500) {
                    const dom = new JSDOM(originalHtml, { url: finalUrl });
                    const bodyEl = dom.window.document.body;
                    if (bodyEl) {
                        content = td.turndown(bodyEl.innerHTML);
                    }
                }
            }
        } else {
            title = await page.title();
            const td = createTurndownService();
            const cleanedBody = await page.evaluate(() => document.body?.innerHTML || '');
            content = td.turndown(cleanedBody);

            // Fallback: if cleanup stripped too much, use the original HTML
            if (content.trim().length < 100 && originalHtml.length > 500) {
                const dom = new JSDOM(originalHtml, { url: finalUrl });
                const bodyEl = dom.window.document.body;
                if (bodyEl) {
                    content = td.turndown(bodyEl.innerHTML);
                }
            }
        }

        if (content.length > MAX_CONTENT_LENGTH) {
            content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n[... content truncated ...]';
        }

        return { title, content, excerpt, byline, url: finalUrl };
    } finally {
        await page.close();
    }
}
