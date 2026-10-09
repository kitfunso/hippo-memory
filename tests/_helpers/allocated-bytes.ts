// Measures how much JS heap a synchronous call allocates, so a test can pin how work grows with input without reading a clock.
import { GCProfiler, getHeapStatistics } from 'node:v8';

/** Bytes of JS heap `run` allocated: the heap's growth plus what each collection during the run freed. */
export function allocatedBytes(run: () => void): number {
  const profiler = new GCProfiler();
  profiler.start();
  const before = getHeapStatistics().used_heap_size;
  run();
  const after = getHeapStatistics().used_heap_size;
  const freed = profiler.stop().statistics.reduce((sum, gc) => sum + gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize, 0);
  return after - before + freed;
}
