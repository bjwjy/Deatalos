# 原生仿真开发环境

`npm run build` 生成桌面源码构建产物。进阶版实际运行瞬态液压仿真时，需要额外准备与 Hopsan 2.24.4 Windows x64 对应的运行环境、头文件、MinGW 工具链和源码。项目原生桥接和扩展模型位于 `apps/desktop/native/`。

开发脚本读取以下两处本地目录。将 Hopsan 官方 Windows 运行环境解包到第一处，将对应上游源码解包到第二处。

- `artifacts/tool-cache/E00C/runtime/Hopsan-2.24.4-win64/`
- `artifacts/tool-cache/E00C/source/hopsan-2.24.4/`

在根目录按顺序运行。Python 用于准备最小运行资源，PowerShell 脚本用该工具链构建扩展，最后一步校验清单并把本地资源放到桌面构建目录。

```powershell
python tools/prototypes/E00C/prepare-headless.py
powershell -NoProfile -File tools/build/build-kernel-e04b.ps1
node tools/build/stage-kernel-e00d.mjs
```

Hopsan 目录结构须与脚本要求一致，包含默认元件库与授权文件。安装或解包位置不同的情况下，应按本页布局准备资源。公开源码的独立验证覆盖源码编译和测试，原生工具链从零搭建仍待复验。

