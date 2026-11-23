import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Tune V8 for short single-CPU batch execution in Node 22:
// disable TurboFan & background GC threads whose CPU overhead far exceeds payback on a <200ms run.
setFlagsFromString(
  '--no-incremental-marking --no-turbofan --no-maglev --no-concurrent-recompilation --no-concurrent-marking --no-concurrent-sweeping --no-parallel-scavenge'
);

const { runBatchToFd } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runBatchToFd: (cases: { id: string; input: unknown }[], fd: number, writeSyncFn: typeof writeSync) => void;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
runBatchToFd(cases, fd, writeSync);
closeSync(fd);
