/**
 * Vitest config for the hippo-brain-observatory SPA.
 *
 * Component tests use jsdom; engine tests that need WebGL stay in the
 * Node backend test suite (root vitest.config.ts).
 *
 * Bootstrapped in E0 per docs/plans/2026-05-24-ui-hybrid-v4-revamp.md.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/types.ts'],
    },
  },
});
