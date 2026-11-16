import os from 'node:os';

// Electron checks a newly restricted Windows token before app code runs.
// Codex's tool account cannot pass that check with the workspace ACL; adding
// ALL APPLICATION PACKAGES does not fix its restricted user token.
export function requireDesktopSession() {
  if (process.platform === 'win32' && /^codexsandbox/i.test(os.userInfo().username)) {
    console.error('F01_DESKTOP_SESSION_REQUIRED: 请在正常 Windows 用户终端运行此命令。');
    console.error('Codex 工具受限账户无法通过 Electron 沙箱权限检查，已停止启动以避免系统错误弹窗。');
    console.error('Codex 内运行时请使用获准的正常用户执行环境；应用 sandbox/contextIsolation 保持开启。');
    process.exit(2);
  }
}
