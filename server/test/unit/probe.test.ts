import { describe, expect, it } from 'vitest';
import { classifyCertificate, collectCapped } from '../../src/core/probe.js';

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
