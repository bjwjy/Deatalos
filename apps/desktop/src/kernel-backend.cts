import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MappingOptions, MappingPlan, NativePort } from '@hyd/engine' with { 'resolution-mode': 'import' };
import type { KernelCursor, KernelPort, KernelRequest } from '@hyd/application' with { 'resolution-mode': 'import' };
import type { Result, NetworkProject, NetworkIdentity } from '@hyd/domain' with { 'resolution-mode': 'import' };
import {
  NativeChannel,
  NativeFault,
  NativeRejection,
  NativeAcquisitionFailure,
  type NativeTransport,
  type NativeLaunch,
} from './native-channel.cjs';
import { SessionFault, reserveKernelSession, writeKernelRelease } from './kernel-session-store.cjs';
import { codeOf } from './atomic-file.cjs';

export interface BackendResources {
  readonly resourceRoot: string;
  readonly sessionsRoot: string;
  readonly timeoutMs: number;
  readonly expectedResourceDigest?: string;
  readonly onInitializationProgress?: (percent: number, stage: string) => void;
}
export type TransportFactory = (launch: NativeLaunch) => Promise<NativeTransport>;
interface ReleaseAcknowledgement {
  readonly protocol: 'HydraulicKernel';
  readonly version: 1;
  readonly kind: 'release';
  readonly status: 'ok';
  readonly identity: NetworkIdentity;
}
const failure = (
  code: string,
  message: string,
  context?: { readonly field: string; readonly suggestion: string },
): Extract<Result<never>, { readonly ok: false }> => ({
  ok: false,
  diagnostics: [
    {
      code,
      field: context?.field ?? '/kernel',
      severity: 'error',
      message,
      suggestion: context?.suggestion ?? '保留工程及显式历史，检查后重新初始化；不要无条件重发控制。',
    },
  ],
});

function nativeRejection(
  cause: NativeRejection,
  project: NetworkProject,
  request: KernelRequest,
  lastTimeS: number | undefined,
  plan: MappingPlan,
  nativeComponentId: (id: string) => string,
): Extract<Result<never>, { readonly ok: false }> {
  const operation = request.kind === 'advance' ? '推进' : request.kind === 'control' ? '控制' : '初始化';
  const clock =
    `请求${operation}至 ${request.identity.timeS.toFixed(6)} s，` +
    (lastTimeS === undefined ? '' : `上次有效时刻 ${lastTimeS.toFixed(6)} s，`) +
    `原生子步 ${plan.options.nativeStepS * 1e6} μs`;
  if (!cause.details.length) {
    return failure(cause.code, `${cause.message}（${clock}）。内核未返回具体故障位置。`);
  }
  const lowPressureOnly = cause.details.every((detail) => {
    const match =
      /^(?:Info: )?In \S+;\s+Simulation was stopped at t=[\d.eE+-]+\s*:\s*HYD_PRESSURE [A-Z]+ below_floor (\S+)(?: \S+)?$/.exec(
        detail,
      );
    return match && Number.isFinite(Number(match[1])) && Number(match[1]) < 0;
  });
  return {
    ok: false,
    ...(lowPressureOnly ? { lowPressureOnly: true } : {}),
    diagnostics: cause.details.flatMap((detail) => {
      const stopped = /^(?:Info: )?In (\S+);\s+Simulation was stopped at t=([\d.eE+-]+)\s*:\s*(.+)$/.exec(detail);
      const componentIndex = stopped
        ? project.design.components.findIndex((component) => nativeComponentId(component.id) === stopped[1])
        : -1;
      const field = componentIndex >= 0 ? `/design/components/${componentIndex}` : '/kernel';
      const nativeObject = componentIndex < 0 && stopped ? `内核对象 ${stopped[1]}，` : '';
      const timeS = stopped ? Number(stopped[2]) : NaN;
      const when = Number.isFinite(timeS) ? `停机时刻 ${timeS.toFixed(9)} s，${clock}。` : `${clock}。`;
      if (
        stopped &&
        [
          'Motor cavity outside declared fixed-volume inventory domain',
          'Teaching oil storage outside finite liquid/cavity domain',
        ].includes(stopped[3] ?? '')
      ) {
        const owners = plan.integratedPorts.filter((port) => port.storage.component === stopped[1]);
        if (owners.length)
          return owners.flatMap((port) => {
            const index = project.design.components.findIndex((component) => component.id === port.componentId);
            return failure(
              'MODEL_DOMAIN_EXCEEDED',
              `${port.portId} 口所在油腔的油量收支超出有限储油模型范围。${when}`,
              {
                field: `/design/components/${index}/${port.portId}`,
                suggestion:
                  '核对负载带动方向、回油侧节流和补油能力。可缩短超越负载持续时间，或按实际回路设置制动及补油。',
              },
            ).diagnostics;
          });
      }
      const pressure = /^HYD_PRESSURE ([A-Z]+) (below_floor|above_limit|nonfinite) (\S+)(?: (\S+))?$/.exec(
        stopped?.[3] ?? '',
      );
      if (!pressure) {
        const intensifier =
          componentIndex >= 0 && project.design.components[componentIndex]?.typeId === 'pressure-intensifier';
        return failure('NATIVE_SIMULATION_STOPPED', `${nativeObject}${when} 内核原因：${stopped?.[3] ?? detail}`, {
          field,
          suggestion: intensifier
            ? '检查增压器 IN/H/R 压力与回油。若 H 口接封闭中位换向阀，核对 H 侧限压回油路径，并按实际供油段建模油液容积。'
            : '根据内核原因核对所指元件或参数，再重新初始化。',
        }).diagnostics;
      }
      const [, port, reason, rawPressure, rawDifferential] = pressure;
      const value = Number(reason === 'above_limit' ? rawDifferential : rawPressure);
      const knownPressure = Number.isFinite(value);
      const causeText =
        reason === 'below_floor' && knownPressure
          ? `计算压力 ${value.toPrecision(7)} Pa，低于模型压力下限 0 Pa`
          : reason === 'above_limit' && knownPressure
            ? `工作压差 ${(value / 1e6).toPrecision(7)} MPa，超出模型上限 70 MPa`
            : '计算得到非有限的压力或流量';
      return failure('NATIVE_PORT_PRESSURE_REJECTED', `${nativeObject}${port} 口${causeText}。${when}`, {
        field: `${field}/${port}`,
        suggestion:
          reason === 'below_floor'
            ? '检查该油口所在支路的供油、回油和补油路径，尤其是换向或负载带动执行器时。'
            : reason === 'above_limit'
              ? '检查该支路的增压比、限压设置和回油背压。'
              : '检查该油口两侧的压力初值、连接和相关元件参数。',
      }).diagnostics;
    }),
  };
}

