// Apart from spawn-hippo so a test that only needs the bin path (runCliAs sets argv from it) does not read as starting a process.
import { resolve } from 'node:path';

export const HIPPO_BIN = resolve(__dirname, '..', '..', 'bin', 'hippo.js');
