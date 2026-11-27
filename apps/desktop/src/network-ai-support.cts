import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, boundedRead, digest, fingerprint, FileFailure } from './atomic-file.cjs';

interface SupportAsset {
  readonly names: readonly string[];
  readonly bytes: Buffer;
  readonly prior: string;
  readonly previous?: readonly string[];
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
  const bundleFiles = new Map<string, Buffer>([
    ['GUIDE.md', Buffer.from(io.folderAgentRules)],
    ['资料说明.md', Buffer.from(io.folderSupportIndex)],
    ['工程任务分析.md', Buffer.from(io.folderEngineeringGuide)],
    ['工程目录说明.md', Buffer.from(io.folderUserGuide)],
    ['诊断与AI说明.md', diagnosticGuide],
    ['软件操作手册.md', operationGuide],
    ['工况选配.md', selectionGuide],
    ['选配策略.json', selectionData],
  ]);
  const manifest = Array.from(bundleFiles, ([name, bytes]) => name + ':' + digest(bytes)).join('\n');
  const version = 'mcp-' + digest(manifest).slice(0, 12);
  const relative = ['docs', 'ai-support', version];
  const assets: readonly SupportAsset[] = [
    {
      names: ['AI.md'],
      bytes: Buffer.from(io.networkFolderReadme(relative.join('/'))),
      prior: 'a63b93d9ee02a27ff129b0ab153be6a5f9ac7802a9ea05af14c5e5d718527f21',
      previous: [
        'ff6d570f4d0a110f93aa5957eb52721500d651444037085e900298498d98dbee',
        '48901fdd434cb83a6bc60a2a81514cb0fac45c9129a147cc80f069460e8b0d69',
        '59be1bea2b70fc6c6c0d57dd6447f7e096a82d6d171aedf9111be064bc7baa3e',
        '1890e765a9e62db61a7edc0d3c2b96d837120b8ced0fa0550783e8f269987225',
        'af0fe32356c682b10c55ee8c8f7df50238451b96f6ca53c85d1f0f2ed6a1371b',
        'a6c6968139b2ead0da88eff25a05cc84d07658c53f15bfd86ace8c564e3c078b',
      ],
    },
    {
      names: ['docs', 'AI接入.md'],
      bytes: Buffer.from(io.folderAgentGuide),
      prior: '7892e026761ed2463fbef5f37ba0d77e76d7d46ad5b3e0639b3185306442c564',
      previous: [
        '6e9b5b6782b02a3ae3f9cfc547f587e7c0917516e791136aefdca4d9ddfc2a68',
        '112051c384a922621822d4bf7567e6122b3c16629d26c5e23af0952235c870a7',
        '8cbb109e18c3f3fb44ef5d3ed73b7a80364a729a8ab7ffb77bc38c2e1fdeac71',
        '3b75b81e18871e4b1d5526dd2abb0516e28ceeeee79442853c33c5ec7ca713af',
        '0106e747e6df8e9ceea8359ab9aad5e4e18ceee1ad648a3e32555ebf671d3672',
        'ea2e9bf281ff00d5695f40dea83f2e60a1a467e6c87f2340d5f1f83d50ece305',
        'f2873f9e540351ba1a2c7cba667eb2a24888f3987b1f3a07f847096506870061',
      ],
    },
    {
      names: ['工程目录说明.md'],
      bytes: Buffer.from(io.folderUserGuide),
      prior: '4b5a4e3cc90e97d7e95598fd9b4fddae40fc1b7201f99747c9635229dfab1165',
      previous: ['b2be5c2bb0047f24538c2f2c61d4a63381d090bcb68db91c38462f44e8d21536'],
    },
    {
      names: ['docs', 'AI自动接入.md'],
      bytes: Buffer.from(io.folderAutoAgentGuide),
      prior: '10867c7334c1594b1b3232ee341a626dbb0ee9fff0b1096df3a8a0c238232dac',
      previous: [
        '6e9b5b6782b02a3ae3f9cfc547f587e7c0917516e791136aefdca4d9ddfc2a68',
        '112051c384a922621822d4bf7567e6122b3c16629d26c5e23af0952235c870a7',
        '8cbb109e18c3f3fb44ef5d3ed73b7a80364a729a8ab7ffb77bc38c2e1fdeac71',
        '3b75b81e18871e4b1d5526dd2abb0516e28ceeeee79442853c33c5ec7ca713af',
        '0106e747e6df8e9ceea8359ab9aad5e4e18ceee1ad648a3e32555ebf671d3672',
        'e2d2c1d9d01fcf8d1b2b0ba92207b99048f22a49505bc6f7e0da9b4910f6e89b',
        '1c00c078be64187ecf1b4ba7c969af5941af3df35eab68bfbe036593cfa56426',
        'b43e9cf529a8566ffb3801fb32fd13b0a8e41cefca34224d9982772b66fb3ecc',
        '819124cb5f49064c6a419896454675c10bf612ed1ad1024ec2d42597ce418c99',
        'a9eb22e55de64afcd0608452c57fc33c7807aabadb2e54b095529461b8cdc0f0',
        '360f0c087d32104bf5ed9009cd884a81e8eac7738b035e0bb14479b8340d3099',
        'ab2e40d503edc18cf7e7660a14c3b0db9ba8765964bec9e11d9ade4a8427bac4',
        '20340c68b179694798c905a4f7cab1f77f0f16d5888bf59fa164ce57260bc266',
      ],
    },
    {
      names: ['AGENTS.md'],
      bytes: Buffer.from(io.folderAgentRules),
      prior: '',
      previous: [
        '6e9b5b6782b02a3ae3f9cfc547f587e7c0917516e791136aefdca4d9ddfc2a68',
        '112051c384a922621822d4bf7567e6122b3c16629d26c5e23af0952235c870a7',
        '8cbb109e18c3f3fb44ef5d3ed73b7a80364a729a8ab7ffb77bc38c2e1fdeac71',
        '3b75b81e18871e4b1d5526dd2abb0516e28ceeeee79442853c33c5ec7ca713af',
        '0106e747e6df8e9ceea8359ab9aad5e4e18ceee1ad648a3e32555ebf671d3672',
        'dd0f548570964854abebc473aab234608681df391e6a04e36f096282821b57f2',
        '29a98e8ec57808dca29fce9a17e7816f4a6beff0fdbe33286559cc0c420cb71c',
        '303747f085b9bd5c108fbf045fd753d8a1ab44c4fece2e8295ce7c35bee1ce56',
        'e37fb3e7637948499899162a543b09e2ef15492f786eb62d1743d61365964359',
        'bbf1639f71bcddf02175b5040c60d500f782745ac98b9dfa083d1bed414a094a',
        'edb2541dad7c27ccadd3713d59a66557f2cbbb410b7373caf87cae12b202ae3a',
        'f35b7662c8bc508a859f89c85da7a33f554b8548bc099cc2597f6eb7fa31609a',
      ],
    },
    {
      names: ['docs', '工程任务分析.md'],
      bytes: Buffer.from(io.folderEngineeringGuide),
      prior: 'd90695fe055fceaff5f132883c486351292f062dc585bc9ed8bf0fada3017fef',
      previous: [
        '7ffded132af4fe26c2c86038b4097054a933e02b2aa665f47ea23bd120173314',
        '5d9cffa65cd68520aafd8921427b0f97d6db883d7950eaec24c63d06197e62eb',
      ],
    },
  ];
  const inspect = [];
  for (const asset of assets) {
    const parent = await directory(asset.names.slice(0, -1));
    const file = path.join(parent, asset.names.at(-1) ?? '');
    const before = await fingerprint(file);
    const bytes = before === null ? null : await boundedRead(file);
    inspect.push({ asset, file, before, bytes });
  }
  const bundle = await directory(relative);
  async function immutableFile(file: string, bytes: Buffer) {
    const before = await fingerprint(file);
    if (before === null) await atomicWrite(file, bytes, null, current);
    else if (digest(await boundedRead(file)) !== digest(bytes))
      throw new FileFailure('CLIENT_FILE_CONFLICT', '当前版本AI资料被外部修改，未覆盖；工程数据及原件保留。');
  }
  for (const [name, bytes] of bundleFiles) await immutableFile(path.join(bundle, name), bytes);
  // An unedited root index may refer to an older bundle. Match the entire file.
  function isGeneratedIndex(asset: SupportAsset, bytes: Buffer): boolean {
    if (asset.names.length !== 1 || asset.names[0] !== 'AI.md') return false;
    const oldPath = bytes.toString('utf8').match(/docs\/ai-support\/mcp-[0-9a-f]{12}(?=\/)/)?.[0];
    return oldPath !== undefined && bytes.equals(Buffer.from(io.networkFolderReadme(oldPath)));
  }
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
      if (item.bytes) {
        const checksum = digest(item.bytes);
        if (
          checksum !== item.asset.prior &&
          !item.asset.previous?.includes(checksum) &&
          !isGeneratedIndex(item.asset, item.bytes)
        )
          continue;
        const backup = await directory(['docs', 'ai-support', 'backups', checksum]);
        const name = path.basename(item.file);
        await immutableFile(path.join(backup, name === 'AGENTS.md' ? 'AGENTS.md.bak' : name), item.bytes);
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