export class HopsanBackend implements KernelPort {
  #cursor: KernelCursor | null = null;
  #close: Promise<Result<true>> | null = null;
  #busy = false;
  #monitorBytes = 0;
  #monitorTruncated = false;
  #pendingWrites = new Set<Promise<void>>();
  readonly #frameReads: readonly { readonly command: string; readonly keys: readonly string[] }[];
  private constructor(
    readonly project: NetworkProject,
    readonly plan: MappingPlan,
    readonly directory: string,
    readonly resourceDigest: string,
    private transport: NativeTransport,
    private initializationStep?: (stage: string) => void,
  ) {
    this.#frameReads = this.#buildFrameReads();
  }
  get nativePid(): number | undefined {
    return this.transport.pid;
  }
  static async create(
    input: unknown,
    options: MappingOptions,
    resources: BackendResources,
    factory: TransportFactory = NativeChannel.open,
  ): Promise<Result<HopsanBackend>> {
    const { compileHopsan } = await import('@hyd/engine');
    const compiled = compileHopsan(input, options);
    if (!compiled.ok) return compiled;
    let directory: string | null = null;
    let acquisitionAttempted = false;
    try {
      if (!Number.isFinite(resources.timeoutMs) || resources.timeoutMs < 50 || resources.timeoutMs > 30000)
        return failure('BACKEND_CONFIG', '原生超时预算无效。');
      const manifestBytes = await readFile(path.join(resources.resourceRoot, 'resources.json'), 'utf8');
      const resourceDigest = createHash('sha256').update(manifestBytes).digest('hex');
      if (resources.expectedResourceDigest !== undefined && resources.expectedResourceDigest !== resourceDigest)
        return failure('RECOVERY_RESOURCES_CHANGED', '运行所用原生资源版本已改变，保留原停算记录。');
      const manifest: unknown = JSON.parse(manifestBytes);
      let nativeDirectory = '';
      if (manifest && typeof manifest === 'object' && 'nativeDirectory' in manifest) {
        if (typeof manifest.nativeDirectory !== 'string' || !/^native\/[a-f0-9]{64}$/.test(manifest.nativeDirectory))
          return failure('BACKEND_RESOURCE_INVALID', '原生版本目录无效。');
        nativeDirectory = manifest.nativeDirectory + '/';
      }
      const required = [
        nativeDirectory + 'kernel-host.exe',
        'bin/hopsancore.dll',
        'bin/libgcc_s_seh-1.dll',
        'bin/libstdc++-6.dll',
        'bin/libwinpthread-1.dll',
        'componentLibraries/defaultLibrary/defaultcomponentlibrary.dll',
        'componentLibraries/defaultLibrary/LICENSE',
        nativeDirectory + 'teaching-components.dll',
      ];
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        !('files' in manifest) ||
        !Array.isArray(manifest.files) ||
        manifest.files.length !== required.length
      )
        return failure('BACKEND_RESOURCE_INVALID', '后端资源清单不完整。');
      // Each verified file, fully configured component and connected edge counts once.
      // Five more units cover mapping, native launch, model creation, native init and acceptance of the initial state.
      const total = required.length + compiled.value.components.length + compiled.value.connections.length + 5;
      let completed = 0,
        lastPercent = -1,
        lastStage = '';
      const step = resources.onInitializationProgress
        ? (stage: string) => {
            const percent = Math.floor((++completed * 100) / total);
            if (percent !== lastPercent || stage !== lastStage) resources.onInitializationProgress?.(percent, stage);
            lastPercent = percent;
            lastStage = stage;
          }
        : undefined;
      step?.('校验内核文件');
      const manifestFiles = manifest.files;
      let verifiedFiles = 0;
      const verified = await Promise.allSettled(
        required.map(async (file) => {
          const entry: unknown = manifestFiles.find(
            (v: unknown) => v && typeof v === 'object' && 'path' in v && v.path === file,
          );
          const digest = createHash('sha256')
            .update(await readFile(path.join(resources.resourceRoot, file)))
            .digest('hex');
          if (!entry || typeof entry !== 'object' || !('sha256' in entry) || entry.sha256 !== digest)
            return failure('BACKEND_RESOURCE_INVALID', '后端资源摘要不匹配：' + file);
          step?.(++verifiedFiles === required.length ? '启动仿真内核' : '校验内核文件');
          return { ok: true as const, value: true as const };
        }),
      );
      // The fixed allow-list bounds parallel reads. Every check settles before
      // a session/native process can be acquired, including the failure path.
      for (const check of verified) {
        if (check.status === 'rejected') throw check.reason;
        if (!check.value.ok) return check.value;
      }
      directory = await reserveKernelSession(resources.sessionsRoot);
      await writeFile(path.join(directory, 'mapping.json'), JSON.stringify(compiled.value, null, 2));
      acquisitionAttempted = true;
      const transport = await factory({
        executable: path.join(resources.resourceRoot, nativeDirectory, 'kernel-host.exe'),
        library: path.join(resources.resourceRoot, 'componentLibraries/defaultLibrary/defaultcomponentlibrary.dll'),
        runtime: resources.resourceRoot,
        directory,
        timeoutMs: resources.timeoutMs,
        extraLibraries: [path.join(resources.resourceRoot, nativeDirectory, 'teaching-components.dll')],
      });
      step?.('建立仿真模型');
      return {
        ok: true,
        value: new HopsanBackend(
          compiled.value.graph.project,
          compiled.value,
          directory,
          resourceDigest,
          transport,
          step,
        ),
      };
    } catch (cause) {
      const message = cause instanceof NativeFault ? cause.message : `后端初始化未完成（${codeOf(cause)}）。`;
      const rejected = failure(
        cause instanceof NativeFault ? cause.code : 'BACKEND_LOAD_FAILED',
        message,
        cause instanceof SessionFault ? cause : undefined,
      );
      const diagnostics = [...rejected.diagnostics];
      if (directory) {
        try {
          await writeFile(path.join(directory, 'failure.json'), JSON.stringify({ message }));
        } catch (logCause) {
          diagnostics.push(
            ...failure('SESSION_LOG_FAILED', `初始化失败记录写入失败（${codeOf(logCause)}）。`).diagnostics,
          );
        }
        // An arbitrary factory rejection is not proof of native shutdown. Never forge a reusable marker.
        if (!acquisitionAttempted || cause instanceof NativeAcquisitionFailure) {
          try {
            await writeKernelRelease(directory, { failedAcquisition: true });
          } catch (releaseCause) {
            diagnostics.push(
              ...failure(
                'SESSION_RELEASE_WRITE_FAILED',
                releaseCause instanceof SessionFault ? releaseCause.message : '失败获取后的释放标记未能完整发布。',
                releaseCause instanceof SessionFault ? releaseCause : undefined,
              ).diagnostics,
            );
          }
        }
      }
      return { ok: false, diagnostics };
    }
  }
  async execute(request: KernelRequest): Promise<Result<unknown>> {
    if (this.#close) return failure('BACKEND_CLOSED', '运行已释放。');
    if (this.#busy) return failure('BACKEND_BUSY', '原生操作已在执行。');
    this.#busy = true;
    try {
      const { validateKernelRequest } = await import('@hyd/application');
      const proposed = validateKernelRequest(this.project, request, this.#cursor);
      if (!proposed.ok) return proposed;
      if (request.kind === 'initialize' && request.clock?.nativeStepS !== this.plan.options.nativeStepS)
        return failure('CLOCK_INVALID', '应用时钟与已编译原生子步不匹配。');
      const { controlWrites, mappedSnapshot } = await import('@hyd/engine');
      if (request.kind === 'release') {
        const acknowledgement: ReleaseAcknowledgement = {
          protocol: 'HydraulicKernel',
          version: 1,
          kind: 'release',
          status: 'ok',
          identity: request.identity,
        };
        const closed = await this.#finishClose(acknowledgement);
        if (!closed.ok) return closed;
        this.#cursor = proposed.value.next;
        return { ok: true, value: acknowledgement };
      }
      if (request.kind === 'initialize' || request.kind === 'reset') await this.#compile();
      const advance =
        request.kind === 'advance' ? await this.transport.command(`advance ${request.identity.timeS}`) : undefined;
      if (request.kind === 'control') {
        const writes = controlWrites(this.plan, this.#cursor?.controls, request.controls);
        if (!writes.ok) return writes;
        for (const write of writes.value.writes)
          await this.transport.command(`write ${write.ref.component} ${write.ref.port} Value ${write.value}`);
      }
      const identity = Object.freeze({ ...request.identity }),
        frame = await this.#frame(identity, advance);
      const point = mappedSnapshot(this.plan, { ...frame, identity }, identity, proposed.value.next.controls);
      if (this.#close) return failure('RESPONSE_STALE', '运行已取消，未提交原生响应。');
      if (!point.ok) {
        let rejected = point;
        try {
          // A rejected frame is evidence only, never a result/history point.
          await this.#writeEvidence(
            'failed-frame.json',
            JSON.stringify(
              {
                format: 'HydraulicRejectedNativeFrame',
                version: 1,
                operation: request.kind,
                attemptedIdentity: identity,
                lastAcceptedIdentity: this.#cursor?.identity ?? null,
                nativeStepS: this.plan.options.nativeStepS,
                pressureReference: this.project.design.pressureReference,
                pressureOffsetPa: this.plan.pressureOffsetPa,
                controls: proposed.value.next.controls,
                nativeFrame: frame,
                diagnostics: point.diagnostics,
              },
              null,
              2,
            ),
            'replace',
          );
        } catch (cause) {
          rejected = {
            ok: false,
            diagnostics: [
              ...point.diagnostics,
              ...failure('SESSION_LOG_FAILED', '拒绝帧证据保存失败：' + String(cause).slice(0, 160)).diagnostics,
            ],
          };
        }
        const closed = await this.close();
        return closed.ok ? rejected : { ok: false, diagnostics: [...rejected.diagnostics, ...closed.diagnostics] };
      }
      this.#cursor = proposed.value.next;
      return {
        ok: true,
        value: {
          protocol: 'HydraulicKernel',
          version: 1,
          kind: 'snapshot',
          status: 'ok',
          identity,
          point: point.value,
        },
      };
    } catch (cause) {
      const closed = await this.close();
      const rejected =
        cause instanceof NativeRejection
          ? nativeRejection(
              cause,
              this.project,
              request,
              this.#cursor?.identity.timeS,
              this.plan,
              (await import('@hyd/engine')).nativeComponentId,
            )
          : failure(cause instanceof NativeFault ? cause.code : 'BACKEND_FAILED', String(cause).slice(0, 240));
      return closed.ok ? rejected : { ok: false, diagnostics: [...rejected.diagnostics, ...closed.diagnostics] };
    } finally {
      this.#busy = false;
    }
  }
  async #writeEvidence(name: string, bytes: string, mode: 'append' | 'replace'): Promise<void> {
    if (this.#close) throw new NativeFault('BACKEND_CLOSED', '运行已退役，未再写入会话记录。');
    const pending =
      mode === 'append'
        ? appendFile(path.join(this.directory, name), bytes)
        : writeFile(path.join(this.directory, name), bytes);
    this.#pendingWrites.add(pending);
    try {
      await pending;
    } finally {
      this.#pendingWrites.delete(pending);
    }
  }
  async #compile(): Promise<void> {
    const step = this.initializationStep;
    this.initializationStep = undefined;
    await this.transport.command(`new ${this.plan.options.nativeStepS}`);
    step?.('配置仿真元件');
    for (const c of this.plan.components) {
      await this.transport.command(`add ${c.id} ${c.type}`);
      for (const [k, v] of Object.entries(c.constants)) await this.transport.command(`param ${c.id} ${k} ${v}`);
      for (const [k, v] of Object.entries(c.inputs)) await this.transport.command(`start ${c.id} ${k} Value ${v}`);
      for (const [p, v, n] of c.start) await this.transport.command(`start ${c.id} ${p} ${v} ${n}`);
      step?.(c === this.plan.components.at(-1) ? '建立模型连接' : '配置仿真元件');
    }
    for (const edge of this.plan.connections) {
      await this.transport.command('connect ' + edge.join(' '));
      step?.(edge === this.plan.connections.at(-1) ? '求解初始状态' : '建立模型连接');
    }
    await this.transport.command('init 86400');
    step?.('读取初始状态');
  }
  #buildFrameReads(): readonly { readonly command: string; readonly keys: readonly string[] }[] {
    const reads = new Map<string, { ref: NativePort; variable: string }>();
    const add = (ref: NativePort, variable: string) =>
      reads.set(`${ref.component}/${ref.port}/${variable}`, { ref, variable });
    for (const port of this.plan.ports) {
      if (port.cavity) add(port.cavity, 'Value');
      for (const ref of port.pressure) {
        add(ref, 'Pressure');
        add(ref, 'Flow');
      }
    }
    for (const c of this.plan.controls)
      if (c.travelM !== null) add({ component: c.ref.component, port: 'xv' }, 'Value');
      else if (c.readBack === 'displacement') add(c.ref, 'Value');
    for (const c of [...this.plan.cylinders, ...this.plan.motors])
      if (c.source === 'signal')
        for (const port of ['travel', 'rate', 'effort']) add({ component: c.ref.component, port }, 'Value');
    for (const c of this.plan.cylinders) {
      if (c.source === 'signal') continue;
      add(c.ref, 'Position');
      add(c.ref, 'Velocity');
    }
    for (const m of this.plan.motors) {
      if (m.externalDisplacement) {
        add(m.externalDisplacement.input, 'Value');
        add(m.externalDisplacement.voltage, 'Value');
      }
      if (m.displacementCurve) {
        add(m.displacementCurve.input, 'Value');
        add(m.displacementCurve.pressure, 'Value');
        if (m.displacementCurve.voltage) add(m.displacementCurve.voltage, 'Value');
      }
      if (m.source === 'signal') continue;
      add(m.ref, 'Angle');
      add(m.ref, 'AngularVelocity');
      add(m.ref, 'Torque');
    }
    for (const c of this.plan.components)
      if (c.type === 'HydraulicTeachingAccumulator')
        for (const port of ['Vo', 'Vg', 'pg', 'E']) add({ component: c.id, port }, 'Value');
      else if (c.type === 'HydraulicTeachingShockMakeup')
        for (const port of ['reliefAFlow', 'reliefBFlow', 'makeupAFlow', 'makeupBFlow'])
          add({ component: c.id, port }, 'Value');
      else if (c.type === 'HydraulicTeachingDifferentialGauge') add({ component: c.id, port: 'dp' }, 'Value');
      else if (c.type === 'HydraulicTeachingPressureSwitch') {
        add({ component: c.id, port: 'OUT' }, 'Value');
        add({ component: c.id, port: 'active' }, 'Value');
      } else if (c.type === 'HydraulicTeachingUnloadValve') add({ component: c.id, port: 'active' }, 'Value');
    for (const branch of this.plan.reliefBranches) add(branch.ref, 'Flow');
    for (const constraint of this.plan.constraints) for (const ref of constraint.ports) add(ref, 'Pressure');
    // The session's compiled plan is fixed. Retain every quantity and the
    // original command budgets without rebuilding the batches at every point.
    const batches: { command: string; keys: string[] }[] = [];
    let command = 'frame',
      keys: string[] = [];
    for (const [key, { ref, variable }] of reads) {
      const read = ` ${ref.component} ${ref.port} ${variable}`;
      if (command.length + read.length > 2000 || keys.length === 512) {
        batches.push({ command, keys });
        command = 'frame';
        keys = [];
      }
      command += read;
      keys.push(key);
    }
    if (keys.length) batches.push({ command, keys });
    return batches;
  }
  async #frame(
    identity: NetworkIdentity,
    advance?: Readonly<Record<string, unknown>>,
  ): Promise<{ nativeTimeS: number; values: Record<string, number> }> {
    // Advance returns the same observed time as the read-only time command.
    // Every frame batch independently checks the native clock before replying.
    const time = advance === undefined ? (await this.transport.command('time')).time : advance.time;
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new NativeFault('BACKEND_FRAME_INVALID', '原生快照时钟缺失或非有限。');
    const values: Record<string, number> = {};
    for (const { command, keys } of this.#frameReads) {
      const frame = await this.transport.command(command);
      if (frame.time !== time || !Array.isArray(frame.values) || frame.values.length !== keys.length)
        throw new NativeFault('BACKEND_FRAME_INVALID', '原生批量快照时间或数量不匹配。');
      for (const [index, key] of keys.entries()) {
        const value: unknown = frame.values[index];
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new NativeFault('BACKEND_NONFINITE', '原生量缺失或非有限：' + key);
        values[key] = value;
      }
    }
    if (advance === undefined && time !== (await this.transport.command('time')).time)
      throw new NativeFault('BACKEND_FRAME_INVALID', '原生快照读取期间时钟发生变化。');
    const monitors = this.plan.constraints.map((c) => {
      const ps = c.ports.map((p) => values[`${p.component}/${p.port}/Pressure`]);
      const a = ps[0],
        b = ps[1];
      if (a === undefined || b === undefined) throw new NativeFault('MAPPING_CONSTRAINT_UNKNOWN', '约束桥压力未知。');
      const measuredPa = Math.abs(a - b);
      return {
        netId: c.netId,
        pressureBudgetPa: c.pressureBudgetPa,
        measuredPa,
        passed: measuredPa <= c.pressureBudgetPa + 1e-5,
      };
    });
    const monitor = JSON.stringify({ identity, nativeTimeS: time, monitors }) + '\n';
    this.#monitorBytes += Buffer.byteLength(monitor);
    if (this.#monitorBytes <= 10 * 1024 * 1024) await this.#writeEvidence('monitors.jsonl', monitor, 'append');
    else if (!this.#monitorTruncated) {
      this.#monitorTruncated = true;
      await this.#writeEvidence('monitors.jsonl', '{"truncated":true,"monitoringContinues":true}\n', 'append');
    }
    const exceeded = monitors.find((m) => !m.passed);
    if (exceeded) throw new NativeFault('MAPPING_CONSTRAINT_EXCEEDED', JSON.stringify(exceeded));
    return { nativeTimeS: time, values };
  }
  close(): Promise<Result<true>> {
    return this.#finishClose();
  }
  #finishClose(acknowledgement?: ReleaseAcknowledgement): Promise<Result<true>> {
    if (this.#close) return this.#close;
    this.#close = (async (): Promise<Result<true>> => {
      try {
        await this.transport.close();
      } catch {
        return failure('BACKEND_CLEANUP_FAILED', '原生进程释放或释放证据确认失败；历史目录已保留。');
      }
      const writes = await Promise.allSettled([...this.#pendingWrites]);
      if (writes.some((result) => result.status === 'rejected'))
        return failure('SESSION_LOG_FAILED', '原生资源已退出，但退役前的会话记录未能写完，未发布释放标记。');
      if (acknowledgement) {
        try {
          await appendFile(path.join(this.directory, 'acknowledgements.jsonl'), JSON.stringify(acknowledgement) + '\n');
        } catch {
          return failure('SESSION_LOG_FAILED', '原生资源已退出，但释放应答记录写入失败，未发布释放标记。');
        }
      }
      try {
        await writeKernelRelease(this.directory, { identity: this.#cursor?.identity ?? null });
        return { ok: true, value: true };
      } catch (cause) {
        return failure(
          'SESSION_RELEASE_WRITE_FAILED',
          cause instanceof SessionFault ? cause.message : '原生资源已释放，但释放标记未能完整发布。',
          cause instanceof SessionFault ? cause : undefined,
        );
      }
    })();
    return this.#close;
  }
}
