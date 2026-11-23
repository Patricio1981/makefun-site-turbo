import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// Tune V8 for short single-CPU batch execution in Node 22:
// disable TurboFan, Maglev & background GC threads whose CPU overhead exceeds payback on a <200ms run.
setFlagsFromString(
  '--no-incremental-marking --no-turbofan --no-maglev --no-concurrent-recompilation --no-concurrent-marking --no-concurrent-sweeping --no-parallel-scavenge'
);

const { runBatchToFd } = (await import('./solve.js')) as {
  runBatchToFd: (cases: { id: string; input: unknown }[], fd: number, writeSyncFn: typeof writeSync, reuseBuf?: Buffer) => void;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inFd = openSync(INPUT_DIR + '/cases.json', 'r');
const inSize = fstatSync(inFd).size;
const inBuf = Buffer.allocUnsafe(inSize);
let inOff = 0;
while (inOff < inSize) inOff += readSync(inFd, inBuf, inOff, inSize - inOff, null);
closeSync(inFd);
const cases = JSON.parse(inBuf.toString('utf8')) as { id: string; input: unknown }[];
const fd = openSync(OUTPUT_DIR + '/answers.json', 'w');
runBatchToFd(cases, fd, writeSync, inBuf);
closeSync(fd);
