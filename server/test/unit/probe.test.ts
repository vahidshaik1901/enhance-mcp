import { describe, expect, it } from 'vitest';
import { classifyCertificate, collectCapped, extractAssetUrls } from '../../src/core/probe.js';

describe('classifyCertificate', () => {
  it('is valid when TLS authorised the chain', () => {
    expect(classifyCertificate({ issuer: { CN: 'R11' }, subject: { CN: 'vahi.dev' }, valid_from: 'Sep  5 17:28:04 2026 GMT' }, 'vahi.dev', true)).toBe('valid');
  });
  it("is the panel's placeholder when the certificate is self-issued for the domain and dated 1975", () => {
    expect(classifyCertificate({ issuer: { CN: 'vahi.dev' }, subject: { CN: 'vahi.dev' }, valid_from: 'Jan  1 00:00:00 1975 GMT' }, 'vahi.dev', false, 'SELF_SIGNED_CERT_IN_CHAIN')).toBe('placeholder');
  });
  it('reports any other failure with its reason', () => {
    expect(classifyCertificate({ issuer: { CN: 'R11' }, subject: { CN: 'other.example' }, valid_from: 'Sep  5 17:28:04 2026 GMT' }, 'vahi.dev', false, 'ERR_TLS_CERT_ALTNAME_INVALID')).toBe('error:ERR_TLS_CERT_ALTNAME_INVALID');
    expect(classifyCertificate(undefined, 'vahi.dev', false)).toBe('error:no certificate');
  });
});

describe('extractAssetUrls', () => {
  const page = 'https://vahi.dev/next/';

  it('takes img, script and stylesheet/icon/preload references and resolves them against the page', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/next/_next/static/app.css">
      <link rel="shortcut icon" href="favicon.ico">
      <link rel="preconnect" href="/never-fetched.css">
      </head><body>
      <img src="/next.svg?a=1&amp;b=2">
      <img srcset="/hero-1x.png 1x, /hero-2x.png 2x" alt="hero">
      <script src="../shared/app.js"></script>
      </body></html>`;
    // Document order, one entry per reference: the first srcset candidate only, and the
    // rel="preconnect" link left out because it is not something the page renders.
    expect(extractAssetUrls(html, page)).toEqual(['/next/_next/static/app.css', '/next/favicon.ico', '/next.svg?a=1&b=2', '/hero-1x.png', '/shared/app.js']);
  });

  it('skips data URIs, other hosts, fragments and empty references', () => {
    const html = `<img src="data:image/png;base64,iVBOR"><img src="https://cdn.example.com/x.png"><img src="//cdn.example.com/y.png"><img src="#"><img src=""><a href="/page.css">link</a>`;
    // Only what the app itself has to serve is worth checking: another host's 404 is not this
    // deploy's problem, and an <a href> is a page, not an asset the browser loads.
    expect(extractAssetUrls(html, page)).toEqual([]);
  });

  it('ignores commented-out tags and anything inside a script or style body', () => {
    // These are the false failures: a page that works perfectly would have been reported as
    // broken because a commented-out <img>, a CSS url() or a string inside a script was fetched.
    const html = `<!-- <img src="/old-hero.png"> -->
      <style>body{background:url(/bg.png)}</style>
      <script>document.write('<img src="/written.png">'); var s = "<!--";</script>
      <script src="/app.js"></script>
      <img src="/real.png">`;
    expect(extractAssetUrls(html, page)).toEqual(['/app.js', '/real.png']);
  });

  it('takes the first srcset candidate even when a URL holds commas, and never a data: one', () => {
    // Splitting on every comma cut `/a,b.png` in half and turned a base64 data URI into a path.
    expect(extractAssetUrls('<img srcset="/a,b.png 1x, /c.png 2x">', page)).toEqual(['/a,b.png']);
    expect(extractAssetUrls('<img srcset="data:image/png;base64,iVBOR 1x, /c.png 2x">', page)).toEqual([]);
    expect(extractAssetUrls('<img srcset="/only.png">', page)).toEqual(['/only.png']);
  });

  it('de-duplicates and stops at twelve, so one broken page cannot fan out into a scan', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<script src="/a${i}.js"></script>`).join('');
    expect(extractAssetUrls(`<img src="/dup.png"><img src="/dup.png">`, page)).toEqual(['/dup.png']);
    expect(extractAssetUrls(`<img src="/dup.png"><img src="/dup.png">${many}`, page)).toHaveLength(12);
  });
});

describe('collectCapped', () => {
  it('keeps every byte and does not flag the cap when the body is smaller', () => {
    expect(collectCapped([Buffer.from('mcp-c '), Buffer.from('ok')], 512)).toEqual({ body: 'mcp-c ok', hitCap: false });
    expect(collectCapped([], 512)).toEqual({ body: '', hitCap: false });
  });
  it('truncates at the cap and flags it, which is what stops the read', () => {
    expect(collectCapped([Buffer.from('abcdef')], 4)).toEqual({ body: 'abcd', hitCap: true });
    // Exactly the cap counts as reached: there is nothing further the probe would ever report,
    // so httpsProbe settles and destroys the socket rather than draining a streaming body.
    expect(collectCapped([Buffer.from('ab'), Buffer.from('cd')], 4)).toEqual({ body: 'abcd', hitCap: true });
  });
});
