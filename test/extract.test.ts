import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurndownService, extractLinks } from '../src/extract.js';

test('extractLinks resolves, filters, and deduplicates links', () => {
    const links = extractLinks(`
        <a href="/article">Article</a>
        <a href="https://example.com/article">Duplicate</a>
        <a href="#section">Fragment</a>
        <a href="mailto:test@example.com">Email</a>
        <a href="https://other.test/"> External site </a>
        <a href="/empty"></a>
    `, 'https://example.com/start');

    assert.deepEqual(links, [
        { text: 'Article', href: 'https://example.com/article' },
        { text: 'External site', href: 'https://other.test/' },
    ]);
});

test('Turndown produces readable GFM and removes active/noisy elements', () => {
    const markdown = createTurndownService().turndown(`
        <h1>Heading</h1><p>Hello <strong>world</strong>.</p>
        <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>
        <script>alert(1)</script><iframe src="https://example.com"></iframe><svg><text>noise</text></svg>
    `);

    assert.match(markdown, /^# Heading/m);
    assert.match(markdown, /Hello \*\*world\*\*/);
    assert.match(markdown, /\| A\s+\|/);
    assert.doesNotMatch(markdown, /alert|iframe|noise/);
});
