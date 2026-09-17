import { describe, expect, it } from 'vitest';
import { classifyCertificate, collectCapped, extractAssetUrls, mapLimit } from '../../src/core/probe.js';

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
  /** The URLs only: every test but the cap one is about which references are found. */
  const urls = (html: string, at = page): string[] => extractAssetUrls(html, at).urls;

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
    expect(urls(html, page)).toEqual(['/next/_next/static/app.css', '/next/favicon.ico', '/next.svg?a=1&b=2', '/hero-1x.png', '/shared/app.js']);
  });

  it('skips data URIs, other hosts, fragments and empty references', () => {
    const html = `<img src="data:image/png;base64,iVBOR"><img src="https://cdn.example.com/x.png"><img src="//cdn.example.com/y.png"><img src="#"><img src=""><a href="/page.css">link</a>`;
    // Only what the app itself has to serve is worth checking: another host's 404 is not this
    // deploy's problem, and an <a href> is a page, not an asset the browser loads.
    expect(urls(html, page)).toEqual([]);
  });

  it('ignores commented-out tags and anything inside a script or style body', () => {
    // These are the false failures: a page that works perfectly would have been reported as
    // broken because a commented-out <img>, a CSS url() or a string inside a script was fetched.
    const html = `<!-- <img src="/old-hero.png"> -->
      <style>body{background:url(/bg.png)}</style>
      <script>document.write('<img src="/written.png">'); var s = "<!--";</script>
      <script src="/app.js"></script>
      <img src="/real.png">`;
    expect(urls(html, page)).toEqual(['/app.js', '/real.png']);
  });

  it('takes the first srcset candidate even when a URL holds commas, and never a data: one', () => {
    // Splitting on every comma cut `/a,b.png` in half and turned a base64 data URI into a path.
    expect(urls('<img srcset="/a,b.png 1x, /c.png 2x">', page)).toEqual(['/a,b.png']);
    expect(urls('<img srcset="data:image/png;base64,iVBOR 1x, /c.png 2x">', page)).toEqual([]);
    expect(urls('<img srcset="/only.png">', page)).toEqual(['/only.png']);
  });

  it('de-duplicates and stops at twelve, so one broken page cannot fan out into a scan', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<script src="/a${i}.js"></script>`).join('');
    expect(urls(`<img src="/dup.png"><img src="/dup.png">`, page)).toEqual(['/dup.png']);
    expect(urls(`<img src="/dup.png"><img src="/dup.png">${many}`, page)).toHaveLength(12);
  });

  it('reports the cap and the full count, so the caller never claims it checked the whole page', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<script src="/a${i}.js"></script>`).join('');
    expect(extractAssetUrls(many, page)).toMatchObject({ truncated: true, totalFound: 20 });
    // Exactly at the cap nothing was left out, and a page saying so would be a lie of its own.
    expect(extractAssetUrls(Array.from({ length: 12 }, (_, i) => `<script src="/b${i}.js"></script>`).join(''), page)).toMatchObject({ truncated: false, totalFound: 12 });
    expect(extractAssetUrls('<img src="/one.png">', page)).toEqual({ urls: ['/one.png'], truncated: false, totalFound: 1 });
    // A page URL that is not a URL yields nothing to check, not a truncated nothing.
    expect(extractAssetUrls('<img src="/one.png">', 'not a url')).toEqual({ urls: [], truncated: false, totalFound: 0 });
  });
});

describe('mapLimit', () => {
  const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('keeps results in input order however the calls finish', async () => {
    // The caller pairs answers with inputs by index, so a fast item must not overtake a slow one.
    const out = await mapLimit([30, 1, 20, 2], 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 1, 20, 2].map((value) => ({ status: 'fulfilled', value })));
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(Array.from({ length: 12 }, (_, i) => i), 4, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return i;
    });
    expect(peak).toBe(4);
    expect(out).toHaveLength(12);
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('surfaces a rejection per item like allSettled instead of failing the batch', async () => {
    const out = await mapLimit(['ok', 'bad', 'ok'], 2, async (v) => {
      if (v === 'bad') throw new Error('boom');
      return v;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'ok' });
    expect(out[1]).toMatchObject({ status: 'rejected' });
    expect((out[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  it('runs one worker rather than none when the limit is not a usable number', async () => {
    // Math.trunc(NaN) is NaN, and Math.max/Math.min of NaN is NaN: Array.from({length: NaN})
    // builds nothing, so every result would be a hole the caller reads as "nothing answered".
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(await mapLimit([1, 2, 3], limit, async (n) => n * 2), String(limit)).toEqual([2, 4, 6].map((value) => ({ status: 'fulfilled', value })));
    }
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (n) => n * 2)).toEqual([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
    ]);
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
