import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import {
  GITHUB_COM,
  headerHost,
  fromSite,
  payloadFromSite,
  hostMismatch,
  mismatchSender,
  parseGitHubEnterpriseUrl,
  payloadHost,
  payloadHostRefusal,
} from '../../src/surface/connectors/github/site.js';

const GHES = parseGitHubEnterpriseUrl('https://ghes.example.com');

describe('parseGitHubEnterpriseUrl', () => {
  it('reads unset as github.com', () => {
    expect(parseGitHubEnterpriseUrl(undefined)).toBe(GITHUB_COM);
    expect(GITHUB_COM).toEqual({ host: undefined, apiBase: 'https://api.github.com', ownsBareRefs: false });
  });

  it.each(['https://ghes.example.com', 'https://ghes.example.com/'])('accepts %s', (raw) => {
    expect(parseGitHubEnterpriseUrl(raw)).toEqual({
      host: 'ghes.example.com',
      apiBase: 'https://ghes.example.com/api/v3',
      ownsBareRefs: false,
    });
  });

  it('lower-cases the host and keeps the port in the API base only', () => {
    expect(parseGitHubEnterpriseUrl('https://GHES.Example.com:8443')).toEqual({
      host: 'ghes.example.com',
      apiBase: 'https://ghes.example.com:8443/api/v3',
      ownsBareRefs: false,
    });
  });

  it('allows http on a loopback address', () => {
    expect(parseGitHubEnterpriseUrl('http://127.0.0.1:8080')).toEqual({
      host: '127.0.0.1',
      apiBase: 'http://127.0.0.1:8080/api/v3',
      ownsBareRefs: false,
    });
  });

  it.each([
    'ghes.example.com',
    'ftp://ghes.example.com',
    'http://ghes.example.com',
    'https://u:p@ghes.example.com',
    'https://ghes.example.com/api/v3',
    'https://ghes.example.com/?a=1',
    'https://ghes.example.com/#x',
    'https://ghe',
    'https://localhost:8443',
    'https://github.com',
    'https://api.github.com',
    'https://github.com.',
    'https://ghes.example.com.',
  ])('refuses %s', (raw) => {
    expect(() => parseGitHubEnterpriseUrl(raw)).toThrow(/GITHUB_ENTERPRISE_URL/);
  });
});

describe('the bare-refs host', () => {
  it.each(['ghes.example.com', ' GHES.Example.COM '])('owns bare refs when %j names the same host', (mapped) => {
    expect(parseGitHubEnterpriseUrl('https://ghes.example.com', mapped).ownsBareRefs).toBe(true);
  });

  it('is off by default, and an empty mapping stays off', () => {
    expect(parseGitHubEnterpriseUrl('https://ghes.example.com').ownsBareRefs).toBe(false);
    expect(parseGitHubEnterpriseUrl(undefined, undefined).ownsBareRefs).toBe(false);
  });

  it('needs GITHUB_ENTERPRISE_URL', () => {
    expect(() => parseGitHubEnterpriseUrl(undefined, 'ghes.example.com')).toThrow(
      /GITHUB_ENTERPRISE_BARE_REFS_HOST.*GITHUB_ENTERPRISE_URL/,
    );
  });

  it('names both values when the hosts differ', () => {
    expect(() => parseGitHubEnterpriseUrl('https://ghes.example.com', 'other.example.com')).toThrow(
      /GITHUB_ENTERPRISE_BARE_REFS_HOST.*other\.example\.com.*ghes\.example\.com/,
    );
  });
});

describe('payloadHost', () => {
  it.each<[JsonValue | undefined, string | undefined]>([
    [{ repository: { html_url: 'https://github.com/o/r' } }, 'github.com'],
    [{ repository: { html_url: 'https://GHES.example.com/o/r' } }, 'ghes.example.com'],
    [{ repository: { html_url: 'not a url' } }, undefined],
    [{ repository: { html_url: 5 } }, undefined],
    [{ repository: {} }, undefined],
    [{}, undefined],
    [[], undefined],
    [undefined, undefined],
  ])('reads %j as %s', (payload, host) => {
    expect(payloadHost(payload)).toBe(host);
  });
});

