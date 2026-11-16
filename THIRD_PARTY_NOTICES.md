# 第三方声明与项目参考

Deatalos 的自有源码采用 [Apache License 2.0](LICENSE)。下列组件和移植代码沿用各自许可，相关版权与授权文本随其来源保留。

| 第三方来源 | 使用范围 | 许可与出处 |
| --- | --- | --- |
| Hopsan | 进阶仿真调用 Hopsan 2.24.4 的 HopsanCore 与默认元件库。Deatalos 自行实现 C++ 宿主和本项目扩展模型。 | HopsanCore 与默认元件库采用 Apache-2.0。HopsanGUI 是上游单独授权的应用。见 [Hopsan 的许可证说明](https://github.com/Hopsan/hopsan#license)和[本项目原生模型说明](apps/desktop/native/MODELS.txt)。 |
| fluids | 管摩擦计算包含 fluids 中 Clamond 方法的移植。原版权归属见许可原文。 | MIT。见[工作台](apps/workbench/third-party/fluids-LICENSE.txt)、[计算引擎](packages/engine/third-party/fluids-LICENSE.txt)和[教学引擎](HydraulicWorkbench_v1.0/third_party/fluids-LICENSE.txt)附带的原许可。 |
| pdf-lib | PDF 文档处理。锁文件记录 pdf-lib 及它使用的 @pdf-lib/standard-fonts 和 @pdf-lib/upng 等依赖。 | pdf-lib 1.17.1 采用 MIT。见 [PDF 库许可文本](apps/desktop/third-party/pdf-lib-LICENSE.md)。子依赖的版权与许可随各自 npm 包提供。 |
| Electron 与 Chromium | 桌面运行环境，由 npm 安装预编译 Electron。 | 对应发行资产附有 Electron 与 Chromium 第三方许可。版本见 [package-lock.json](package-lock.json)。 |
| 其他工具及依赖 | TypeScript、构建工具、测试工具和原生开发环境。 | npm 依赖的版本与来源见 [package-lock.json](package-lock.json)，许可随各包提供。Hopsan 默认元件库和运行时声明的本地准备见[原生仿真环境说明](docs/NATIVE.md)。 |

FluidSIM 的公开说明是部分液压元件建模与交互的参考资料，例如[分流集流阀](https://www.art-systems.de/www/site/en/fluidsim/comp-lib/html/p2_1_1_8_10.html)与[同步分流集流阀](https://www.art-systems.de/www/site/en/fluidsim/comp-lib/html/p2_1_1_8_11.html)。本项目未引入 FluidSIM 程序或资源。实际模型能力由 Deatalos 源码和[模型说明](apps/desktop/native/MODELS.txt)定义。

界面按字体名称引用 Windows 系统字体。Deatalos 绿色羽翼图标以 PNG 和 ICO 提供，用于识别项目。发布修改版时，请清楚标明修改版的来源与维护者。
