/**
 * Runtime tests for the isLoopback helper exported from src/server.ts.
 *
 * The /v1/sleep route uses isLoopback() as a per-request guard. The 403
 * negative path is hard to simulate in HTTP integration tests (vitest's
 * serve(port:0) always binds 127.0.0.1, so req.socket.remoteAddress is always
 * a loopback string). This file unit-tests isLoopback directly so the 403
 * branch is exercised at the unit level.
 *
 * Test cases match the actual helper behaviour at server.ts:240-246:
 *   accepts: '127.0.0.1', '::1', '::ffff:127.0.0.1'
 *   rejects: everything else, including the fully-expanded IPv6 form
 *            '0:0:0:0:0:0:0:1' (Node.js normalises this to '::1' but the
 *            helper does not perform normalisation itself)
 *
 * Extending isLoopback to recognise additional IPv6 forms is a
 * security-adjacent decision NOT made in this release.
 */

import { describe, it, expect } from 'vitest';
import { isLoopback } from '../src/server.js';

describe('isLoopback', () => {
  describe('returns true for', () => {
    it("'127.0.0.1' (IPv4 loopback)", () => {
      expect(isLoopback('127.0.0.1')).toBe(true);
    });
    it("'::1' (IPv6 loopback short form)", () => {
      expect(isLoopback('::1')).toBe(true);
    });
    it("'::ffff:127.0.0.1' (IPv4-mapped IPv6 loopback)", () => {
      expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    });
  });

  describe('returns false for', () => {
    it("'192.168.1.1' (RFC1918 private IPv4)", () => {
      expect(isLoopback('192.168.1.1')).toBe(false);
    });
    it("'10.0.0.1' (RFC1918 private IPv4)", () => {
      expect(isLoopback('10.0.0.1')).toBe(false);
    });
    it("'8.8.8.8' (public IPv4)", () => {
      expect(isLoopback('8.8.8.8')).toBe(false);
    });
    it("'::ffff:192.168.1.1' (IPv4-mapped IPv6 non-loopback)", () => {
      expect(isLoopback('::ffff:192.168.1.1')).toBe(false);
    });
    it("'fe80::1' (IPv6 link-local non-loopback)", () => {
      expect(isLoopback('fe80::1')).toBe(false);
    });
    it("'0:0:0:0:0:0:0:1' (fully-expanded IPv6 loopback — NOT recognised; helper does not normalise)", () => {
      // This is the documented limitation. Node usually normalises to '::1'
      // before this helper sees it, but the helper itself does not perform
      // the normalisation. If a future deployment surface delivers the
      // expanded form (e.g. via a proxy header), the helper would reject.
      // Tracked in TODOS.md as a forward-defensive consideration.
      expect(isLoopback('0:0:0:0:0:0:0:1')).toBe(false);
    });
    it('undefined', () => {
      expect(isLoopback(undefined)).toBe(false);
    });
    it("'' (empty string)", () => {
      expect(isLoopback('')).toBe(false);
    });
  });
});