describe('payloadHostRefusal', () => {
  it('takes any server while the site is github.com, and its own host on GHES', () => {
    expect(payloadHostRefusal('github.com', GITHUB_COM)).toBeNull();
    expect(payloadHostRefusal(undefined, GITHUB_COM)).toBeNull();
    expect(payloadHostRefusal('ghes.example.com', GHES)).toBeNull();
  });

  it('names what the payload names and what GITHUB_ENTERPRISE_URL names', () => {
    expect(payloadHostRefusal('github.com', GHES)).toBe(
      'payload names github.com; GITHUB_ENTERPRISE_URL names ghes.example.com',
    );
    expect(payloadHostRefusal('other.example.com', GHES)).toBe(
      'payload names other.example.com; GITHUB_ENTERPRISE_URL names ghes.example.com',
    );
    expect(payloadHostRefusal(undefined, GHES)).toBe(
      'payload names no repository URL; GITHUB_ENTERPRISE_URL names ghes.example.com',
    );
  });
});

describe('headerHost', () => {
  it('reads absent and blank as undefined', () => {
    expect(headerHost(null)).toBeUndefined();
    expect(headerHost('  ')).toBeUndefined();
  });

  it('trims and lower-cases', () => {
    expect(headerHost(' GHES.Example.com ')).toBe('ghes.example.com');
  });

  it.each(['a;b', 'a b'])('marks %s invalid', (raw) => {
    expect(headerHost(raw)).toBe('(invalid)');
  });
});

describe('hostMismatch', () => {
  it.each([undefined, 'ghes.example.com', '(invalid)'])('github.com site takes a delivery from %s', (sent) => {
    expect(hostMismatch(sent, GITHUB_COM)).toBeNull();
  });

  it('GHES site takes its own host and parks the rest', () => {
    expect(hostMismatch('ghes.example.com', GHES)).toBeNull();
    expect(hostMismatch(undefined, GHES)).toBe(
      'host_mismatch: X-GitHub-Enterprise-Host=(none); GITHUB_ENTERPRISE_URL names ghes.example.com',
    );
    expect(hostMismatch('other.example.com', GHES)).toBe(
      'host_mismatch: X-GitHub-Enterprise-Host=other.example.com; GITHUB_ENTERPRISE_URL names ghes.example.com',
    );
  });
});

describe('mismatchSender', () => {
  it.each([undefined, 'other.example.com', '(invalid)'])('round-trips %s', (sent) => {
    const error = hostMismatch(sent, GHES)!;
    expect(mismatchSender(error)).toEqual({ sent });
    expect(mismatchSender(`${error}; [redacted 1 secret]`)).toEqual({ sent });
  });

  it('returns null for any other error text', () => {
    expect(mismatchSender('unroutable: installation_id=99')).toBeNull();
  });
});

describe('fromSite', () => {
  it.each([
    [undefined, 'github.com', true],
    [undefined, 'ghes.example.com', false],
    [undefined, undefined, false],
    ['ghes.example.com', 'github.com', false],
  ])('github.com site: sent %s, payload %s is %s', (sent, payloadSays, expected) => {
    expect(fromSite(GITHUB_COM, sent, payloadSays)).toBe(expected);
  });

  it.each([
    ['ghes.example.com', 'ghes.example.com', true],
    [undefined, 'ghes.example.com', false],
    ['ghes.example.com', 'github.com', false],
    ['ghes.example.com', undefined, false],
    ['other.example.com', 'other.example.com', false],
  ])('GHES site: sent %s, payload %s is %s', (sent, payloadSays, expected) => {
    expect(fromSite(GHES, sent, payloadSays)).toBe(expected);
  });
});

describe('payloadFromSite', () => {
  it.each([
    [undefined, 'github.com', true],
    [undefined, 'ghes.example.com', false],
    [undefined, undefined, false],
    ['ghes.example.com', 'ghes.example.com', true],
    ['ghes.example.com', 'github.com', false],
    ['ghes.example.com', undefined, false],
  ])('host %s, payload %s is %s', (host, payloadSays, expected) => {
    expect(payloadFromSite(host, payloadSays)).toBe(expected);
  });
});
