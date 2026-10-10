#!/usr/bin/env node
// Toy checker that passes in the run and crashes at the regrade: Z0_TOGGLE=regrade exits 7, anything else 0.
process.exit(process.env.Z0_TOGGLE === 'regrade' ? 7 : 0);
