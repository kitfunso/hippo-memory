// The built CLI with a delivery recorder fault switched on: node delivery-fault-cli.mjs <observe|build|flush> <hippo args>
import { _setDeliveryFaultForTests } from '../../dist/delivery-recorder.js';
import { runCli } from '../../dist/cli.js';

_setDeliveryFaultForTests(process.argv[2]);
process.argv.splice(2, 1);
runCli();
