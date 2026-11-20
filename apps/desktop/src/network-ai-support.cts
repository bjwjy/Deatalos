import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, boundedRead, digest, fingerprint, FileFailure } from './atomic-file.cjs';

interface SupportAsset {
  readonly names: readonly string[];
  readonly bytes: Buffer;
  readonly prior: string;
  readonly previous?: readonly string[];
  readonly kind: 'guide' | 'client';
}
export interface NetworkAiSupportUpdate {
  readonly path: string;
  rollback(): Promise<void>;
}
/** Migrate only byte-identical shipped versions. Markdown customizations stay in
 * place; a private immutable bundle supplies current guidance without trusting
 * user prose or replacing an unknown executable client. Entry/data hashes stay owned by the folder store. */
export async function syncNetworkAiSupport(
  directory: (names: readonly string[]) => Promise<string>,
  current: () => boolean,
): Promise<NetworkAiSupportUpdate> {
  const io = await import('@hyd/project-io');
  const assets: readonly SupportAsset[] = [
    {
      names: ['AI.md'],
      bytes: Buffer.from(io.folderReadme),
      prior: 'a63b93d9ee02a27ff129b0ab153be6a5f9ac7802a9ea05af14c5e5d718527f21',
      previous: [
        '59be1bea2b70fc6c6c0d57dd6447f7e096a82d6d171aedf9111be064bc7baa3e',
        '1890e765a9e62db61a7edc0d3c2b96d837120b8ced0fa0550783e8f269987225',
        'af0fe32356c682b10c55ee8c8f7df50238451b96f6ca53c85d1f0f2ed6a1371b',
        'a6c6968139b2ead0da88eff25a05cc84d07658c53f15bfd86ace8c564e3c078b',
      ],
      kind: 'guide',
    },
    {
      names: ['docs', 'AI接入.md'],
      bytes: Buffer.from(io.folderAgentGuide),
      prior: '7892e026761ed2463fbef5f37ba0d77e76d7d46ad5b3e0639b3185306442c564',
      previous: ['f2873f9e540351ba1a2c7cba667eb2a24888f3987b1f3a07f847096506870061'],
      kind: 'guide',
    },
    {
      names: ['工程目录说明.md'],
      bytes: Buffer.from(io.folderUserGuide),
      prior: '4b5a4e3cc90e97d7e95598fd9b4fddae40fc1b7201f99747c9635229dfab1165',
      kind: 'guide',
    },
    {
      names: ['docs', 'AI自动接入.md'],
      bytes: Buffer.from(io.folderAutoAgentGuide),
      prior: '10867c7334c1594b1b3232ee341a626dbb0ee9fff0b1096df3a8a0c238232dac',
      previous: [
        '1c00c078be64187ecf1b4ba7c969af5941af3df35eab68bfbe036593cfa56426',
        'b43e9cf529a8566ffb3801fb32fd13b0a8e41cefca34224d9982772b66fb3ecc',
        '819124cb5f49064c6a419896454675c10bf612ed1ad1024ec2d42597ce418c99',
        'a9eb22e55de64afcd0608452c57fc33c7807aabadb2e54b095529461b8cdc0f0',
        '360f0c087d32104bf5ed9009cd884a81e8eac7738b035e0bb14479b8340d3099',
        'ab2e40d503edc18cf7e7660a14c3b0db9ba8765964bec9e11d9ade4a8427bac4',
        '20340c68b179694798c905a4f7cab1f77f0f16d5888bf59fa164ce57260bc266',
      ],
      kind: 'guide',
    },
    {
      names: ['AGENTS.md'],
      bytes: Buffer.from(io.folderAgentRules),
      prior: '',
      previous: [
        '29a98e8ec57808dca29fce9a17e7816f4a6beff0fdbe33286559cc0c420cb71c',
        '303747f085b9bd5c108fbf045fd753d8a1ab44c4fece2e8295ce7c35bee1ce56',
        'e37fb3e7637948499899162a543b09e2ef15492f786eb62d1743d61365964359',
        'bbf1639f71bcddf02175b5040c60d500f782745ac98b9dfa083d1bed414a094a',
        'edb2541dad7c27ccadd3713d59a66557f2cbbb410b7373caf87cae12b202ae3a',
        'f35b7662c8bc508a859f89c85da7a33f554b8548bc099cc2597f6eb7fa31609a',
      ],
      kind: 'guide',
    },
    {
      names: ['docs', '工程任务分析.md'],
      bytes: Buffer.from(io.folderEngineeringGuide),
      prior: '',
      kind: 'guide',
    },
    {
      names: ['docs', 'Invoke-HydraulicTool.ps1'],
      bytes: await readFile(path.join(__dirname, 'agent/Invoke-HydraulicTool.ps1')),
      prior: 'f12952c0c326d7a953e9b83d0ecfef0d0572a104d20a423a4c73b6de1d3e3e1c',
      kind: 'client',
    },
  ];
  // Executable only in the immutable version package, never overwrite a user's root client.
  const executable =
    process.platform === 'win32' ? await readFile(path.join(__dirname, 'agent/HydraulicTool.exe')) : null;
  const diagnosticGuide = Buffer.from(io.networkDiagnosticGuide());
  const operationGuide = Buffer.from(io.networkOperationGuide());
  const { networkSelectionPolicy: policy } = await import('@hyd/engineering');
  const selectionGuide = Buffer.from(
    '# 工况核算与联合选配\n\n策略版本 ' +
      policy.version +
      '\n\n先按当前工程核算压力、流量和轴功率。区分试算预算、用户固定值或范围、回路实际溢流压差。' +
      policy.automaticBudget +
      '明确保留用户锁定和范围。\n\n缸径来源：' +
      policy.cylinderSource +
      '。排量来源：' +
      policy.displacementSource +
      '。候选数据见同目录选配策略.json。' +
      policy.limitations +
      '\n\n先生成候选，用户确认后应用。缺少适用范围或额定数据时，请列出需核对的条件。\n',
  );
  const selectionData = Buffer.from(JSON.stringify(policy, null, 2) + '\n');
  const inspect = [];
  for (const asset of assets) {
    const parent = await directory(asset.names.slice(0, -1));
    const file = path.join(parent, asset.names.at(-1) ?? '');
    const before = await fingerprint(file);
    const bytes = before === null ? null : await boundedRead(file);
    if (bytes && asset.kind === 'client' && digest(bytes) !== digest(asset.bytes) && digest(bytes) !== asset.prior)
      throw new FileFailure('CLIENT_FILE_CONFLICT', '工程内客户端有未知修改，未覆盖或执行；请核查原件或另存。');
    inspect.push({ asset, file, before, bytes });
  }
  const version =
    's03-' +
    digest(
      assets.map((a) => a.names.join('/') + ':' + digest(a.bytes)).join('\n') +
        (executable ? digest(executable) : '') +
        '\n诊断与AI说明.md:' +
        digest(diagnosticGuide) +
        '\n软件操作手册.md:' +
        digest(operationGuide) +
        '\n工况选配.md:' +
        digest(selectionGuide) +
        '\n选配策略.json:' +
        digest(selectionData),
    ).slice(0, 12);
  const relative = ['docs', 'ai-support', version];
  const bundle = await directory(relative);
  async function immutableFile(file: string, bytes: Buffer) {
    const before = await fingerprint(file);
    if (before === null) await atomicWrite(file, bytes, null, current);
    else if (digest(await boundedRead(file)) !== digest(bytes))
      throw new FileFailure('CLIENT_FILE_CONFLICT', '当前版本AI资料被外部修改，未覆盖；工程数据及原件保留。');
  }
  for (const asset of assets) await immutableFile(path.join(bundle, asset.names.at(-1) ?? ''), asset.bytes);
  await immutableFile(path.join(bundle, '诊断与AI说明.md'), diagnosticGuide);
  await immutableFile(path.join(bundle, '软件操作手册.md'), operationGuide);
  await immutableFile(path.join(bundle, '工况选配.md'), selectionGuide);
  await immutableFile(path.join(bundle, '选配策略.json'), selectionData);
  if (executable) await immutableFile(path.join(bundle, 'HydraulicTool.exe'), executable);
  await immutableFile(
    path.join(bundle, '资料说明.md'),
    Buffer.from(
      '# 当前版本AI配套资料\n\n本目录由软件维护，请不要编辑。根AGENTS.md为支持客户端的规则入口，自定义版本原样保留；根AI.md及用户Markdown也保留补充。已有聊天定位目录时需核对是否加载规则。\n\n查询两缸位置、速度与差值使用本包 HydraulicTool.exe --project <工程绝对目录> --compare-cylinders。Windows普通改图使用本包HydraulicTool.exe --project <工程绝对目录> --context --summary；填好返回previewTemplate的commands后，执行 --preview-file <JSON绝对路径> --summary。一次读取/提交同时保存完整结果，并在stdout返回不超过8KiB的摘要。成功context已经获取capabilities；需要命令字段时用内置文件工具直接读recordDirectory/requestSchemaFile（request-schema.json），不要再执行--diagnose或重复capabilities。--diagnose仅用于实际连接故障排查。操作问答只读本版本软件操作手册。实时查报错沿同一次上下文摘要，用内置文件工具打开diagnosticGuideFile。按recordDirectory及file路径用内置文件工具读取设计/特定元件，不为解析、核对状态或清理再启动shell/Python，不因截断重复读取。任务书及选型先读本包工程任务分析.md，分清需求、机构、元件、参数来源和交付检查；同次design.md/catalog.md/commands.md及选定元件Markdown直接可读，JSON已多行化。默认参数不是题目计算结果，失败校验只报告不完整草稿。完整参数及响应见本包AI自动接入.md。原始模式、--session及--diagnose仍兼容；不保证外部审批次数。先核对已有回路及待处理候选，不为交付重复添加支路；只有用户明确确认才应用。实时capture含未保存编辑，磁盘只代表已保存快照；明确导出时才生成PDF，失败不替代交付。\n\n本次AI接入记录保存在工程导出_Exports/诊断_Diagnostics/AI接入_AiCalls，不改设计、不自动上传或清理；不是帮助菜单导出诊断批次。已知旧默认升级前备份到同级../backups/<原内容SHA256>/；未知客户端或版本包修改仍明确拒绝保存，入口/快照摘要保护保持。不修改全局策略或外部客户端审批，实际应用仍须用户确认。\n',
    ),
  );
  const replaced: { file: string; original: Buffer | null; written: string }[] = [];
  async function rollback() {
    for (const item of [...replaced].reverse()) {
      const before = await fingerprint(item.file);
      if (before === null || digest(await boundedRead(item.file)) !== item.written)
        throw new FileFailure(
          'CLIENT_FILE_CONFLICT',
          '保存失败且配套资料又被外部修改，未覆盖外部编辑；原版本在ai-support/backups中。',
        );
      if (item.original === null) {
        if ((await fingerprint(item.file)) !== before)
          throw new FileFailure('CLIENT_FILE_CONFLICT', '新配套文件被外部再次编辑，未删除。');
        await unlink(item.file);
      } else await atomicWrite(item.file, item.original, before, () => true);
    }
    replaced.length = 0;
  }
  try {
    for (const item of inspect) {
      if (item.bytes && digest(item.bytes) === digest(item.asset.bytes)) continue;
      if (item.bytes && digest(item.bytes) !== item.asset.prior && !item.asset.previous?.includes(digest(item.bytes)))
        continue; // User Markdown remains editable.
      if (item.bytes) {
        const backup = await directory(['docs', 'ai-support', 'backups', digest(item.bytes)]);
        await immutableFile(path.join(backup, path.basename(item.file)), item.bytes);
      }
      await atomicWrite(item.file, item.asset.bytes, item.before, current);
      replaced.push({ file: item.file, original: item.bytes, written: digest(item.asset.bytes) });
    }
  } catch (cause) {
    await rollback();
    throw cause;
  }
  return { path: relative.join('/'), rollback };
}
