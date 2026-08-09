#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, mkdirSync, createWriteStream, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import { NAVIGATION_TIMEOUT } from './constants.js';
import { getFilterBundle } from './filters.js';
import { closeBrowser, getBrowserContext, navigateAndCleanup, applyPageCleanup } from './browser.js';
import { fetchAndExtract, extractLinks } from './extract.js';

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Web Fetcher',
    version: '1.1.0',
    title: 'Web Fetcher',
    description: 'Stealthy web page fetcher that converts pages to clean, LLM-readable markdown with optional link extraction and media download.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-webfetch/icon.png', mimeType: 'image/png' }],
});

// ── Tool: fetch_page ───────────────────────────────────────────────────────────

server.registerTool(
    'fetch_page',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Fetch a web page and return its content as clean, structured markdown. ' +
            'Uses a real browser engine to handle JavaScript-rendered content. ' +
            'Extracts the main article/content by default, stripping navbars, ads, and boilerplate. ' +
            'Use get_page_links to discover links on the page for navigation.',
        inputSchema: {
            url: z.string().url().describe('The URL to fetch'),
            only_main_content: z.boolean().default(true).describe(
                'When true (default), extracts only the main content (article body) using smart content detection, ' +
                'stripping navigation, ads, footers, and other boilerplate. Set to false to get the full page content.'
            ),
            mobile: z.boolean().default(false).describe(
                'Fetch the page as a mobile device. Some sites serve simpler, less cluttered content to mobile browsers.'
            ),
            wait_time: z.number().min(0).max(10).default(0).describe(
                'Extra seconds to wait after page load before extracting content (0-10). ' +
                'Useful for pages with delayed or dynamically loaded content.'
            ),
        },
    },
    async ({ url, only_main_content, mobile, wait_time }) => {
        try {
            const result = await fetchAndExtract(url, {
                onlyMainContent: only_main_content,
                mobile,
                waitTime: wait_time,
            });

            const parts: string[] = [];

            if (result.title) parts.push(`# ${result.title}`);
            if (result.byline) parts.push(`*${result.byline}*`);
            if (result.url !== url) parts.push(`> Redirected to: ${result.url}`);
            if (result.excerpt) parts.push(`> ${result.excerpt}`);

            parts.push('---');
            parts.push(result.content);

            return {
                content: [{ type: 'text' as const, text: parts.join('\n\n') }],
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text' as const, text: `Failed to fetch page: ${message}` }],
                isError: true,
            };
        }
    }
);

// ── Tool: screenshot_page ──────────────────────────────────────────────────────

server.registerTool(
    'screenshot_page',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Take a screenshot of a web page and return it as a base64-encoded PNG image. ' +
            'Useful for visually inspecting page layout or verifying content.',
        inputSchema: {
            url: z.string().url().describe('The URL to screenshot'),
            full_page: z.boolean().default(false).describe(
                'Capture the full scrollable page instead of just the viewport.'
            ),
            mobile: z.boolean().default(false).describe(
                'Screenshot the page as a mobile device.'
            ),
            wait_time: z.number().min(0).max(10).default(0).describe(
                'Extra seconds to wait after page load before taking the screenshot (0-10).'
            ),
        },
    },
    async ({ url, full_page, mobile, wait_time }) => {
        const [ctx, filters] = await Promise.all([getBrowserContext(mobile), getFilterBundle()]);
        const page = await ctx.newPage();
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: NAVIGATION_TIMEOUT,
            });

            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { });
            if (wait_time > 0) {
                await page.waitForTimeout(Math.min(wait_time, 10) * 1000);
            }

            await applyPageCleanup(page, filters, page.url());

            const buffer = await page.screenshot({
                fullPage: full_page,
                type: 'png',
            });

            return {
                content: [
                    {
                        type: 'image' as const,
                        data: buffer.toString('base64'),
                        mimeType: 'image/png',
                    },
                ],
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text' as const, text: `Failed to screenshot page: ${message}` }],
                isError: true,
            };
        } finally {
            await page.close();
        }
    }
);

// ── Tool: get_page_links ───────────────────────────────────────────────────────

server.registerTool(
    'get_page_links',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description:
            'Get all links found on a web page, grouped by internal (same site) and external links. ' +
            'Does NOT extract page content — use fetch_page for that. ' +
            'Faster than fetch_page since it skips content extraction. ' +
            'Use this to explore site structure and find relevant sub-pages before fetching them.',
        inputSchema: {
            url: z.string().url().describe('The URL to scan for links'),
            mobile: z.boolean().default(false).describe(
                'Load the page as a mobile device.'
            ),
            wait_time: z.number().min(0).max(10).default(0).describe(
                'Extra seconds to wait after page load before extracting links (0-10).'
            ),
        },
    },
    async ({ url, mobile, wait_time }) => {
        let page;
        try {
            const nav = await navigateAndCleanup(url, { mobile, waitTime: wait_time });
            page = nav.page;
            const finalUrl = nav.finalUrl;

            const rawHtml = await page.content();
            const title = await page.title();
            const links = extractLinks(rawHtml, finalUrl);

            const baseHost = new URL(finalUrl).hostname;
            const internal: typeof links = [];
            const external: typeof links = [];
            for (const link of links) {
                try {
                    const linkHost = new URL(link.href).hostname;
                    if (linkHost === baseHost || linkHost.endsWith('.' + baseHost)) {
                        internal.push(link);
                    } else {
                        external.push(link);
                    }
                } catch {
                    external.push(link);
                }
            }

            const parts: string[] = [];
            parts.push(`# Links on: ${title || finalUrl}`);
            if (finalUrl !== url) parts.push(`> Redirected to: ${finalUrl}`);
            parts.push(`Found **${links.length}** links (${internal.length} internal, ${external.length} external).`);

            if (internal.length > 0) {
                parts.push('');
                parts.push('## Internal Links (same site)');
                for (const link of internal) {
                    parts.push(`- [${link.text}](${link.href})`);
                }
            }

            if (external.length > 0) {
                parts.push('');
                parts.push('## External Links');
                for (const link of external) {
                    parts.push(`- [${link.text}](${link.href})`);
                }
            }

            return {
                content: [{ type: 'text' as const, text: parts.join('\n') }],
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text' as const, text: `Failed to get page links: ${message}` }],
                isError: true,
            };
        } finally {
            await page?.close();
        }
    }
);

