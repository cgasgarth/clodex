import fs from 'node:fs';
import { join } from 'node:path';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJson<T>(path: string, value: T): void {
  fs.writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const nativeHome = requiredEnv('REGISTRY_LOCK_WORKER_NATIVE_HOME');
process.env.CLODEX_CREDENTIAL_HOME = nativeHome;

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for signal: ${path}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function waitForFileSync(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for signal: ${path}`);
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

const role = requiredEnv('REGISTRY_LOCK_WORKER_ROLE');
const root = process.env.REGISTRY_LOCK_WORKER_ROOT ?? requiredEnv('CLODEX_HOME');
const registryPath = join(requiredEnv('CLODEX_HOME'), 'providers.json');
const lockPath = `${registryPath}.lock`;

async function runHolder(): Promise<void> {
  const { withRegistryWriteLock } = await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  const readyPath = join(root, 'holder-ready.json');
  const releasePath = join(root, 'release-holder');
  const resultPath = join(root, 'holder-result.json');

  try {
    await withRegistryWriteLock(
      async () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'holder-initial' }, registryPath);
        // SAFETY: The test fixture defines the asserted runtime shape.
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          pid: number;
          token: string;
        };
        writeJson(readyPath, { pid: owner.pid, token: owner.token });
        await waitForFile(releasePath, 10_000);
        saveRegistry({ ...emptyRegistry(), importedAt: 'holder-final' }, registryPath);
      },
      { lockPath, waitMs: 2_000, retryMs: 10 },
    );
    writeJson(resultPath, { ok: true });
  } catch (error) {
    writeJson(resultPath, { ok: false, error: errorMessage(error) });
    throw error;
  }
}

async function runContender(): Promise<void> {
  const { withRegistryWriteLock } = await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  const resultPath = join(root, 'contender-result.json');

  try {
    await withRegistryWriteLock(
      () => {
        saveRegistry({ ...emptyRegistry(), importedAt: 'contender' }, registryPath);
      },
      { lockPath, waitMs: 250, retryMs: 10 },
    );
    writeJson(resultPath, { acquired: true });
  } catch (error) {
    writeJson(resultPath, {
      acquired: false,
      error: errorMessage(error),
    });
  }
}

async function runLeaseLoss(): Promise<void> {
  const resultPath = join(root, 'lease-loss-result.json');
  let replacementPublished = false;

  const { withRegistryWriteLockSync } =
    await import('../../src/registry/lock.js');
  const { emptyRegistry, saveRegistry } =
    await import('../../src/registry/io.js');
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({ ...emptyRegistry(), importedAt: 'sentinel' })}\n`,
    {
      mode: 0o600,
    },
  );

  let error: unknown;
  try {
    withRegistryWriteLockSync(
      () => {
        saveRegistry(
          { ...emptyRegistry(), importedAt: 'unwanted' },
          registryPath,
          {
            afterTempWrite: () => {
              // SAFETY: The test fixture defines the asserted runtime shape.
              const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
                pid: number;
                startedAt: number;
                token: string;
              };
              fs.unlinkSync(lockPath);
              writeJson(lockPath, {
                ...owner,
                token: 'replacement-owner',
              });
              replacementPublished = true;
            },
          },
        );
      },
      { lockPath },
    );
  } catch (caught) {
    error = caught;
  }

  // SAFETY: The test fixture defines the asserted runtime shape.
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    importedAt?: string;
  };
  // SAFETY: The test fixture defines the asserted runtime shape.
  const replacement = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    token?: string;
  };
  const temporaryArtifacts = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
  writeJson(resultPath, {
    errorName: error instanceof Error ? error.name : null,
    error: errorMessage(error),
    importedAt: registry.importedAt,
    replacementPublished,
    replacementToken: replacement.token,
    temporaryArtifacts,
  });
  fs.unlinkSync(lockPath);
}

async function runAtomicAcquire(): Promise<void> {
  const readyPath = join(root, 'atomic-acquire-ready.json');
  const releasePath = join(root, 'release-atomic-acquire');
  const resultPath = join(root, 'atomic-acquire-result.json');
  const { tryAcquireRegistryLock } = await import('../../src/registry/lock.js');
  const lease = tryAcquireRegistryLock(lockPath, {
    onLockTempCreated: candidatePath => {
      writeJson(readyPath, { candidatePath, pid: process.pid });
      waitForFileSync(releasePath, 5_000);
    },
  });
  if (!lease) throw new Error('Atomic acquisition worker did not get the lock');
  // SAFETY: The test fixture defines the asserted runtime shape.
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    pid: number;
    token: string;
  };
  lease.release();
  writeJson(resultPath, {
    acquired: true,
    ownerPid: owner.pid,
    ownerToken: owner.token,
  });
}

function credentialAuthRef(): string {
  return requiredEnv('REGISTRY_LOCK_CREDENTIAL_REF');
}

async function runCredentialHolder(): Promise<void> {
  const {
    getCredentialMutationLockPath,
    getCredentialStateRoot,
    withCredentialMutationLock,
  } = await import('../../src/registry/lock.js');
  const authRef = credentialAuthRef();
  const readyPath = join(root, 'credential-holder-ready.json');
  const releasePath = join(root, 'release-credential-holder');
  const resultPath = join(root, 'credential-holder-result.json');

  await withCredentialMutationLock(authRef, async () => {
    writeJson(readyPath, {
      pid: process.pid,
      lockPath: getCredentialMutationLockPath(authRef),
      stateRoot: getCredentialStateRoot(),
    });
    await waitForFile(releasePath, 5_000);
  });
  writeJson(resultPath, { ok: true });
}

async function runCredentialContender(): Promise<void> {
  const {
    getCredentialMutationLockPath,
    getCredentialStateRoot,
    withCredentialMutationLock,
  } = await import('../../src/registry/lock.js');
  const authRef = credentialAuthRef();
  const readyPath = join(root, 'credential-contender-ready.json');
  const enteredPath = join(root, 'credential-contender-entered.json');
  const resultPath = join(root, 'credential-contender-result.json');

  writeJson(readyPath, {
    pid: process.pid,
    lockPath: getCredentialMutationLockPath(authRef),
    stateRoot: getCredentialStateRoot(),
  });
  await withCredentialMutationLock(authRef, () => {
    writeJson(enteredPath, { pid: process.pid });
  });
  writeJson(resultPath, { ok: true });
}

switch (role) {
  case 'holder':
    await runHolder();
    break;
  case 'contender':
    await runContender();
    break;
  case 'lease-loss':
    await runLeaseLoss();
    break;
  case 'atomic-acquire':
    await runAtomicAcquire();
    break;
  case 'credential-holder':
    await runCredentialHolder();
    break;
  case 'credential-contender':
    await runCredentialContender();
    break;
  default:
    throw new Error(`Unsupported registry lock worker role: ${role}`);
}
