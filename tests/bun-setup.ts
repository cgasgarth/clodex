import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const sandboxRoot = mkdtempSync(join(tmpdir(), 'clodex-bun-sandbox-'));
const sandboxHome = join(sandboxRoot, 'clodex-home');

process.env.CLODEX_HOME = sandboxHome;
process.env.CLODEX_CREDENTIAL_HOME = sandboxRoot;
process.env.HOME = sandboxRoot;
process.env.CLODEX_CREDENTIAL_STORE = 'file';
process.env.CLODEX_TEST_REAL_HOME = userInfo().homedir;

process.once('exit', () => {
  delete process.env.CLODEX_TEST_REAL_HOME;
  rmSync(sandboxRoot, { recursive: true, force: true });
});
