// The one queue that gives each embedding index one embed turn at a time.
import { SerialQueues } from '../../base/util/serial-queue.js';

// One turn at a time per index, keyed by the index (embeddingIndex.open or vectorWrites.indexKey),
// then the index's own lock, which other processes and threads honour.
export const embedTurns = new SerialQueues<string>();
