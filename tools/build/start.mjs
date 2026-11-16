import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root, artifactRoot, cacheEnvironment } from './paths.mjs';
import { requireDesktopSession } from './launch-environment.mjs';
import { advancedDevelopmentExecutable } from './development-runtime.mjs';

requireDesktopSession();
const option = process.argv[2] ?? '--teaching';
if (process.argv.length > 3 || !['--teaching', '--advanced'].includes(option))
  throw new Error('Expected --teaching or --advanced');
const host = option === '--advanced' ? 'advanced' : 'teaching';
const require = createRequire(import.meta.url);
Object.assign(process.env, cacheEnvironment);
const env = {
  ...cacheEnvironment,
  HYD_USER_DATA_DIR: path.join(artifactRoot, 'development-profile'),
  HYD_SPIKE_DIR: path.join(artifactRoot, 'samples'),
};
delete env.ELECTRON_RUN_AS_NODE;
console.log(`正在启动${host === 'teaching' ? '液压教学展示' : 'Deatalos'}…`);
// The development launcher always exposes a loopback-only CDP endpoint so
// Gate-T0 can attach to the real Electron page in the user's desktop session.
const remoteDebugPort = process.env.HYD_REMOTE_DEBUG_PORT ?? (host === 'teaching' ? '9222' : '9223');
const electronArgs = [
  '--enable-logging=stderr',
  ...(remoteDebugPort ? [`--remote-debugging-port=${remoteDebugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
  path.join(root, 'apps/desktop/dist', host === 'teaching' ? 'main.cjs' : 'advanced.cjs'),
];
if (remoteDebugPort) console.log(`本机调试通道已启用：http://127.0.0.1:${remoteDebugPort}`);
const executable = host === 'advanced' ? await advancedDevelopmentExecutable() : require('electron');
const child = spawn(executable, electronArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('spawn', () => console.log(`Electron 已启动，PID=${child.pid ?? 'unknown'}；窗口应在桌面显示。`));
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  console.log(
    `Electron 已退出，code=${code ?? 'null'} signal=${signal ?? 'none'}。若窗口未出现，请先关闭旧实例后重试。`,
  );
  process.exitCode = code ?? 1;
});
