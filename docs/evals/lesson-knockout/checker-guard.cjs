const fs = require('node:fs');
const log = process.env.CHECK_LOG;
if (log) {
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name], write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      fs.appendFileSync(log, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      return write(chunk, ...rest);
    };
  }
}
const crash = error => {
  process.stderr.write('checker crashed: ' + (error?.stack ?? String(error)) + '\n');
  process.exit(2);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
