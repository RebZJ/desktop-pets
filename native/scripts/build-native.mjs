import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const native = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = [process.env.PYTHON, 'python3', 'python'].filter(Boolean)
  .find(command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);
if (!python) throw new Error('Building the native runtimes requires Python 3. The packaged app does not.');
for (const directory of ['bin', 'lib', 'share', 'licenses']) mkdirSync(resolve(native, directory), { recursive: true });
const scripts = process.argv[2] === '--diarization' ? ['build-portable-speech.py'] : ['build-portable-speech.py', 'build-portable-moonshine.py', 'build-portable-llama.py'];
if (process.platform === 'darwin' && !process.argv[2]) scripts.push('build-platform-macos.py');
for (const script of scripts) {
  const result = spawnSync(python, [resolve(native, 'scripts', script)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform === 'darwin' && !process.argv[2]) {
  for (const legacy of ['MLXAudio_MLXAudioTTS.bundle', 'mlx-swift_Cmlx.bundle', 'swift-crypto_Crypto.bundle', 'swift-transformers_Hub.bundle']) {
    rmSync(resolve(native, 'bin', legacy), { recursive: true, force: true });
  }
}
