import { describe, expect, it } from 'vitest';
import {
  GITHUB_COM,
  headerHost,
  hostMismatch,
  mismatchSender,
  parseGitHubEnterpriseUrl,
} from '../../src/surface/connectors/github/site.js';

const GHES = parseGitHubEnterpriseUrl('https://ghes.example.com');

describe('parseGitHubEnterpriseUrl', () => {
  it('reads unset as github.com', () => {
    expect(parseGitHubEnterpriseUrl(undefined)).toBe(GITHUB_COM);
    expect(GITHUB_COM).toEqual({ host: undefined, apiBase: 'https://api.github.com' });
  });

  it.each(['https://ghes.example.com', 'https://ghes.example.com/'])('accepts %s', (raw) => {
    expect(parseGitHubEnterpriseUrl(raw)).toEqual({
      host: 'ghes.example.com',
      apiBase: 'https://ghes.example.com/api/v3',
    });
  });

  it('lower-cases the host and keeps the port in the API base only', () => {
    expect(parseGitHubEnterpriseUrl('https://GHES.Example.com:8443')).toEqual({
      host: 'ghes.example.com',
      apiBase: 'https://ghes.example.com:8443/api/v3',
    });
  });

  it('allows http on a loopback address', () => {
    expect(parseGitHubEnterpriseUrl('http://127.0.0.1:8080')).toEqual({
      host: '127.0.0.1',
      apiBase: 'http://127.0.0.1:8080/api/v3',
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
  ])('refuses %s', (raw) => {
    expect(() => parseGitHubEnterpriseUrl(raw)).toThrow(/GITHUB_ENTERPRISE_URL/);
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
  it.each([undefined, 'ghes.example.com', '(invalid)'])(
    'github.com site takes a delivery from %s',
    (sent) => {
      expect(hostMismatch(sent, GITHUB_COM)).toBeNull();
    },
  );

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