// ── Tool: download_file ────────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
    // Images
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
    'image/avif': '.avif', 'image/tiff': '.tiff',
    // Audio
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/flac': '.flac', 'audio/aac': '.aac', 'audio/mp4': '.m4a',
    'audio/opus': '.opus',
    // Video
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
    'video/x-msvideo': '.avi', 'video/quicktime': '.mov',
    // Archives
    'application/zip': '.zip', 'application/x-tar': '.tar',
    'application/gzip': '.gz', 'application/x-gzip': '.gz',
    'application/x-bzip2': '.bz2', 'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar', 'application/x-xz': '.xz',
    // Documents
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt', 'text/csv': '.csv',
    'application/json': '.json', 'application/xml': '.xml',
    // Binary / other
    'application/octet-stream': '.bin',
};

function getDefaultDownloadsDir(): string {
    return join(homedir(), 'Downloads');
}

function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, 200);
}

function deriveFilename(url: string, contentType: string | null): string {
    // Try to get a name from the URL path
    try {
        const parsed = new URL(url);
        const pathName = basename(parsed.pathname);
        if (pathName && pathName !== '/' && pathName.includes('.')) {
            return sanitizeFilename(decodeURIComponent(pathName));
        }
    } catch { /* ignore */ }

    // Fall back to content type
    const mime = contentType?.split(';')[0].trim();
    const ext = mime ? MIME_TO_EXT[mime] : null;
    const timestamp = Date.now();
    return `download_${timestamp}${ext || '.bin'}`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

server.registerTool(
    'download_file',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description:
            'Download any file from a URL to the local disk. ' +
            'Handles all file types: images, audio, video, archives (zip, tar, 7z), documents (PDF, DOCX), binaries, and more. ' +
            'Files are saved to ~/Downloads by default, or a custom path. ' +
            'Returns the saved file path and size.',
        inputSchema: {
            url: z.string().url().describe('Direct URL to the file to download'),
            filename: z.string().optional().describe(
                'Custom filename for the saved file (optional). If omitted, derived from the URL or content type.'
            ),
            output_path: z.string().optional().describe(
                'Full output file path OR directory to save the file to (optional). ' +
                'If a directory, the filename is derived automatically. ' +
                'If a full path with filename, that exact path is used. ' +
                'Defaults to ~/Downloads.'
            ),
        },
    },
    async ({ url, filename, output_path }) => {
        try {
            // Fetch the file
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120_000);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
            });

            clearTimeout(timeout);

            if (!response.ok) {
                return {
                    content: [{ type: 'text' as const, text: `Download failed: HTTP ${response.status} ${response.statusText}` }],
                    isError: true,
                };
            }

            const contentType = response.headers.get('content-type');

            // Resolve save path
            let savePath: string;

            if (output_path) {
                // Check if output_path looks like a directory (ends with / or has no extension)
                const hasExt = /\.[a-zA-Z0-9]+$/.test(basename(output_path));
                if (output_path.endsWith('/') || !hasExt) {
                    // It's a directory — create it and derive filename
                    if (!existsSync(output_path)) mkdirSync(output_path, { recursive: true });
                    const resolvedName = filename
                        ? sanitizeFilename(filename)
                        : deriveFilename(url, contentType);
                    savePath = join(output_path, resolvedName);
                } else {
                    // It's a full file path
                    const dir = join(output_path, '..');
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    savePath = output_path;
                }
            } else {
                const saveDir = getDefaultDownloadsDir();
                if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
                const resolvedName = filename
                    ? sanitizeFilename(filename)
                    : deriveFilename(url, contentType);
                savePath = join(saveDir, resolvedName);
            }

            // Stream to disk to avoid buffering large files in memory
            if (!response.body) {
                return {
                    content: [{ type: 'text' as const, text: 'Download failed: empty response body' }],
                    isError: true,
                };
            }
            const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
            await pipeline(nodeStream, createWriteStream(savePath));

            const fileSize = statSync(savePath).size;

            return {
                content: [{
                    type: 'text' as const,
                    text: `Downloaded successfully.\n\n` +
                        `- **File**: ${basename(savePath)}\n` +
                        `- **Path**: ${savePath}\n` +
                        `- **Size**: ${formatSize(fileSize)}\n` +
                        `- **Type**: ${contentType || 'unknown'}\n` +
                        `- **Source**: ${url}`,
                }],
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text' as const, text: `Failed to download: ${message}` }],
                isError: true,
            };
        }
    }
);

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
