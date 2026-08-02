import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@bman654/clodex';
const RUNTIME_ARTIFACTS = [
  'cli.js',
  'claude-wrapper.js',
  'worker.js',
  'secondwind-worker.js',
];

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

async function installedGlobally(globalManifestPath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(globalManifestPath, 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    return Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME);
  } catch {
    return false;
  }
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
  const stableArchive = join(packageDirectory, 'clodex-local.tgz');
  try {
    await run([process.execPath, 'run', 'build'], repoRoot);
    await run([process.execPath, 'pm', 'pack', '--destination', packDirectory], repoRoot);
    const archives = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'));
    if (archives.length !== 1) {
      throw new Error(`expected one packed archive, found ${archives.length}`);
    }

    // Bun 1.3 can report a dependency loop when replacing a global package
    // whose source is an older local tarball. Remove that manifest entry first;
    // the freshly packed archive is already durable before the short swap.
    if (await installedGlobally(join(globalRoot, 'package.json'))) {
      await run([process.execPath, 'remove', '--global', PACKAGE_NAME], repoRoot);
    }
    await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
    const nextArchive = `${stableArchive}.${process.pid}.next`;
    await copyFile(join(packDirectory, archives[0]!), nextArchive);
    await rename(nextArchive, stableArchive);
    await run([
      process.execPath,
      'add',
      '--global',
      stableArchive,
    ], repoRoot);
    await verifyArtifacts(repoRoot, join(globalRoot, 'node_modules', '@bman654', 'clodex'));
    console.log('Installed the current Clodex checkout globally and verified runtime artifacts.');
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await installGlobalCheckout();
}
