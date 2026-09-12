import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getCosmeticSelectorsForUrl,
    hostnameSuffixes,
    parseFilterText,
    shouldBlockRequest,
    type FilterBundle,
} from '../src/filters.js';

function bundle(): FilterBundle {
    return {
        blockedDomains: new Set(),
        genericCosmeticSelectors: [],
        domainCosmeticSelectors: new Map(),
    };
}

test('parseFilterText reads supported network and cosmetic rules', () => {
    const filters = bundle();
    const generic = new Set<string>();
    const scoped = new Map<string, Set<string>>();

    parseFilterText([
        '||ads.example.com^',
        '0.0.0.0 tracker.example.net',
        '##.generic-ad',
        'news.example.com##.sponsor',
        '@@||allowed.example.com^',
        'news.example.com#@#.exception',
    ].join('\n'), filters.blockedDomains, generic, scoped);

    assert.deepEqual([...filters.blockedDomains].sort(), ['ads.example.com', 'tracker.example.net']);
    assert.deepEqual([...generic], ['.generic-ad']);
    assert.deepEqual([...scoped.get('news.example.com') ?? []], ['.sponsor']);
});

test('request blocking respects first-party requests and domain suffixes', () => {
    const blocked = new Set(['tracker.example', 'ads.example.com']);
    assert.equal(shouldBlockRequest('https://cdn.ads.example.com/a.js', 'https://news.test/', blocked), true);
    assert.equal(shouldBlockRequest('https://assets.news.test/a.js', 'https://news.test/', blocked), false);
    assert.equal(shouldBlockRequest('https://notads.example.com/a.js', 'https://news.test/', blocked), false);
});

test('cosmetic selectors include generic and parent-domain rules', () => {
    const filters: FilterBundle = {
        blockedDomains: new Set(),
        genericCosmeticSelectors: ['.generic'],
        domainCosmeticSelectors: new Map([
            ['example.com', ['.site-ad']],
            ['news.example.com', ['.news-ad']],
        ]),
    };

    assert.deepEqual(hostnameSuffixes('www.news.example.com'), [
        'www.news.example.com', 'news.example.com', 'example.com',
    ]);
    assert.deepEqual(getCosmeticSelectorsForUrl(filters, 'https://www.news.example.com/'), [
        '.generic', '.news-ad', '.site-ad',
    ]);
});
