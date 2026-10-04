// jsdom setup: jest-dom matchers plus stubs for the canvas 2d context and ResizeObserver it lacks.
import '@testing-library/jest-dom/vitest';

type Stub = (...args: number[]) => undefined;

function noopContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const overrides = new Map<PropertyKey, unknown>([
    ['canvas', canvas],
    ['measureText', (s: string) => ({ width: s.length * 6 })],
    ['createLinearGradient', () => gradient],
    ['createPattern', () => ({ setTransform() {} })],
    ['createImageData', (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })],
  ]);
  const store = new Map<PropertyKey, unknown>();
  const noop: Stub = () => undefined;
  const proxy = new Proxy(
    {},
    {
      get: (_target, key) => (overrides.has(key) ? overrides.get(key) : store.has(key) ? store.get(key) : noop),
      set: (_target, key, value) => {
        store.set(key, value);
        return true;
      },
    },
  );
  // SAFETY: the Proxy answers every 2d-context member the code under test touches.
  return proxy as CanvasRenderingContext2D;
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: function getContext(this: HTMLCanvasElement) {
    return noopContext(this);
  },
});

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
