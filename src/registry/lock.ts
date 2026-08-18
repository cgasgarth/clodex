import { isNumber, isObject, isString } from '../runtime/type-guards.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { getProvidersPath } from '../config/paths.js';

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_CREDENTIAL_MUTATION_WAIT_MS = 150_000;
const DEFAULT_RETRY_MS = 25;

interface RegistryRuntimeError {
  value: unknown;
}

interface RegistryLockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

interface RegistryLockSnapshot {
  raw: string;
  device: number;
  inode: number;
  modifiedAt: number;
}

interface RegistryLockOptions {
  lockPath?: string;
  waitMs?: number;
  retryMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  onLockTempCreated?: (path: string) => void;
}

interface RegistryLockContext {
  leases: ReadonlyMap<string, RegistryLockLease>;
}

export interface RegistryLockLease {
  active: boolean;
  readonly lockPath: string;
  readonly token: string;
  readonly device: number;
  readonly inode: number;
  assertOwned: () => void;
  release: () => void;
}

const registryLockContext = new AsyncLocalStorage<RegistryLockContext>();

export class RegistryLockLostError extends Error {
  constructor(lockPath: string) {
    super(`Provider registry lock ownership was lost before write: ${lockPath}`);
    this.name = 'RegistryLockLostError';
  }
}

function getRegistryLockPath(): string {
  return `${getProvidersPath()}.lock`;
}

function systemErrorCode(error: RegistryRuntimeError['value']): string | undefined {
  return isObject(error) && 'code' in error && isString(error.code) ? error.code : undefined;
}

function removeLockTemporaryFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (systemErrorCode(error) !== 'ENOENT') throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return systemErrorCode(err) === 'EPERM';
  }
}

function parseLockOwner(raw: string): RegistryLockOwner | null {
  try {
    const parsed: Partial<RegistryLockOwner> = JSON.parse(raw);
    if (!isNumber(parsed.pid) || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (
      !isNumber(parsed.startedAt) ||
      !Number.isFinite(parsed.startedAt)
    )
      return null;
    if (!isString(parsed.token) || parsed.token.length === 0)
      return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

function createLockRecord(
  lockPath: string,
  owner: RegistryLockOwner,
  onTempCreated?: (path: string) => void,
): RegistryLockSnapshot | null {
  const raw = JSON.stringify(owner);
  const tempPath = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    onTempCreated?.(tempPath);
    writeFileSync(fd, raw);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    try {
      linkSync(tempPath, lockPath);
    } catch (err) {
      if (systemErrorCode(err) === 'EEXIST') return null;
      throw err;
    }
    return {
      raw,
      device: stats.dev,
      inode: stats.ino,
      modifiedAt: stats.mtimeMs,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeLockTemporaryFile(tempPath);
  }
}

function lockFileMatchesLease(lease: RegistryLockLease): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lease.lockPath, 'r');
    const openedStats = fstatSync(fd);
    const owner = parseLockOwner(readFileSync(fd, 'utf8'));
    const pathStats = statSync(lease.lockPath);
    return (
      owner?.token === lease.token &&
      openedStats.dev === lease.device &&
      openedStats.ino === lease.inode &&
      pathStats.dev === lease.device &&
      pathStats.ino === lease.inode
    );
  } catch (err) {
    if (systemErrorCode(err) === 'ENOENT') return false;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createLease(
  lockPath: string,
  owner: RegistryLockOwner,
  snapshot: RegistryLockSnapshot,
): RegistryLockLease {
  const lease: RegistryLockLease = {
    active: true,
    lockPath,
    token: owner.token,
    device: snapshot.device,
    inode: snapshot.inode,
    assertOwned: () => {
      if (!lease.active || !lockFileMatchesLease(lease)) {
        lease.active = false;
        throw new RegistryLockLostError(lockPath);
      }
    },
    release: () => {
      if (!lease.active) return;
      lease.active = false;
      if (lockFileMatchesLease(lease)) unlinkSync(lockPath);
    },
  };
  return lease;
}

export function assertRegistryWriteOwnership(
  registryPath = getProvidersPath(),
): void {
  const lockPath = `${registryPath}.lock`;
  const lease = registryLockContext.getStore()?.leases.get(lockPath);
  if (!lease) throw new RegistryLockLostError(lockPath);
  lease.assertOwned();
}

function getStaleLockSnapshot(
  lockPath: string,
  alive: (pid: number) => boolean,
): RegistryLockSnapshot | null {
  const raw = readFileSync(lockPath, 'utf8');
  const stats = statSync(lockPath);
  const snapshot: RegistryLockSnapshot = {
    raw,
    device: stats.dev,
    inode: stats.ino,
    modifiedAt: stats.mtimeMs,
  };
  const owner = parseLockOwner(raw);
  if (owner) return alive(owner.pid) ? null : snapshot;
  return snapshot;
}

function removeStaleLock(
  lockPath: string,
  expected?: RegistryLockSnapshot,
): boolean {
  try {
    if (expected) {
      const raw = readFileSync(lockPath, 'utf8');
      const stats = statSync(lockPath);
      if (
        raw !== expected.raw ||
        stats.dev !== expected.device ||
        stats.ino !== expected.inode ||
        stats.mtimeMs !== expected.modifiedAt
      )
        return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (systemErrorCode(err) !== 'ENOENT') throw err;
    return false;
  }
}

function tryAcquireReaperGuard(
  lockPath: string,
  now: number,
  alive: (pid: number) => boolean,
): RegistryLockLease | null {
  const guardPath = `${lockPath}.reap`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: RegistryLockOwner = {
      pid: process.pid,
      startedAt: now,
      token: randomUUID(),
    };
    try {
      const snapshot = createLockRecord(guardPath, owner);
      if (snapshot) return createLease(guardPath, owner, snapshot);
    } catch (err) {
      if (systemErrorCode(err) === 'ENOENT') continue;
      throw err;
    }

    let stale: RegistryLockSnapshot | null = null;
    try {
      stale = getStaleLockSnapshot(guardPath, alive);
    } catch (readErr) {
      if (systemErrorCode(readErr) === 'ENOENT') continue;
      throw readErr;
    }
    if (!stale) return null;
    if (!removeStaleLock(guardPath, stale)) continue;
  }
  return null;
}

export function tryAcquireRegistryLock(
  lockPath = getRegistryLockPath(),
  options: Pick<RegistryLockOptions, 'now' | 'isAlive' | 'onLockTempCreated'> = {},
): RegistryLockLease | null {
  const now = options.now?.() ?? Date.now();
  const alive = options.isAlive ?? isPidAlive;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: RegistryLockOwner = {
      pid: process.pid,
      startedAt: now,
      token: randomUUID(),
    };
    try {
      const snapshot = createLockRecord(lockPath, owner, options.onLockTempCreated);
      if (snapshot) return createLease(lockPath, owner, snapshot);
    } catch (err) {
      if (systemErrorCode(err) === 'ENOENT') continue;
      throw err;
    }

    let stale: RegistryLockSnapshot | null = null;
    try {
      stale = getStaleLockSnapshot(lockPath, alive);
    } catch (readErr) {
      if (systemErrorCode(readErr) === 'ENOENT') continue;
      throw readErr;
    }
    if (!stale) return null;
    const reaperLease = tryAcquireReaperGuard(lockPath, now, alive);
    if (!reaperLease) return null;
    try {
      let currentStale: RegistryLockSnapshot | null = null;
      try {
        currentStale = getStaleLockSnapshot(lockPath, alive);
      } catch (readErr) {
        if (systemErrorCode(readErr) === 'ENOENT') continue;
        throw readErr;
      }
      if (!currentStale) return null;
      if (!removeStaleLock(lockPath, currentStale)) continue;
    } finally {
      reaperLease.release();
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockTimeoutError(
  lockPath: string,
  waitMs: number,
  alive: (pid: number) => boolean,
): Error {
  let owner: RegistryLockOwner | null = null;
  try {
    owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (systemErrorCode(err) !== 'ENOENT') throw err;
  }
  if (owner && alive(owner.pid)) {
    return new Error(
      `Timed out after ${waitMs}ms waiting for lock held by clodex process ` +
        `(pid ${owner.pid}): ${lockPath}`,
    );
  }
  return new Error(
    `Timed out after ${waitMs}ms waiting for lock: ${lockPath}`,
  );
}

export async function withRegistryWriteLock<T>(
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inheritedLeases = registryLockContext.getStore()?.leases;
  if (inheritedLeases?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease: RegistryLockLease | null = null;

  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, {
      now,
      isAlive: options.isAlive,
    });
    if (lease) break;
    if (now() >= deadline)
      throw lockTimeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive);
    await sleep(retryMs);
  }

  const leases = new Map(inheritedLeases);
  leases.set(lockPath, lease);
  const context: RegistryLockContext = { leases };
  return registryLockContext.run(context, async () => {
    try {
      return await operation();
    } finally {
      lease.release();
    }
  });
}

export function withRegistryWriteLockSync<T>(
  operation: () => T,
  options: RegistryLockOptions = {},
): T {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inheritedLeases = registryLockContext.getStore()?.leases;
  if (inheritedLeases?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease: RegistryLockLease | null = null;

  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, {
      now,
      isAlive: options.isAlive,
    });
    if (lease) break;
    if (now() >= deadline)
      throw lockTimeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive);
    sleepSync(retryMs);
  }

  const leases = new Map(inheritedLeases);
  leases.set(lockPath, lease);
  const context: RegistryLockContext = { leases };
  return registryLockContext.run(context, () => {
    try {
      return operation();
    } finally {
      lease.release();
    }
  });
}

