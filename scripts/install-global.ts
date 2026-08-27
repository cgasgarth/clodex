import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isObject, isString } from '../src/runtime/type-guards.ts';

const RUNTIME_ARTIFACTS = [
  'cli.js',
  'claude-wrapper.js',
  'worker.js',
  'secondwind-worker.js',
];
const PACKAGE_NAME = '@cgasgarth/clodex';

interface GlobalManifest {
  dependencies?: unknown;
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited ${exitCode}`);
}

async function verifyArtifacts(repoRoot: string, installedRoot: string): Promise<void> {
  for (const artifact of RUNTIME_ARTIFACTS) {
    const [built, installed] = await Promise.all([
      readFile(join(repoRoot, 'dist', artifact)),
      readFile(join(installedRoot, 'dist', artifact)),
    ]);
    if (!built.equals(installed)) {
      throw new Error(`installed ${artifact} does not match the current checkout`);
    }
  }
}

async function setGlobalPackageArchive(globalRoot: string, archive: string): Promise<void> {
  const manifestPath = join(globalRoot, 'package.json');
  if (!(await Bun.file(manifestPath).exists())) return;

  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error('global Bun package manifest must be an object');
  }
  const manifest: GlobalManifest = Object.assign({}, parsed);
  const dependencies = manifest.dependencies;
  if (
    dependencies !== undefined
    && (!isObject(dependencies)
      || Array.isArray(dependencies)
      || Object.values(dependencies).some(value => !isString(value)))
  ) {
    throw new Error('global Bun package manifest dependencies must contain strings');
  }
  manifest.dependencies = {
    ...dependencies,
    [PACKAGE_NAME]: archive,
  };
  const nextManifest = `${manifestPath}.${process.pid}.next`;
  await writeFile(nextManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(nextManifest, manifestPath);
}

export async function installGlobalCheckout(
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  bunInstall = process.env['BUN_INSTALL'] ?? join(homedir(), '.bun'),
): Promise<void> {
  const packDirectory = await mkdtemp(join(tmpdir(), 'clodex-install-'));
  const globalRoot = join(bunInstall, 'install', 'global');
  const packageDirectory = join(
    process.env['CLODEX_HOME'] ?? join(homedir(), '.clodex'),
    'packages',
  );
  try {
    await run([process.execPath, 'run', 'build'], repoRoot);
    await run([process.execPath, 'pm', 'pack', '--destination', packDirectory], repoRoot);
    const archives = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'));
    if (archives.length !== 1) {
      throw new Error(`expected one packed archive, found ${archives.length}`);
    }

    await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
    const archive = archives[0];
    if (!archive) throw new Error('bun pm pack did not produce an archive');
    const packedArchive = join(packDirectory, archive);
    const digest = createHash('sha256')
      .update(await readFile(packedArchive))
      .digest('hex');
    const installedArchive = join(packageDirectory, `clodex-local-${digest}.tgz`);
    const nextArchive = `${installedArchive}.${process.pid}.next`;
    await copyFile(packedArchive, nextArchive);
    await rename(nextArchive, installedArchive);
    await setGlobalPackageArchive(globalRoot, installedArchive);
    await run([
      process.execPath,
      'add',
      '--global',
      installedArchive,
    ], repoRoot);
    await verifyArtifacts(repoRoot, join(globalRoot, 'node_modules', '@cgasgarth', 'clodex'));
    console.log('Installed the current Clodex checkout globally and verified runtime artifacts.');
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await installGlobalCheckout();
}
