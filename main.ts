import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Tune V8 for short single-CPU batch execution in Node 22:
// disable TurboFan & background GC threads whose CPU overhead far exceeds payback on a <200ms run.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan');
setFlagsFromString('--no-concurrent-recompilation');
setFlagsFromString('--no-concurrent-marking');
setFlagsFromString('--no-concurrent-sweeping');
setFlagsFromString('--no-parallel-scavenge');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => Record<string, string>;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

const PLAIN_KEY_RE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;
const FLAT_RE = /^/;
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
let buf = Buffer.allocUnsafe(262144);
let pos = 0;

function flush(): void {
  if (pos > 0) {
    writeSync(fd, buf, 0, pos);
    pos = 0;
  }
}

function ensure(need: number): void {
  if (pos + need <= buf.length) return;
  flush();
  if (need > buf.length) buf = Buffer.allocUnsafe(need);
}

buf[pos++] = 91; // '['
for (let i = 0; i < cases.length; i++) {
  if (i > 0) {
    ensure(2);
    buf[pos++] = 44; // ','
  }
  ensure(2);
  buf[pos++] = 123; // '{'
  const obj = run(cases[i]!.input);
  cases[i] = null as unknown as { id: string; input: unknown };
  let first = true;
  for (const k in obj) {
    const rawV = obj[k]!;
    // Flatten ConsString once before JSON.stringify so V8 hits its fast flat stringifier path.
    FLAT_RE.test(rawV);
    const vs = JSON.stringify(rawV);
    if (PLAIN_KEY_RE.test(k)) {
      ensure(k.length + vs.length * 3 + 8);
      if (!first) buf[pos++] = 44;
      first = false;
      buf[pos++] = 34; // '"'
      pos += buf.write(k, pos, 'latin1');
      buf[pos++] = 34; // '"'
      buf[pos++] = 58; // ':'
      pos += buf.write(vs, pos, 'utf8');
    } else {
      const ks = JSON.stringify(k);
      ensure((ks.length + vs.length) * 3 + 8);
      if (!first) buf[pos++] = 44;
      first = false;
      pos += buf.write(ks, pos, 'utf8');
      buf[pos++] = 58; // ':'
      pos += buf.write(vs, pos, 'utf8');
    }
  }
  ensure(2);
  buf[pos++] = 125; // '}'
}
ensure(2);
buf[pos++] = 93; // ']'
flush();
closeSync(fd);