export function getCredentialMutationLockPath(authRef: string): string {
  const digest = createHash('sha256')
    .update('clodex-credential-mutation\0')
    .update(authRef)
    .digest('hex');
  return join(getCredentialLockRoot(), `${digest}.lock`);
}

function getNativeCredentialRoot(): string {
  const nativeHome = process.env['CLODEX_CREDENTIAL_HOME']?.trim()
    || userInfo().homedir;
  if (!nativeHome || !isAbsolute(nativeHome)) {
    throw new Error('Could not determine the native user home for credential coordination');
  }
  return join(nativeHome, '.clodex');
}

export function getCredentialLockRoot(): string {
  return join(getNativeCredentialRoot(), 'credential-locks');
}

export function getCredentialStateRoot(): string {
  return join(getNativeCredentialRoot(), 'keyring-state');
}

export function withCredentialMutationLock<T>(
  authRef: string,
  operation: () => Promise<T> | T,
  options: Pick<RegistryLockOptions, 'waitMs' | 'retryMs'> = {},
): Promise<T> {
  return withRegistryWriteLock(operation, {
    ...options,
    lockPath: getCredentialMutationLockPath(authRef),
    waitMs: options.waitMs ?? DEFAULT_CREDENTIAL_MUTATION_WAIT_MS,
  });
}

function getProviderMutationLockPath(providerSlot: string): string {
  const digest = createHash('sha256')
    .update('clodex-provider-mutation\0')
    .update(providerSlot)
    .digest('hex');
  return `${getProvidersPath()}.provider-${digest}.lock`;
}

export function withProviderMutationLock<T>(
  providerSlot: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withRegistryWriteLock(operation, {
    lockPath: getProviderMutationLockPath(providerSlot),
  });
}
