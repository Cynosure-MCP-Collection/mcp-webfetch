import assert from 'node:assert/strict';
import test from 'node:test';
import { isHttpUrl } from '../src/url.js';

test('isHttpUrl accepts normal HTTP and HTTPS URLs', () => {
    assert.equal(isHttpUrl('https://example.com/path?q=1'), true);
    assert.equal(isHttpUrl('http://localhost:8080/'), true);
});

test('isHttpUrl rejects non-web schemes and malformed input', () => {
    assert.equal(isHttpUrl('file:///etc/passwd'), false);
    assert.equal(isHttpUrl('data:text/plain,hello'), false);
    assert.equal(isHttpUrl('ftp://example.com/file'), false);
    assert.equal(isHttpUrl('not a url'), false);
});
