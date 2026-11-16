import { defaultDiagnosticSuggestion } from './reader.js';

/** Display interpretation only. Every original diagnostic remains available as technical detail. */
export interface DisplayDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly suggestion?: string;
  readonly componentId?: string;
  readonly severity?: string;
}

/** Group presentation only: different fields, messages or recovery advice remain independent. */
export function groupDisplayDiagnostics(
  items: readonly DisplayDiagnostic[],
  objectFor: (item: DisplayDiagnostic) => string,
) {
  const groups = new Map<string, { object: string; items: DisplayDiagnostic[] }>();
  for (const item of items) {
    const object = objectFor(item),
      key = JSON.stringify([object, item.code, item.severity]);
    let group = groups.get(key);
    if (!group) {
      group = { object, items: [] };
      groups.set(key, group);
    }
    const same = (other: DisplayDiagnostic) =>
      other.code === item.code &&
      other.message === item.message &&
      other.field === item.field &&
      other.suggestion === item.suggestion &&
      other.componentId === item.componentId &&
      other.severity === item.severity;
    if (!group.items.some(same)) group.items.push(item);
  }
  return [...groups.values()];
}
const problems: Readonly<Record<string, readonly [string, string, string]>> = Object.freeze({
  SESSION_CATALOG_FAILED: [
    '历史会话目录整理失败',
    '历史会话目录或整理记录无法读取/写入，本次仿真尚未启动。',
    '保留工程及诊断，检查应用数据目录的访问权限和磁盘状态；不要清空历史目录。',
  ],
  SESSION_LIMIT: [
    '没有可安全使用的会话空间',
    '会话目录达到32份上限，现有活动或未知目录不能安全回收，本次未启动内核。',
    '退出仍在运行的窗口后重试；若仍失败，请保留故障记录并按具体原因处理，不要修改释放标记或清空目录。',
  ],
  SESSION_PATH_INVALID: [
    '历史会话回收路径未通过检查',
    '待回收目录不是所属的普通会话子目录，已保留。',
    '保留目录及诊断，检查会话目录是否被替换或链接到其他位置；不要强行删除。',
  ],
  SESSION_RELEASE_WRITE_FAILED: [
    '内核已释放，释放记录保存失败',
    '原生资源已经退出，但释放标记没有完整发布，历史目录不能据此回收。',
    '保留目录和诊断，检查磁盘、权限或文件占用；不要手动补写释放标记。',
  ],
  SESSION_LOG_FAILED: [
    '运行诊断记录保存失败',
    '会话证据写入未完成，不能把缺少记录解释成运行或释放成功。',
    '保留工程及当前诊断，检查应用数据目录的磁盘空间、权限和占用。',
  ],
  BACKEND_CLEANUP_FAILED: [
    '内核释放未能完整确认',
    '原生退出或释放证据确认失败，会话目录已保留，不能认定可安全回收。',
    '保留工程和诊断，检查运行窗口及内核进程状态；不要清空会话目录。',
  ],
  INTERNAL_RELIEF_OPEN: [
    '泵内置溢流已开启',
    '油液正通过内置有限开口从P口流回S口，实际泄放流量与本帧同源。',
    '核对P−S压差、最大开口和回油连接；开启状态不代表任意流量下都能限压。',
  ],
  INTENSIFIER_OUTLET_RELIEF_OPEN: [
    '增压器内置溢流已开启',
    '油液正通过内置有限开口从 H 口流向 R 口。',
    '核对 H−R 压差、最大开口和实际回油压力。',
  ],
  INTEGRATED_OIL_MODEL: [
    '内置储油与补油模型说明',
    '当前元件使用已声明的内置油液容积；补油支路按元件参数启用。',
    '结合属性中的容积、初压和补油参数使用结果；这些是教学假设，不是完整气蚀认证。',
  ],
  DESIGN_LAYOUT_SEPARATED: [
    '设计与布局已迁移',
    '旧工程的物理设计与画布布局已分开保存，原文件保留。',
    '检查内容后另存兼容副本。',
  ],
  LEGACY_M_CENTER: [
    '旧换向阀中位已保留',
    '旧文件没有声明中位，按旧版读取规则解释为 M 型。',
    '核对中位机能后另存，不按新建 O 型猜值。',
  ],
  FIELD_UNIT_MAPPED: [
    '参数单位已转换',
    '旧显示单位已按注册规则转换为国际单位，物理含义保持。',
    '核对中文参数与单位，原字段映射见技术详情。',
  ],
  LEGACY_INITIAL_CONDITIONS: [
    '旧版初态已迁移',
    '旧文件不含运行状态，按旧启动规则建立初始缸位、转角与阀位。',
    '核对设计初态；迁移副本需要另存。',
  ],
  PIPE_LENGTH_ALREADY_SI: [
    '原管长已保留',
    '旧管长本来以米为单位，画布坐标不参与物理换算。',
    '按实际管长核对管路参数。',
  ],
  NETWORK_FORMAT_UPGRADE: [
    '已建立网络格式副本',
    '旧版物理模型保持原值，没有自动换用新内核。',
    '另存网络工程；运行前核对模型适用条件。',
  ],
  PHYSICAL_PIPES_PRESERVED: [
    '原物理管路已保留',
    '原管路参数和端点顺序保留，未自动插入理想节点或默认容积。',
    '检查管路与连接后另存。',
  ],
  INITIAL_UNKNOWN_PRESERVED: [
    '未声明的动态初态保持未知',
    '旧格式没有声明的速度、腔压和体积模量未补零或教学默认值。',
    '运行前按物理模型补齐必要输入。',
  ],
  ENOENT: [
    '文件或目录不存在',
    '所选源文件或目标上级目录未找到，操作未完成。',
    '确认文件位置；保存时选择已有目录或另存到可用位置。',
  ],
  EACCES: ['没有文件访问权限', '当前进程无权访问所选文件或目录。', '选择有读写权限的位置，保留当前工程后重试。'],
  EPERM: [
    '文件访问被系统拒绝',
    '所选位置的访问权限、保护规则或占用阻止了操作。',
    '检查文件占用和位置，或另存到可写目录。',
  ],
  ENOSPC: ['磁盘空间不足', '目标磁盘没有足够空间完成写入。', '释放空间或选择其他磁盘后另存，当前工程保留。'],
  EEXIST: [
    '目标或保存锁已存在',
    '目标或临时保存锁已被其他操作占用，未覆盖已有内容。',
    '等待相关保存完成，或核对目标后另存副本。',
  ],
  EBUSY: ['文件正在使用', '目标被其他进程占用，本次文件操作未完成。', '关闭占用文件的程序后重试或另存。'],
  FILE_EXTENSION_INVALID: [
    '文件扩展名不匹配',
    '目标文件类型与当前导出格式不一致。',
    '使用保存框提供的当前导出类型及对应扩展名，或另选文件名。',
  ],
  FILE_INVALID: [
    '工程内容格式无效',
    '文件内容或所指字段不符合工程格式，未替换当前工程。',
    '查看下方字段和原始原因，选择有效工程文件；不要把CSV或SVG作为工程打开。',
  ],
  PHYSICAL_STORAGE_REQUIRED: [
    '油口缺少已验证的储油或压力边界',
    '所指油口所在网络尚无当前瞬态模型要求的储油元件或已验证压力边界。',
    '检查所指油口所在网络的实际油液容积、液压缸或压力边界；不猜容积，不以数值接点柔度代替真实物理输入。',
  ],
  GRAPH_INCOMPLETE: [
    '回路连接不完整',
    '存在未连接的油口或缺少必要连接。',
    '检查元件油口和显式分支，补齐连接后重新初始化。',
  ],
  PORT_UNCONNECTED: ['油口尚未连接', '元件的一个必要油口没有接入回路。', '检查该元件及其油口，补齐连接后再计算。'],
  PARAMETER_INVALID: [
    '参数无效',
    '参数缺失、超出允许范围或不满足模型要求。',
    '按参数旁的中文含义和单位填写，应用后重新初始化。',
  ],
  INITIAL_CONDITION_INVALID: [
    '初始条件无效',
    '初始条件不是允许的有限数值或明确的未知值。',
    '检查初始位移、压力和速度；允许未知的量可留空。',
  ],
  RESULT_STATE_CONFLICT: [
    '同源状态与读数冲突',
    '同一有效帧对同一物理量给出不一致数值，结果解释已拒绝。',
    '保留工程和诊断，检查内核变量映射；不能任选一个值继续显示。',
  ],
  RESPONSE_STALE: [
    '结果身份已失效',
    '该响应属于其他会话、修订或较旧控制，未作为当前结果接受。',
    '保留当前工程，检查操作和运行状态；需要时明确重新初始化。',
  ],
  CLOCK_GAP_PAUSED: [
    '计算间隔过长，已保护性暂停',
    '相邻计算间隔超过原有时间预算，间隔没有补算。',
    '检查系统负载后点击运行继续；不要把暂停期间视作已仿真时间。',
  ],
  CLOCK_BUDGET_PAUSED: [
    '推进步数超出预算，已暂停',
    '本次需要推进的步数超过运行预算。',
    '降低演示倍速、检查负载后再点击运行继续。',
  ],
  CLOCK_DOMAIN_EXCEEDED: [
    '原生步长不适用',
    '所选步长不在当前元件集合已验证的范围内。',
    '按元件模型选择允许的原生步长，不会自动降低精度。',
  ],
  MAPPING_REGULARIZED: [
    '当前采用已声明的数值近似',
    '模型含显式数值柔度或约束桥，不能解释成严格理想瞬态。',
    '结合模型假设、逐帧约束预算及已有独立参考使用结果。',
  ],
  MAPPING_CONSTRAINT_EXCEEDED: [
    '数值约束超出预算',
    '当前网络的压力一致性等约束未满足既有预算，运行已隔离。',
    '保留工程和诊断，检查接线、参数及模型适用范围后重新初始化。',
  ],
  RUNTIME_NOT_READY: [
    '当前没有可用仿真',
    '仿真尚未初始化、已经失效或不属于当前物理修订。',
    '检查诊断后明确点击运行初始化，再操作阀位；不会自动恢复失效运行。',
  ],
  RUNTIME_BUSY: ['运行操作尚未结束', '内核正在完成已派发操作，未重复推进。', '等待当前操作完成后再试。'],
  BACKEND_EXITED: [
    '内核进程已退出',
    '运行服务的原生进程意外结束，当前结果已失效。',
    '保留工程与诊断，检查后明确重新初始化。',
  ],
  BACKEND_TIMEOUT: [
    '内核响应超时',
    '原生计算未在既有时间预算内完成，运行已隔离。',
    '检查负载、工程和模型条件后重新初始化，不自动重发控制。',
  ],
  EXPORT_SIZE_LIMIT: [
    '导出内容超过容量限制',
    '完整捕获记录超过既有导出预算，未生成成功文件。',
    '使用较短的记录或另选有效结果；不要把旧成功提示当作本次成功。',
  ],
  FILE_SIZE_LIMIT: [
    '文件超过读写容量限制',
    '所选文件或导出内容超过既有文件服务预算。',
    '使用符合容量的文件或较短记录，原工程保留。',
  ],
  SOURCE_PROTECTED: ['原始文件受到保护', '当前操作会覆盖受保护的工程或迁移源文件。', '选择另一个文件名或另存副本。'],
  VERSION_UNSUPPORTED: [
    '工程版本不支持',
    '文件或请求使用了当前程序不支持的版本。',
    '使用兼容版本；保留原文件，不强行按旧格式打开。',
  ],
  PROJECT_REQUIRES_ADVANCED: [
    '请使用液压进阶工作台',
    '这是v3自由网络工程，教学展示端不支持读取。',
    '从独立启动入口打开液压进阶工作台，再选择原文件；当前工程和原文件保留。',
  ],
  MODEL_UNSUPPORTED: [
    '模型不适用',
    '当前元件或连接超出此计算模型的支持范围。',
    '检查当前模型的支持说明，不用绘图数量推断可计算能力。',
  ],
  MODEL_DOMAIN_EXCEEDED: [
    '运行超出模型支持域',
    '本次原生读数超出已验证范围，运行已隔离，此帧不是有效结果。',
    '检查所指油口/管路、压力基准与实际补油或限压路径；修正副本后明确重新初始化。',
  ],
  PRESSURE_CONTROL_BLOCKED: [
    '限压预检拦截了关阀',
    '关阀后的溢流和内泄能力不足。',
    '保留通流开口，或核对溢流支路的容量。',
  ],
  NATIVE_PORT_PRESSURE_REJECTED: [
    '油口压力超出模型范围',
    '内核在所指油口拒绝了压力或流量计算。',
    '根据计算值核对所指支路的供油、回油和限压条件。',
  ],
  NATIVE_SIMULATION_STOPPED: ['内核停止计算', '内核报告了具体的停止原因。', '根据故障详情核对所指元件和回路。'],
  FILE_CONFLICT: [
    '文件已被其他操作修改',
    '文件内容与保存时捕获的版本不一致，未确认成功。',
    '保留当前设计，核对外部修改后另存副本。',
  ],
});
export function diagnosticPresentation(d: DisplayDiagnostic, object = '当前工程') {
  let entry = Object.hasOwn(problems, d.code) ? problems[d.code] : undefined;
  if (!entry) {
    if (d.severity === 'info') entry = ['模型与工程信息', d.message, d.suggestion ?? '结合模型说明使用当前结果。'];
    else if (d.severity === 'warning')
      entry = ['需要核对的模型或工程条件', d.message, d.suggestion ?? '核对所指对象与模型条件，保留原始说明。'];
    else if (/PARAMETER|INPUT|VALUE|UNIT|RANGE|STATE_INVALID/.test(d.code))
      entry = [
        '输入未通过验证',
        '输入格式、数值范围、单位或初态不满足约定。',
        '检查所指对象和参数单位后重试；不要用零替代未知量。',
      ];
    else if (/CLOCK/.test(d.code))
      entry = [
        '仿真时钟无效',
        '原生时间、固定步号或步长没有通过一致性校验。',
        '保留诊断并检查运行配置，明确重新初始化；时间预算不会自动放宽。',
      ];
    else if (/NATIVE|BACKEND|RUNTIME|COMMUNICATION/.test(d.code))
      entry = ['运行服务失败', '内核、通信或运行资源未能完成有效操作。', '保留工程和诊断，检查后明确重新初始化。'];
    else if (/EXPORT|RECORD|HISTORY/.test(d.code))
      entry = [
        '结果读取或导出失败',
        '所选记录不可用、身份已变化或导出整理未完成。',
        '重新选择有效来源并捕获；失败不会当作导出成功。',
      ];
    else if (/FILE|SAVE|OPEN|PATH|RECOVERY|DRAFT_ACTIVATE/.test(d.code))
      entry = [
        '文件操作失败',
        '文件路径、访问权限、占用或内容未满足读写要求。',
        '检查文件及路径，重试或另存；当前工程和原始文件保留。',
      ];
    else if (/GRAPH|PORT|CONNECTION|REFERENCE|DUPLICATE|MAPPING|MODEL/.test(d.code))
      entry = [
        '回路或模型未通过检查',
        '对象引用、连接或模型适用条件不满足要求。',
        '核对所指元件、油口、分支和模型说明后重试。',
      ];
    else
      entry = ['操作未完成', '当前操作未通过验证，不能作为有效结果使用。', '保留当前内容，查看技术详情并检查后重试。'];
  }
  const [title, defaultCause, defaultRemedy] = entry;
  // Domain rejection carries the measured object, value, basis and failed time.
  // Keep those facts visible instead of replacing them with a generic model error.
  const useOriginal =
    d.code === 'MODEL_DOMAIN_EXCEEDED' ||
    d.code === 'PRESSURE_CONTROL_BLOCKED' ||
    d.code === 'NATIVE_PORT_PRESSURE_REJECTED' ||
    d.code === 'NATIVE_SIMULATION_STOPPED' ||
    d.code === 'INTEGRATED_OIL_MODEL' ||
    ['SESSION_CATALOG_FAILED', 'SESSION_LIMIT', 'SESSION_PATH_INVALID', 'SESSION_RELEASE_WRITE_FAILED'].includes(
      d.code,
    );
  const cause = useOriginal ? d.message : defaultCause;
  const remedy = useOriginal && d.suggestion ? d.suggestion : defaultRemedy;
  return { object, title, cause, remedy, detail: `${d.code}\n${d.field ?? ''}\n${d.message}\n${d.suggestion ?? ''}` };
}

