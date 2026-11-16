# Deatalos 液压工作台

Deatalos 是面向液压教学和回路设计的 Windows 桌面工具。可以搭建原理图、检查连接、估算典型工况的压力与流量，并导出原理图和计算书。进阶工作台使用 HopsanCore 做受支持回路的瞬态仿真，提供历史曲线、读点和图表导出。

本源码快照对应 V1.4 的 1.4.0-rc.1 测试候选。项目采用 TypeScript、Electron 和 C++。

## 构建与测试

准备 Windows x64、Node.js 24、npm 11。Windows 构建还会调用系统 .NET Framework 4.x 的 C# 编译器来生成本机工具客户端。

```powershell
npm ci
npm test
```

`npm test` 会编译桌面宿主与界面，检查渲染资源，并运行本仓库随附的模型和旧版引擎测试。也可单独执行 `npm run build`。

构建后用 `npm run start:teaching` 打开教学工作台，或用 `npm run start:advanced` 打开进阶工作台。进阶版完整瞬态仿真需要另外准备 [原生内核](docs/NATIVE.md)。启动器会在终端显示本机调试地址。

## 源码结构

| 目录 | 内容 |
| --- | --- |
| `apps/desktop` | Electron 宿主、原生仿真桥接和本机工具客户端 |
| `apps/workbench` | 液压原理图编辑、计算、曲线和导出界面 |
| `packages` | 领域模型、计算、工程文件和应用逻辑 |
| `tests` | 代表性模型回归和生成式夹具 |
| `HydraulicWorkbench_v1.0` | 当前构建依赖的教学引擎基线源码和示例 |
| `tools` | 源码构建、检查和原生内核准备工具 |

自有源码依 [Apache License 2.0](LICENSE) 提供，第三方内容保留原许可。见 [第三方声明](THIRD_PARTY_NOTICES.md)。

