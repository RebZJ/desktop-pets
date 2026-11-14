import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// A developer shell must not accidentally carry an old synthetic test profile.
for (const key of ['PACE_E2E_DATA_DIR', 'PACE_E2E_PORT', 'PACE_E2E_TOKEN']) delete env[key];
const support = platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : platform() === 'win32' ? env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const installedModels = join(support, 'Desktop Pets', 'models');
if (!env.PACE_MODELS_DIR && existsSync(installedModels) && statSync(installedModels).isDirectory()) {
  env.PACE_MODELS_DIR = installedModels;
}
const config = join(root, 'src-tauri', 'tauri.dev.conf.json');
const details = { app: 'Desktop Pets Dev', identifier: 'app.desktoppets.pace.dev',
  profile: join(support, 'Desktop Pets Dev'),
  models: env.PACE_MODELS_DIR || join(support, 'Desktop Pets Dev', 'models'),
  globalShortcuts: env.PACE_DEV_SHORTCUTS === '1', config };
if (process.argv.includes('--check')) {
  process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
} else {
  process.stdout.write(`Desktop Pets DEV — isolated profile: ${details.profile}\nModels: ${details.models}\n`);
  process.stdout.write(details.globalShortcuts
    ? 'DEV hotkeys enabled explicitly. Quit the installed app before testing shared bindings.\n'
    : 'DEV hotkeys are off; the installed app keeps its shortcuts. Use the window controls.\n');
  const child = spawn(process.execPath, [join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'),
    'dev', '--config', config, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