/** The workbench, copy report, and guide examples use the same evidence-first wording. */
export function diagnosticCardPresentation(d: DisplayDiagnostic, object = '当前工程') {
  const presentation = diagnosticPresentation(d, object);
  let headline = object === '当前工程' ? presentation.title : object + ' · ' + presentation.title;
  let fact = d.message.trim() || presentation.cause;
  const supplied = d.suggestion?.trim();
  const advice = supplied === defaultDiagnosticSuggestion ? undefined : supplied;
  let next = advice || presentation.remedy;
  let connectionHelp = false;
  if (d.code === 'GRAPH_INCOMPLETE' && d.field === '/design/components' && fact.includes('空白工程')) {
    headline = '工程中没有可运行的液压回路';
    fact = '当前工程为空，本次仿真未启动。';
    next = '从元件库放置需要的元件，按原理图连线，再点击「运行」。';
  } else if (
    d.code === 'PORT_UNCONNECTED' ||
    (d.code === 'GRAPH_INCOMPLETE' &&
      /^\/design\/components\/[^/]+\/[^/]+$/.test(d.field ?? '') &&
      /油口尚未连接|口尚未接入/.test(fact))
  ) {
    headline = object === '当前工程' ? '有油口未连接' : object + '未连接';
    if (fact.includes('草稿保留但不启动计算')) fact = '本次仿真未启动，当前工程可继续编辑。';
    next =
      advice ||
      (fact.includes('电压信号')
        ? '按控制接线补齐该信号口的输入，再点击「运行」。'
        : '按原理图补齐该油口的连接，再点击「运行」。');
    connectionHelp = true;
  } else if (d.code === 'GRAPH_INCOMPLETE' && /^\/design\/nodes\/[^/]+$/.test(d.field ?? '')) {
    headline = object === '当前工程' ? '有分支节点未连接' : object + '未连接';
    next = advice || '按原理图补齐分支连接，再点击「运行」。';
    connectionHelp = true;
  }
  return { headline, fact, next, connectionHelp };
}

/** Short user-facing labels shared by the diagnostic card and the AI guide. */
export function diagnosticCategory(d: DisplayDiagnostic): string {
  if (d.code === 'GRAPH_INCOMPLETE' || d.code === 'PORT_UNCONNECTED') return '连接问题';
  return diagnosticPresentation(d).title;
}

export function diagnosticReference() {
  return Object.entries(problems).map(([code, [title, , remedy]]) => ({
    code,
    type: diagnosticCategory({ code, message: title }),
    remedy,
  }));
}
export function diagnosticDisplayText(d: DisplayDiagnostic, object?: string): string {
  const p = diagnosticPresentation(d, object);
  return `${p.object}：${p.title}。${p.cause}${p.remedy}`;
}
