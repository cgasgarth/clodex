import { cpus } from 'node:os';

const testTimeoutMs = Number(process.env.CLODEX_TEST_TIMEOUT_MS ?? 30_000);
const processTimeoutMs = Number(process.env.CLODEX_TEST_PROCESS_TIMEOUT_MS ?? 120_000);
const concurrency = Math.max(
  1,
  Number(process.env.CLODEX_TEST_CONCURRENCY ?? Math.min(8, cpus().length)),
);
const filters = Bun.argv.slice(2);
const glob = new Bun.Glob('**/*.test.ts');
const files = [...glob.scanSync({ cwd: 'tests', onlyFiles: true })]
  .map(file => `tests/${file}`)
  .filter(file => filters.length === 0 || filters.some(filter => file.includes(filter)))
  .sort();

if (files.length === 0) {
  console.error('No matching test files.');
  process.exit(1);
}

interface TestResult {
  file: string;
  code: number;
  output: string;
  timedOut: boolean;
}

async function runFile(file: string): Promise<TestResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'test',
      file,
      `--timeout=${testTimeoutMs}`,
      '--only-failures',
      '--no-orphans',
    ],
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, processTimeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return {
    file,
    code,
    output: `${stdout}${stderr}`.trim(),
    timedOut,
  };
}

const results: TestResult[] = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
  while (cursor < files.length) {
    const file = files[cursor++];
    const result = await runFile(file);
    results.push(result);
    if (result.code !== 0 || result.timedOut) {
      console.error(`\nFAIL ${file}${result.timedOut ? ' (process timeout)' : ''}\n${result.output}\n`);
    } else {
      const summary = result.output.match(/\d+ pass[\s\S]*?Ran \d+ tests? across 1 file\. \[[^\]]+\]/)?.[0]
        ?.replace(/\n/g, ' · ');
      console.log(`PASS ${file}${summary ? ` · ${summary}` : ''}`);
    }
  }
}));

const failures = results.filter(result => result.code !== 0 || result.timedOut);
console.log(`\n${files.length - failures.length}/${files.length} test files passed.`);
if (failures.length > 0) process.exit(1);
