import { createApplication, FileController, captureExport, exportCsv, parseExportArtifact } from './modules/application/index.js';
import { fromSI, toSI, specs, componentPorts, positionDisplayName, diagnosticDisplayText, diagnosticPresentation } from './modules/domain/index.js';
import { sizeCylinder } from './modules/engineering/index.js';
import { displayState, displayExport } from './application-bridge.mjs';
import { examples } from './examples.js';
import { diagramGeometry, diagramDefs } from './diagram.mjs';
import { exportSvg } from './export-svg.mjs';
import { decimalInput, circuitViewport } from './view-input.mjs';
(function () {
    'use strict';
    const E = { TYPES: window.HydParameterSpecs.types }, $ = id => document.getElementById(id), esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n, d = 2) => typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
    const id = prefix => prefix.slice(0, 7) + '_' + crypto.randomUUID().replaceAll('-', '');
    const context = () => ({ projectId: id('project'), timestamp: new Date().toISOString(), appVersion: '0.8.0' });
    const created = createApplication(examples.cylinder, id('session'));
    if (!created.ok)
        throw new Error(created.diagnostics[0].message);
    const store = created.value;
    const files = new FileController(store, window.projectFiles, () => id('session'), locked => { document.body.inert = locked; }, reviewMigration, guardInputs);
    let model, state, valves, selected, selectedKind, running, samples, currentResult;
    let pending = null, lastFrame = 0, lastRender = 0, drag = null, sizing = null, toastTimer, recoveryTimer;
    let exportBusy = false, lastExport = null;
    let titleSession = '', titleBaseline = '';
    let propertyKey = '', propertyRevision = -1, propertyBaseline = new Map(), inputGuardPending = false;
    let viewMode = 'fit', viewPlan = null, locatedObject = null, viewAnchorId = null, viewSelection = null, valveHintShown = false, placement = null;
    const bounds = window.HydParameterSpecs.bounds;
    const labels = window.HydParameterSpecs.labels;
    const info = { tank: '油箱表压，以大气压为零。', pump: '排量、转速与效率决定流量；压力由回路工作点决定。', relief: '开启差压；泵出口另含支路管损。', valve: '内置 O/M；初始阀位与运行换位分开。', cylinder: '双向正阻力负载；准静态试算，不含负负载下滑。', motor: '连续回转马达；集中容积/机械效率。', wire: '管长取物理参数，不取屏幕折线长度。' };
    function diagnosticObject(d) {
        const c = model?.components.find(c => c.id === d.componentId || (d.field || '').split('/').includes(c.id) || d.message?.includes(c.id + ':'));
        return c?.label || '当前工程';
    }
    function problemText(items) {
        const target = $('technicalDiagnostics');
        if (target && items.length) target.innerHTML = items.map(d => '<details><summary>最近诊断的技术详情（可复制）</summary><pre>' + esc(diagnosticPresentation(d, diagnosticObject(d)).detail) + '</pre></details>').join('');
        return items.map(d => diagnosticDisplayText(d, diagnosticObject(d))).join('；');
    }
    const endpointName = text => { const [id, port] = text.split(':'); return (model?.components.find(c => c.id === id)?.label || '元件') + ' ' + port + ' 口'; };
    function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
    function sync() { const s = store.snapshot(), v = displayState(s); ({ model, state, valves, running, samples } = v); currentResult = v.result; selected = s.editor.selection?.id || null; selectedKind = s.editor.selection?.kind === 'connection' ? 'wire' : 'component'; }
    function saveLocal() {
        clearTimeout(recoveryTimer);
        void files.checkpoint().then(reply => {
            reportFileFailure(reply);
            $('recoveryStatus').textContent = ({ idle: '恢复未写入', saved: '恢复检查已完成', deferred: '恢复副本等待限频后更新', error: '恢复失败：请手动保存工程' })[files.snapshot().recoveryStatus];
            if (reply.status === 'ok' && reply.deferred) recoveryTimer = setTimeout(saveLocal, reply.retryAfterMs ?? 1000);
        });
    }
    function reportFileFailure(reply) {
        if (reply.status === 'error') toast(problemText(reply.diagnostics));
        if (reply.status === 'ok' && reply.warnings?.length) toast(problemText(reply.warnings));
        return reply.status === 'ok';
    }
    async function updateFileLists() {
        reportFileFailure(await files.catalog());
        for (const [element, entries, title] of [['recentFiles', files.snapshot().recent, '最近工程…'], ['recoveryFiles', files.snapshot().recoveries, '恢复副本…']]) {
            $(element).replaceChildren(new Option(title, ''));
            for (const entry of entries) $(element).add(new Option(entry.title + (entry.diagnostics.length ? '（读取异常）' : ''), entry.reference));
        }
    }
    async function fileAction(action) {
        endDrag(true);
        if (!await guardInputs()) return { status: 'cancelled' };
        $('fileMenu').hidePopover();
        $('fileOutcome').textContent = '正在处理文件…';
        for (const id of ['saveBtn','saveAsBtn','importBtn','newBtn']) $(id).disabled = true;
        const reply = await action();
        for (const id of ['saveBtn','saveAsBtn','importBtn','newBtn']) $(id).disabled = false;
        $('fileOutcome').dataset.error = String(reply.status === 'error');
        $('fileOutcome').textContent = reply.status === 'cancelled' ? '已取消，当前工程保留'
          : reply.status === 'error' ? '文件操作失败：' + problemText(reply.diagnostics)
          : files.snapshot().path ? (store.snapshot().dirty ? '已保存上一版本，仍有新修改' : '已保存 / 已加载：' + files.snapshot().path) : '操作完成，尚未另存';
        if (reply.status === 'error') $('fileMenu').showPopover();
        if (reportFileFailure(reply)) {
            pending = null; lastFrame = 0;
            $('migrationNotice').textContent = reply.migration?.length
                ? '迁移说明：' + problemText(reply.migration) : '';
            if (reply.requiresSaveAs) toast('已载入副本，需另存；原文件保留。');
            renderAll();
            await files.checkpoint();
            await updateFileLists();
        } else renderAll();
        return reply;
    }
    async function reviewMigration(candidate) {
        if (!candidate.migration?.length) return true;
        const dialog = $('migrationDialog');
        $('migrationSummary').textContent = '来源：' + (candidate.path || '旧工程') + '\n原文件保留；载入后必须另存。\n' + candidate.migration.map(d => d.message).join('\n');
        return new Promise(resolve => {
            const finish = accepted => { dialog.close(); dialog.oncancel = null; resolve(accepted); };
            $('migrationAccept').onclick = () => finish(true); $('migrationCancel').onclick = () => finish(false);
            dialog.oncancel = e => { e.preventDefault(); finish(false); }; dialog.showModal(); $('migrationCancel').focus();
        });
    }
    function feedback(result) { if (!result.ok) {
        toast(problemText(result.diagnostics));
        return false;
    } return true; }
    function execute(command) { const before = store.snapshot().physicsRevision, r = store.execute(command); if (!feedback(r))
        return r; if (r.value.changed) {
        if (before !== store.snapshot().physicsRevision)
            lastFrame = 0;
        pending = null;
        saveLocal();
    } renderAll(); return r; }
    function pause() { store.pause(); sync(); $('runBtn').textContent = '▶ 运行'; $('board').classList.remove('running'); }
    async function setExample(kind) { const document = examples[kind]; if (document) await fileAction(() => files.replace(document)); }
    function renderBoard(r) {
        const active = document.activeElement;
        const focusPort = active?.dataset.port, focusComponent = active?.dataset.component;
        const defs = diagramDefs;
        const { route, symbol } = diagramGeometry({ model, state, valves }, { pending, selected, selectedKind });
        const wires = model.wires.map(w => { const v = r.ok ? r.wireValues[w.id] : null, q = v?.flow || 0; let color = '#a8b3bf'; if (Math.abs(q) > 1e-6)
            color = v.pressureSide ? '#d45e4f' : '#297ac7'; const path = route(w); return `<g data-wire="${w.id}"><path class="wire-hit" d="${path}"/><path class="wire ${selected === w.id && selectedKind === 'wire' ? 'selected' : ''}" d="${path}" stroke="${color}"/>${Math.abs(q) > 1e-6 ? `<path class="flow-dashes" style="animation-direction:${q < 0 ? 'reverse' : 'normal'}" d="${path}"/>` : ''}</g>`; }).join('');
        $('board').innerHTML = defs + wires + model.components.map(c => symbol(c, r)).join('') + (model.components.length ? '' : '<text class="board-empty" x="500" y="260" text-anchor="middle">从左侧拖入元件，开始连接一个基础回路</text><text class="board-empty" x="500" y="300" text-anchor="middle" style="font-size:13px">也可以从「加载示例」开始</text>');
        if (focusPort) [...$('board').querySelectorAll('[data-port]')].find(e => e.dataset.port === focusPort)?.focus({ preventScroll: true });
        else if (focusComponent) [...$('board').querySelectorAll('[data-component]')].find(e => e.dataset.component === focusComponent)?.focus({ preventScroll: true });
        if (viewPlan) updateHitAreas();
        $('connectionCount').textContent = `${model.components.length} 个元件 / ${model.wires.length} 条管线`;
        $('connectionHint').textContent = pending ? '已选择 ' + endpointName(pending) + '，请点击目标油口（Esc 取消）' : '拖动元件调整位置，点击蓝色油口连接';
        $('board').classList.toggle('running', running);
    }
    const kv = (label, value) => `<div class="kv"><span>${label}</span><b>${value}</b></div>`;
    function propertyInputs() { return [...$('propertyBody').querySelectorAll('input,select')]; }
    function hasInputBuffer() { return $('projectName').value !== store.snapshot().document.title || propertyInputs().some(input => propertyBaseline.has(input) && input.value !== propertyBaseline.get(input)); }
    function rememberProperties() {
        propertyBaseline = new Map(propertyInputs().map(input => [input, input.value]));
        $('inputErrors').textContent = '';
        for (const input of propertyInputs()) input.removeAttribute('aria-invalid');
    }
    function cancelProperties() {
        $('projectName').value = store.snapshot().document.title; $('projectName').removeAttribute('aria-invalid');
        for (const [input, value] of propertyBaseline) { input.value = value; input.removeAttribute('aria-invalid'); }
        $('inputErrors').textContent = ''; updateBufferStatus();
    }
    function updateBufferStatus() {
        $('bufferStatus').textContent = hasInputBuffer() ? '有未应用输入；物理修改应用后暂停并复位' : '物理修改应用后暂停并复位';
    }
    function inputFailure(input, message) {
        input.setAttribute('aria-invalid', 'true'); $('inputErrors').textContent = '⚠ ' + message;
        (input.closest('label') || input).scrollIntoView({ block: 'nearest' }); input.focus({ preventScroll: true }); return false;
    }
    function applyProperties() {
        const commands = [];
        if ($('projectName').value !== store.snapshot().document.title) commands.push({ type: 'set-title', value: $('projectName').value.trim() });
        for (const input of propertyInputs()) {
            input.removeAttribute('aria-invalid');
            if (!propertyBaseline.has(input) || input.value === propertyBaseline.get(input)) continue;
            if (input.id === 'componentLabel') { commands.push({ type: 'set-label', id: selected, value: input.value.trim() }); continue; }
            if (input.id === 'valveCenter') { commands.push({ type: 'set-definition', id: selected, definitionId: input.value === 'closed' ? 'builtin:valve-o' : 'builtin:valve-m' }); continue; }
            if (input.id === 'initialValve') { commands.push({ type: 'set-initial', id: selected, initial: { positionId: input.value } }); continue; }
            const parsed = decimalInput(input.value);
            if (!parsed.ok) return inputFailure(input, parsed.message);
            const component = model.components.find(c => c.id === selected);
            if (input.id === 'initialValue') {
                commands.push({ type: 'set-initial', id: selected, initial: component.type === 'cylinder'
                  ? { positionM: toSI('length', parsed.value) } : { angleRad: toSI('angle', parsed.value) } }); continue;
            }
            const fluid = input.dataset.fluid, group = fluid ? 'fluid' : selectedKind === 'wire' ? 'pipe' : component.type;
            const spec = specs(group).find(spec => spec.legacyKey === (fluid || input.dataset.param));
            commands.push({ type: 'set-parameter', target: fluid ? 'fluid' : selectedKind === 'wire' ? 'connection' : 'component',
                ...(fluid ? {} : { id: selected }), key: spec.key, value: toSI(spec.quantity, parsed.value) });
        }
        if (!commands.length) return true;
        const before = store.snapshot().physicsRevision, result = store.execute({ type: 'apply-properties', commands });
        if (!result.ok) {
            const d = result.diagnostics[0];
            const match = specs(selectedKind === 'wire' ? 'pipe' : model.components.find(c => c.id === selected)?.type || 'fluid').find(spec => d.field?.includes(spec.key));
            const input = d.field?.includes('title') ? $('projectName') : match ? $('inspector').querySelector('[data-param="' + match.legacyKey + '"]') : propertyInputs().find(i => i.value !== propertyBaseline.get(i));
            if (input) return inputFailure(input, result.diagnostics.map(d => d.message).join('；'));
            $('inputErrors').textContent = result.diagnostics.map(d => d.message).join('；'); return false;
        }
        propertyKey = ''; propertyBaseline.clear();
        $('projectName').value = store.snapshot().document.title; $('projectName').removeAttribute('aria-invalid');
        if (before !== store.snapshot().physicsRevision) lastFrame = 0;
        if (result.value.changed) saveLocal();
        renderAll(); return true;
    }
    async function guardInputs() {
        if (!hasInputBuffer()) return true;
        if (inputGuardPending) return false;
        inputGuardPending = true;
        const dialog = $('bufferDialog'), trigger = document.activeElement;
        const choice = await new Promise(resolve => {
            const finish = value => { dialog.close(); dialog.oncancel = null; resolve(value); };
            $('bufferApply').onclick = () => finish('apply'); $('bufferDiscard').onclick = () => finish('discard');
            $('bufferContinue').onclick = () => finish('continue'); dialog.oncancel = e => { e.preventDefault(); finish('continue'); };
            dialog.showModal(); $('bufferContinue').focus();
        });
        inputGuardPending = false;
        if (choice === 'apply') return applyProperties();
        if (choice === 'discard') { cancelProperties(); return true; }
        trigger?.focus(); return false;
    }
    function renderInspector() {
        const snap = store.snapshot(), key = snap.documentSessionId + ':' + selectedKind + ':' + selected;
        if (key === propertyKey && (propertyRevision === snap.documentRevision || hasInputBuffer())) return;
        propertyKey = key; propertyRevision = snap.documentRevision;
        $('density').value = model.fluid.density; $('viscosity').value = model.fluid.viscosity;
        $('propertyTitle').textContent = selected ? '属性 · ' + selected : '工程油液属性';
        const c = selectedKind === 'component' ? model.components.find(c => c.id === selected) : model.wires.find(w => w.id === selected);
        if (!c) {
            $('inspector').innerHTML = '<div class="hint">点击画布上的元件或管线，在这里查看和修改参数。</div>';
            rememberProperties(); return;
        }
        const type = selectedKind === 'wire' ? 'wire' : c.type;
        let html = `<h3>${esc(type === 'wire' ? '液压管线' : c.label)}</h3><details class="tag"><summary>对象技术详情</summary><pre>${esc(c.id)}${type === 'wire' ? ' · ' + esc(c.from) + ' ↔ ' + esc(c.to) : ''}</pre></details>`;
        if (type !== 'wire')
            html += `<label>元件名称<input id="componentLabel" value="${esc(c.label)}" maxlength="60"></label>`;
        if (type === 'valve')
            html += `<label>中位机能<select id="valveCenter"><option value="closed" ${c.center === 'closed' ? 'selected' : ''}>O 型：P/T/A/B 全封闭</option><option value="tandem" ${c.center !== 'closed' ? 'selected' : ''}>M 型：P→T，A/B 封闭</option></select></label>`;
        const initial = store.snapshot().document.design.initialConditions;
        if (type === 'cylinder')
            html += '<label>初始缸位 / mm<input id="initialValue" type="text" inputmode="decimal" value="' + fromSI('length', initial.actuators.find(a => a.componentId === c.id).positionM) + '"></label>';
        if (type === 'motor')
            html += '<label>初始转角 / °<input id="initialValue" type="text" inputmode="decimal" value="' + fromSI('angle', initial.actuators.find(a => a.componentId === c.id).angleRad) + '"></label>';
        if (type === 'valve')
            html += '<p id="valveInstanceStatus" class="notice" aria-live="polite"></p><label>实例初始阀位<select id="initialValve">' + ['extend', 'neutral', 'retract'].map(p => '<option value="' + p + '" ' + (initial.valves.find(v => v.componentId === c.id).positionId === p ? 'selected' : '') + '>' + positionDisplayName(p) + '</option>').join('') + '</select></label>';
        for (const [key, value] of Object.entries(c.params)) {
            const spec = labels[key], b = bounds[key];
            if (!spec || !b)
                continue;
            html += `<label>${spec[0]}<span>${spec[1]}</span><input data-param="${key}" type="text" inputmode="decimal" value="${value}" min="${b[0]}" max="${b[1]}" aria-description="范围 ${b[0]} 至 ${b[1]} ${spec[1]}"></label>`;
        }
        html += `<p class="param-hint">${info[type]}</p>`;
        if (type === 'cylinder')
            html += '<button id="sizeFromInspector" class="full">按负载与速度初选</button>';
        $('inspector').innerHTML = html;
        $('sizeFromInspector')?.addEventListener('click', openSizing);
        rememberProperties();
    }
    function renderValues(r) {
        $('clock').textContent = 't = ' + fmt(state.time, 2) + ' s';
        $('canvasTitle').textContent = running ? '运行中 · 在上方控制条换位' : '暂停 · 当前静态预览（非轨迹）';
        const hasCyl = r.actuatorType === 'cylinder' || (!r.ok && model.components.some(c => c.type === 'cylinder'));
        const items = [['泵出口压力', r.pressure, 'MPa', r.ok ? r.status : '检查元件与连线'], ['执行器进油流量', r.q, 'L/min', '泵总流量 ' + fmt(r.Q) + ' L/min'], [hasCyl ? '活塞位置' : '马达转速', hasCyl ? state.position : r.rpm, hasCyl ? 'mm' : 'r/min', hasCyl ? '速度 ' + fmt(r.speed, 1) + ' mm/s' : '转矩 ' + fmt(r.torque, 1) + ' N·m'], ['泵输入轴功率', r.shaftPower, 'kW', '包含泵效率和管路损失']];
        $('metrics').innerHTML = items.map(([label, val, unit, detail]) => `<div class="metric"><label>${label}</label><div class="value">${r.ok ? fmt(val, val > 999 ? 0 : 2) : '—'}<span class="unit">${unit}</span></div><small>${r.ok ? esc(detail) : '尚无有效结果'}</small></div>`).join('');
        if (!r.ok) {
            $('status').className = 'status error';
            $('status').textContent = '⚠ ' + r.errors.join('；');
            $('liveDetails').innerHTML = '';
            if (pending) $('status').textContent = '待连接：' + endpointName(pending) + '，请选择目标油口；Esc取消';
            return;
        }
        const warn = /溢流|压力受限/.test(r.status);
        $('status').className = 'status' + (warn ? ' warn' : '');
        $('status').textContent = (running ? '● 运行中' : '○ 已暂停 · 下列数值为当前阀位计算') + '  /  ' + r.status;
        if (pending) $('status').textContent = '待连接：' + endpointName(pending) + '，请选择目标油口；Esc取消';
        let html = '<h4>当前计算</h4>' + kv('执行器 A 口', fmt(r.pA) + ' MPa') + kv('执行器 B 口', fmt(r.pB) + ' MPa') + kv('回油流量', fmt(r.returnFlow) + ' L/min') + kv('溢流支路流量', fmt(r.bypassFlow) + ' L/min') + kv(hasCyl ? '有效推力（当前方向）' : '有效转矩', hasCyl ? fmt(r.force) + ' kN' : fmt(r.torque) + ' N·m') + kv('估计损耗功率', fmt(r.lossPower) + ' kW');
        if (r.mode === 'neutral')
            html += '<p class="notice">中位封闭腔压力及保持力/转矩未求解，— 不是零保持能力。</p>';
        if (selectedKind === 'wire' && r.wireValues[selected]) {
            const v = r.wireValues[selected];
            html += '<h4>选中管线</h4>' + kv('流量', fmt(v.q) + ' L/min') + kv('流速', fmt(v.v) + ' m/s') + kv('雷诺数 Re', fmt(v.Re, 0)) + kv('流态', v.regime) + kv('管线压降', fmt(v.dp, 4) + ' MPa');
        }
        if (model.note)
            html += '<p class="notice">' + esc(model.note) + '</p>';
        for (const warning of r.warnings)
            html += '<p class="notice">' + esc(warning) + '</p>';
        for (const d of r.diagnostics || [])
            if (d.severity !== 'warning')
                html += '<p class="notice">' + esc(diagnosticDisplayText(d, diagnosticObject(d))) + '</p>';
        $('liveDetails').innerHTML = html;
    }
    function plotHistory() { return store.snapshot().historicalRuns.find(run => 'history:' + run.runId === $('plotSource').value); }
    function renderPlot() {
        const history = plotHistory();
        const plotSamples = history ? displayState({ document: history.document, editor: { selection: null, drag: null }, runtime: {
            identity: history.preview.identity, lastStep: history.lastStep,
            state: history.preview.state, controls: history.controls, result: history.result, running: false, samples: history.samples,
        } }).samples : samples;
        $('plot').dataset.history = String(!!history);
        const key = $('plotMetric').value, unit = { pressure: 'MPa', position: 'mm', q: 'L/min', rpm: 'r/min' }[key], list = plotSamples.slice(-900).filter(s => Number.isFinite(s[key])), W = 850, H = 145, L = 62, R = 16, T = 15, B = 30;
        let html = `<line class="plot-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><text class="plot-label" x="${W - 90}" y="17">${unit}</text><text class="plot-label" x="${W - 18}" y="${H - 6}" text-anchor="end">时间 / s</text>`;
        if (list.length < 2) {
            html += `<text class="plot-label" x="440" y="65" text-anchor="middle">${history ? '该历史变量不足两个已知样本，未绘线' : '当前变量不足两个已知样本，运行后记录曲线'}</text>`;
            $('plot').innerHTML = html;
            return;
        }
        const minX = list[0].time, maxX = Math.max(minX + 1, list.at(-1).time), values = list.map(d => d[key] || 0), low = Math.min(0, ...values), high = Math.max(1, ...values) * 1.1;
        const x = v => L + (v - minX) / (maxX - minX) * (W - L - R), y = v => H - B - (v - low) / (high - low) * (H - T - B);
        for (let i = 0; i <= 3; i++) {
            const v = low + (high - low) * i / 3, yy = y(v);
            html += `<line class="plot-axis" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text class="plot-label" x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmt(v, 1)}</text>`;
        }
        for (let i = 0; i < 4; i++) {
            const v = minX + (maxX - minX) * i / 3;
            html += `<text class="plot-label" x="${x(v)}" y="${H - 12}" text-anchor="middle">${fmt(v, 1)}</text>`;
        }
        html += '<path class="plot-line" d="' + list.map((d, i) => (i ? 'L' : 'M') + fmt(x(d.time), 2) + ' ' + fmt(y(d[key] || 0), 2)).join(' ') + '"/>';
        $('plot').innerHTML = html;
    }
    function renderRecordStatus() {
        const s = store.snapshot(), timing = s.runtime.simulation;
        const options = [['current', '当前运行（实线）'], ...s.historicalRuns.filter(run => run.samples.length).map((run, i) => ['history:' + run.runId, '修改前结果 · ' + run.document.title + ' · 历史 ' + (i + 1)])];
        if ($('plotSource').dataset.options !== JSON.stringify(options)) {
            const previous = $('plotSource').value; $('plotSource').replaceChildren(...options.map(([key, text]) => new Option(text, key)));
            $('plotSource').value = options.some(([key]) => key === previous) ? previous : 'current'; $('plotSource').dataset.options = JSON.stringify(options);
        }
        const history = plotHistory();
        $('plotSourceStatus').textContent = history ? '修改前结果（虚线） · 原工程：' + history.document.title + ' · 固定步长 ' + history.config.stepSeconds + ' s' + (history.truncated ? ' · 记录已截断' : '') + '；图示末900条，原输入见记录页，不代表当前结果。'
          : (s.runtime.result.ok ? '当前成功运行样本；静态预览不追加轨迹' : '⚠ 当前结果不可用；曲线止于最后有效样本，不表示本次求解成功。请查看诊断。');
        $('recordStatus').textContent = '当前记录 ' + s.runtime.samples.length +
            ' · 固定步长 ' + timing.config.stepSeconds + 's · 采样 ' + timing.sampleIntervalSeconds + 's' +
            (s.runtime.truncated ? ' · 已截断 ' + timing.samplesDropped + ' 条' : '') +
            (timing.eventsTruncated ? ' · 控制日志已截断' : '') + ' · 历史 ' + s.historicalRuns.length + ' 组';
        $('recordStatus').title = '历史不属于当前结果；单步每步记录，运行每5个计算步记录。' +
            problemText(timing.diagnostics);
        $('simulationStatus').textContent = problemText(timing.diagnostics) ||
            '准静态动作演示 · 失焦暂停 · 恢复不补追时间';
    }
    function renderAll() { renderExportSource();
        sync();
        const s = store.snapshot();
        if (selected !== viewSelection && selected) viewAnchorId = selected;
        viewSelection = selected;
        if (titleSession !== s.documentSessionId) { viewAnchorId = null; locatedObject = null; viewMode = 'fit'; }
        if (titleSession !== s.documentSessionId || $('projectName').value === titleBaseline) $('projectName').value = model.name;
        titleSession = s.documentSessionId; titleBaseline = model.name;

        $('undoBtn').disabled = !s.history.undoCount;
        $('redoBtn').disabled = !s.history.redoCount;
        $('deleteBtn').disabled = !selected;
        $('runBtn').textContent = running ? 'Ⅱ 暂停' : '▶ 运行';
        $('dirtyStatus').textContent = s.dirty ? '未保存' : '已保存 / 已加载';
        $('dirtyStatus').dataset.dirty = String(s.dirty);
        $('fileStatus').textContent = files.snapshot().path || '未绑定正式文件 · 示例/迁移/恢复需另存';
        renderRecordStatus();
        renderBoard(currentResult);
        renderInspector();
        renderValues(currentResult);
        renderPlot();
        renderView(); renderControlStatus(); renderNavigation(); updateBufferStatus();
        if (model.components.some(c => c.x < 60 || c.x > 940 || c.y < 65 || c.y > 540))
            $('connectionHint').textContent += ' · 部分坐标超出当前视口，原坐标已保留';
    }
    function controlValve() {
        const candidates = model.components.filter(c => c.type === 'valve');
        return candidates.find(c => selectedKind === 'component' && c.id === selected)
            ?? (candidates.length === 1 ? candidates[0] : null);
    }
    function chooseMode(positionId) { const valve = controlValve(); if (!valve) {
        toast('请先选中要操作的换向阀');
        return;
    } pending = null; if (feedback(store.setControl(valve.id, positionId)))
        renderAll(); }
    function add(type, x = 430, y = 200) { const newId = id(type); const result = execute({ type: 'add-component', id: newId, typeId: type, x: x, y }); if (result.ok) {
        store.select({ kind: 'component', id: newId });
        renderAll();
    } }
    async function remove() { if (selected && await guardInputs())
        execute({ type: 'delete', id: selected, target: selectedKind === 'wire' ? 'connection' : 'component' }); }
    function connect(port) {
        if (pending === port) {
            pending = null;
            renderAll();
            return;
        }
        if (!pending) {
            pending = port;
            renderAll();
            return;
        }
        const endpoint = text => { const [componentId, portId] = text.split(':'); return { componentId, portId }; };
        if (pending.split(':')[0] === port.split(':')[0]) {
            toast('请选择另一个元件的油口');
            return;
        }
        if (hasInputBuffer()) { toast('请先应用或取消属性输入，再编辑连接'); return; }
        const newId = id('wire');
        const result = execute({ type: 'add-connection', id: newId, from: endpoint(pending), to: endpoint(port) });
        pending = null;
        if (result.ok)
            store.select({ kind: 'connection', id: newId });
        renderAll();
    }
    function point(ev) { const svg = $('board'), p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); }
    // Fitted drawings can be smaller than their scroll viewport. Blank margins
    // are still part of the placement surface; world coordinates use the same CTM.
    $('boardScroll').addEventListener('pointerdown', e => {
        if (e.target !== $('boardScroll')) return;
        if (placement) {
            const p = point(e), type = placement; placement = null; add(type, p.x, p.y);
        } else void guardInputs().then(ok => { if (ok) { store.select(null); pending = null; renderAll(); } });
    });
    $('board').addEventListener('pointerdown', e => {
        if (placement) { const p = point(e), type = placement; placement = null; add(type, p.x, p.y); return; }
        const p = e.target.closest('[data-port]'), sw = e.target.closest('[data-switch]');
        if (p) {
            e.stopPropagation();
            connect(p.dataset.port);
            return;
        }
        if (sw && !valveHintShown) { valveHintShown = true; toast('点击阀方格仅选中；请在上方控制条切换该阀位。'); }
        const cg = e.target.closest('[data-component]'), wg = e.target.closest('[data-wire]');
        if (hasInputBuffer() && (cg?.dataset.component || wg?.dataset.wire || null) !== selected) {
            void guardInputs().then(ok => { if (ok) { store.select(cg ? { kind: 'component', id: cg.dataset.component } : wg ? { kind: 'connection', id: wg.dataset.wire } : null); renderAll(); } }); return;
        }
        if (cg) {
            const c = model.components.find(c => c.id === cg.dataset.component), pos = point(e);
            if (!feedback(store.beginDrag(c.id)))
                return;
            drag = { id: c.id, x: pos.x, y: pos.y, cx: c.x, cy: c.y, pointerId: e.pointerId, moved: false };
            $('board').setPointerCapture(e.pointerId);
            renderAll();
        }
        else {
            store.select(wg ? { kind: 'connection', id: wg.dataset.wire } : null);
            pending = null;
            renderAll();
        }
    });
    $('board').addEventListener('pointermove', e => {
        if (placement) {
            const p = point(e); $('board').querySelector('.placement-preview')?.remove();
            $('board').insertAdjacentHTML('beforeend', '<g class="placement-preview" pointer-events="none" transform="translate(' + p.x + ',' + p.y + ')"><rect x="-40" y="-24" width="80" height="48" fill="white" stroke="#175CD3" stroke-dasharray="5 4"/><text text-anchor="middle" y="5">' + esc(E.TYPES[placement].name) + '</text></g>'); return;
        }
        if (!drag) return;
        const p = point(e);
        if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < 3)
            return;
        drag.moved = true;
        store.previewDrag(Math.round((drag.cx + p.x - drag.x) / 5) * 5, Math.round((drag.cy + p.y - drag.y) / 5) * 5);
        sync();
        renderBoard(currentResult);
    });
    function endDrag(cancel) { if (!drag)
        return; const pointerId = drag.pointerId; drag = null; if (cancel)
        store.cancelDrag();
    else {
        const result = store.commitDrag();
        if (feedback(result) && result.value.changed)
            saveLocal();
    } if ($('board').hasPointerCapture(pointerId))
        $('board').releasePointerCapture(pointerId); renderAll(); }
    $('board').addEventListener('pointerup', () => endDrag(false));
    for (const event of ['pointercancel', 'lostpointercapture'])
        $('board').addEventListener(event, () => endDrag(true));
    function suspend(reason) { placement = null; endDrag(true); store.suspend(reason); lastFrame = 0; renderAll(); }
    window.addEventListener('blur', () => suspend('blur'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend('hidden'); });
    $('board').addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ')
        return; const p = e.target.closest('[data-port]'), s = e.target.closest('[data-switch]'); if (p) {
        e.preventDefault();
        connect(p.dataset.port);
    } if (s) {
        e.preventDefault();
        store.select({ kind: 'component', id: s.closest('[data-component]').dataset.component }); renderAll(); showPage('properties');
    } });
    $('boardScroll').addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    $('boardScroll').addEventListener('drop', e => { e.preventDefault(); const type = e.dataTransfer.getData('text/plain'); if (E.TYPES[type]) {
        const p = point(e);
        add(type, p.x, p.y);
    } });
    const glyph = { tank: '⊔', pump: '↑', relief: '↧', valve: '⇄', cylinder: '⊣', motor: '↻' }, sub = { tank: '回油 / 吸油', pump: '排量 · 转速', relief: '限制系统压力', valve: '左位 / 中位 / 右位', cylinder: '伸出 / 缩回', motor: '正转 / 反转' };
    $('palette').innerHTML = Object.entries(E.TYPES).map(([type, t]) => '<button class="palette-item" data-type="' + type + '" draggable="true"><span class="mini">' + glyph[type] + '</span><span>' + t.name + '<small>' + sub[type] + '</small></span></button>').join('');
    document.querySelectorAll('[data-type]').forEach(b => { b.addEventListener('click', async () => { if (!await guardInputs()) return; placement = b.dataset.type; $('addMenu').hidePopover(); showPage('circuit'); toast('请点击画布放置' + E.TYPES[placement].name + '；Esc取消'); }); b.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', b.dataset.type)); });
    document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => chooseMode(b.dataset.mode)));
    $('runBtn').addEventListener('click', () => { if (store.snapshot().runtime.running)
        pause();
    else if (feedback(store.start()))
        lastFrame = 0; else showPage('diagnostics'); renderAll(); });
    $('resetBtn').addEventListener('click', () => { store.reset(); lastFrame = 0; renderAll(); });
    $('stepBtn').addEventListener('click', () => { feedback(store.singleStep()); lastFrame = 0; renderAll(); });
    $('stepBtn').title = '推进一个固定步长：0.01 s；准静态动作演示';
    // Calculation is driven by a monotonic timer; display frames never advance physics or sample.
    setInterval(() => {
        const now = performance.now();
        if (store.snapshot().runtime.running && lastFrame) {
            const result = store.advanceTime((now - lastFrame) / 1000, Number($('timeScale').value));
            if (!feedback(result)) renderAll();
        }
        lastFrame = store.snapshot().runtime.running ? now : 0;
    }, 10);
    function renderFrame(now) {
        if (store.snapshot().runtime.running && now - lastRender > 80) {
            sync(); renderBoard(currentResult); renderValues(currentResult); renderPlot(); renderRecordStatus(); renderControlStatus(); renderExportSource();
            lastRender = now;
        }
        requestAnimationFrame(renderFrame);
    }
    requestAnimationFrame(renderFrame);
    async function historyAction(action) { if (!await guardInputs()) return; endDrag(true); const physics = store.snapshot().physicsRevision, result = store[action](); if (feedback(result) && result.value.changed) {
        if (store.snapshot().physicsRevision !== physics)
            lastFrame = 0;
        saveLocal();
    } renderAll(); }
    $('undoBtn').addEventListener('click', () => historyAction('undo'));
    $('redoBtn').addEventListener('click', () => historyAction('redo'));
    $('deleteBtn').addEventListener('click', remove);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') {
        placement = null; endDrag(true);
        pending = null;
        if (!e.target.closest('input,textarea,select,dialog') && document.body.dataset.page !== 'circuit') showPage('circuit');
        return;
    } if (e.target.matches('input,textarea,select'))
        return; if (e.key === 'Delete' && e.target.closest('#board,#objectList'))
        void remove(); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        historyAction('undo');
    } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        historyAction('redo');
    } });
    $('projectName').addEventListener('change', e => { const result = execute({ type: 'set-title', value: e.target.value.trim() }); if (result.ok) { e.target.value = store.snapshot().document.title; e.target.removeAttribute('aria-invalid'); } else e.target.setAttribute('aria-invalid','true'); });
    $('exampleSelect').addEventListener('change', e => { if (e.target.value)
        setExample(e.target.value); e.target.value = ''; });
    for (const key of ['density', 'viscosity']) { $(key).min = bounds[key][0]; $(key).max = bounds[key][1]; }
    $('plotMetric').addEventListener('change', renderPlot);
    $('plotSource').addEventListener('change', () => { renderPlot(); renderRecordStatus(); });
    $('saveBtn').addEventListener('click', () => fileAction(() => files.save()));
    $('saveAsBtn').addEventListener('click', () => fileAction(() => files.save(true)));
    $('importBtn').addEventListener('click', () => fileAction(() => files.open()));
    $('newBtn').addEventListener('click', () => { const c = context(); void fileAction(() => files.replace({ ...examples.blank,
        projectId: c.projectId, createdAt: c.timestamp, updatedAt: c.timestamp,
        provenance: { ...examples.blank.provenance, createdWithAppVersion: c.appVersion } })); });
    for (const element of ['recentFiles', 'recoveryFiles']) $(element).addEventListener('change', e => {
        const reference = e.target.value; if (reference) void fileAction(() => files.open(reference)); e.target.value = '';
    });
    $('deleteRecoveryBtn').addEventListener('click', async () => {
        const entries = files.snapshot().recoveries;
        if (entries[0]) { reportFileFailure(await files.removeRecovery(entries[0].reference)); await updateFileLists(); }
    });

    function renderExportSource() {
        const select = $('exportSource'), previous = select.value || 'preview', snapshot = store.snapshot();
        const entries = [['preview', '当前静态预览'], ['current-run', '当前轨迹末步'], ['diagram', '纯图（无结果）'],
          ...snapshot.historicalRuns.filter(run => run.lastStep).map((run, i) => ['history:' + run.runId, '历史运行 ' + (i + 1) + ' · ' + run.document.title])];
        if (JSON.stringify(entries) !== select.dataset.entries) {
            select.replaceChildren(...entries.map(([value, title]) => new Option(title, value)));
            select.dataset.entries = JSON.stringify(entries);
            select.value = entries.some(([value]) => value === previous) ? previous : 'preview';
        }
        const old = snapshot.historicalRuns.find(run => 'history:' + run.runId === select.value);
        const point = old?.lastStep ?? (select.value === 'current-run' ? snapshot.runtime.lastStep : null);
        $('exportStatus').textContent = select.value === 'diagram' ? '纯图不包含运行结果'
          : select.value === 'preview' ? '静态预览，不计入轨迹；导出当前已提交输入和控制'
          : point ? (old ? '历史：' + old.document.title : '当前轨迹') + ' · 计算步 ' + point.state.tick + ' · ' + point.state.timeS + ' s'
            + (point.result.ok ? ' · 泵压 ' + fmt(fromSI('pressure', point.result.value.pumpGaugePressurePa)) + ' MPa · 执行器流量 '
              + fmt(fromSI('flow', point.result.value.actuatorFlowM3PerS)) + ' L/min' : ' · 结果不可用') + '（含采样/截断说明）'
          : '尚无成功计算步，可选择静态预览或纯图';
        $('csvBtn').textContent = select.value === 'preview' ? '导出预览CSV' : '导出轨迹CSV';
        const reason = select.value === 'diagram' ? '纯图不包含数值，不能导出CSV'
          : select.value === 'preview' ? (snapshot.runtime.result.ok ? '' : '当前没有可导出的计算结果')
          : !point ? '尚无成功计算步，当前轨迹CSV不可用'
          : !old && !snapshot.runtime.result.ok ? '当前求解失败，请明确选择历史轨迹' : '';
        $('csvBtn').disabled = !!reason || exportBusy;
        $('csvBtn').title = reason;
        $('exportReason').textContent = reason;
        $('historyDetails').textContent = old ? '修改前结果 · ' + old.document.title + ' · 原输入：' + old.document.design.components.map(c => c.label + '：' + specs(c.typeId).map(spec => spec.label + ' ' + fromSI(spec.quantity, c.params[spec.key]) + ' ' + (labels[spec.legacyKey]?.[1] || '')).join('，')).join('；') : '';
    }
    $('exportSource').addEventListener('change', renderExportSource);
    async function exportSelection(format) {
        if (exportBusy || !await guardInputs()) return;
        const current = store.snapshot(), value = $('exportSource').value;
        const selection = value.startsWith('history:') ? { kind: 'history', documentSessionId: current.documentSessionId,
            runId: Number(value.slice(8)) } : { kind: value };
        const captured = captureExport(current, selection, { snapshotId: id('export'), capturedAt: new Date().toISOString(), appVersion: '0.8.0' });
        if (!feedback(captured)) return;
        const snapshot = captured.value;
        const encoded = format === 'csv' ? exportCsv(snapshot) : { ok: true, value: exportSvg(snapshot, displayExport(snapshot)) };
        if (!feedback(encoded)) return;
        const parsed = parseExportArtifact({ version: 1, snapshotId: snapshot.snapshotId, format,
            suggestedName: (snapshot.document.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 55) || '工程') + '_' + ({diagram:'纯图',preview:'静态预览','current-run':'当前轨迹',history:'历史轨迹'})[selection.kind] + '.' + format, text: encoded.value });
        if (!feedback(parsed)) return;
        exportBusy = true;
        lastExport = { snapshot, status: 'pending' };
        try {
            const reply = await files.exportArtifact(parsed.value);
            lastExport = { snapshot, status: reply.status, ...(reply.status === 'ok' ? { path: reply.path } : {}) };
            if (reply.status === 'ok') $('exportStatus').textContent = '已导出：' + reply.path;
            else if (reply.status === 'cancelled') $('exportStatus').textContent = '已取消导出';
            else { $('exportStatus').textContent = '导出失败：' + problemText(reply.diagnostics); reportFileFailure(reply); }
        } finally { exportBusy = false; }
    }
    $('svgBtn').addEventListener('click', () => exportSelection('svg'));
    $('csvBtn').addEventListener('click', () => exportSelection('csv'));
    $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
    function openSizing() { pause(); sizing = null; $('applySizeBtn').disabled = true; $('sizeResults').innerHTML = ''; const c = model.components.find(c => c.type === 'cylinder'); if (c) {
        $('sizingForm').elements.force.value = c.params.loadExt || 1;
        $('sizingForm').elements.stroke.value = c.params.stroke;
    } $('sizeDialog').showModal(); }
    $('sizeBtn').addEventListener('click', openSizing);
    function sizingRequirements() { const f = $('sizingForm').elements, p = store.snapshot().document.design.components.find(c => c.typeId === 'pump'); return { forceN: toSI('force', Number(f.force.value)), speedMPerS: toSI('linearSpeed', Number(f.speed.value)), pressureBudgetPa: toSI('pressure', Number(f.pressure.value)), strokeM: toSI('length', Number(f.stroke.value)), ...(p ? { pumpAngularSpeedRadPerS: p.params.angularSpeedRadPerS, volumetricEfficiency: p.params.volumetricEfficiency, totalEfficiency: p.params.totalEfficiency } : {}) }; }
    $('sizingForm').addEventListener('submit', e => { e.preventDefault(); const requirements = sizingRequirements(), result = sizeCylinder(requirements); if (!result.ok) {
        sizing = null;
        $('applySizeBtn').disabled = true;
        $('sizeResults').textContent = problemText(result.diagnostics);
        return;
    } sizing = requirements; const s = result.value; $('sizeResults').textContent = '缸径/杆径 ' + fmt(fromSI('length', s.boreM)) + ' / ' + fmt(fromSI('length', s.rodM)) + ' mm；候选泵 ' + fmt(fromSI('displacement', s.pumpDisplacementM3PerRev)) + ' mL/r；实际速度 ' + fmt(fromSI('linearSpeed', s.actualSpeedMPerS)) + ' mm/s；轴功率 ' + fmt(fromSI('power', s.shaftPowerW)) + ' kW'; $('applySizeBtn').disabled = !model.components.some(c => c.type === 'cylinder') || !model.components.some(c => c.type === 'pump'); });
    $('applySizeBtn').addEventListener('click', () => { if (!sizing)
        return; const result = execute({ type: 'apply-sizing', requirements: sizing }); if (result.ok) {
        $('sizeDialog').close();
        toast('初选作为一次原子编辑应用；请检查两个方向');
    } });

    function showPage(page) {
        if (page === 'properties' && innerWidth >= 1100) page = 'circuit';
        document.body.dataset.page = page;
        document.querySelectorAll('.page-tabs [data-page]').forEach(b => b.setAttribute('aria-current', String(b.dataset.page === page)));
        renderView();
    }
    function updateHitAreas() {
        for (const hit of $('board').querySelectorAll('.port-hit')) hit.setAttribute('r', Math.max(8, 8 / viewPlan.scale));
        for (const hit of $('board').querySelectorAll('.wire-hit')) hit.style.strokeWidth = 12 / viewPlan.scale;
    }
    function renderView() {
        if (drag || document.body.dataset.page !== 'circuit') return;
        const viewport = $('boardScroll');
        if (!viewport.clientWidth || !viewport.clientHeight) return;
        const focus = model.components.find(c => c.id === (locatedObject || viewAnchorId || selected));
        viewPlan = circuitViewport(model.components, viewport.clientWidth, viewport.clientHeight, viewMode === 'fit', focus);
        if (viewPlan.limited && focus) viewAnchorId = focus.id;
        const p = viewPlan, svg = $('board');
        svg.setAttribute('viewBox', [p.x, p.y, p.width, p.height].join(' '));
        svg.style.width = p.width * p.scale + 'px'; svg.style.height = p.height * p.scale + 'px';
        svg.style.marginLeft = Math.max(0, (viewport.clientWidth - p.width * p.scale) / 2) + 'px';
        svg.style.marginTop = Math.max(0, (viewport.clientHeight - p.height * p.scale) / 2) + 'px';
        updateHitAreas();
        $('viewStatus').textContent = p.limited ? '布局过大：定位对象浏览' : Math.round(p.scale * 100) + '%';
        $('viewStatus').title = p.limited ? '有限1200×800窗口；保存保留全部±1,000,000合法坐标，逐对象定位。' : '仅改变视图，不改工程';
        $('fitBtn').setAttribute('aria-pressed', String(viewMode === 'fit'));
        $('actualBtn').setAttribute('aria-pressed', String(viewMode === 'actual'));
        if (locatedObject && focus) {
            viewport.scrollLeft = (focus.x - p.x) * p.scale - viewport.clientWidth / 2;
            viewport.scrollTop = (focus.y - p.y) * p.scale - viewport.clientHeight / 2;
            locatedObject = null;
        }
    }
    function locateObject(id, port) {
        const c = model.components.find(c => c.id === id);
        if (!c) return;
        showPage('circuit'); viewMode = 'actual'; locatedObject = id; renderView();
        const target = port ? [...$('board').querySelectorAll('[data-port]')].find(p => p.dataset.port === id + ':' + port)
          : [...$('board').querySelectorAll('[data-component]')].find(p => p.dataset.component === id);
        target?.focus();
    }
    function renderControlStatus() {
        const valve = controlValve(), value = valves.find(v => v.componentId === valve?.id);
        const names = { extend: '左位 P→A', neutral: '中位', retract: '右位 P→B' };
        const describe = v => '设计初位：' + names[v.initialPositionId] + ' · 请求：' + names[v.requestedPositionId]
            + (v.effectivePositionId === null ? ' · 尚无成功步（非轨迹）' : ' · 成功步位：' + names[v.effectivePositionId] + ' / 计算步 ' + v.tick)
            + (v.requestedPositionId !== v.effectivePositionId ? ' · 待执行：' + names[v.requestedPositionId] : '');
        $('controlTarget').textContent = valve ? '控制 ' + valve.label : valves.length ? '请先选择控制阀' : '无控制阀';
        $('controlTarget').setAttribute('aria-label', valve ? '当前控制对象 ' + valve.label : '未选择控制阀');
        $('controlTarget').title = valve?.label || '多阀草稿需明确选择操作对象';
        $('controlStatus').textContent = value ? describe(value) : '选中一个换向阀后分别请求换位';
        const inspector = $('valveInstanceStatus'), inspected = valves.find(v => selectedKind === 'component' && v.componentId === selected);
        if (inspector && inspected) inspector.textContent = (model.components.find(c => c.id === inspected.componentId)?.label || '换向阀') + ' · ' + describe(inspected);
        document.querySelectorAll('[data-mode]').forEach(b => {
            const indicated = value?.effectivePositionId ?? value?.initialPositionId;
            b.classList.toggle('active', b.dataset.mode === indicated);
            b.dataset.pending = String(!!value && b.dataset.mode === value.requestedPositionId && value.requestedPositionId !== value.effectivePositionId);
            b.setAttribute('aria-pressed', String(!!value && b.dataset.mode === indicated));
            b.title = value?.effectivePositionId === b.dataset.mode ? '此实例最后成功步控制'
                : value?.effectivePositionId === null && indicated === b.dataset.mode ? '此实例设计初位，尚非成功步'
                : value?.requestedPositionId === b.dataset.mode ? '请求预览，待下一成功步执行' : '请求切换所选阀位';
            b.disabled = !valve;
        });
    }
    function renderNavigation() {
        const s = store.snapshot();
        const navKey = s.documentSessionId + ':' + s.documentRevision;
        if ($('objectList').dataset.key !== navKey) {
            $('objectList').dataset.key = navKey;
            $('objectList').innerHTML = model.components.map(c => '<div class="object-entry"><button data-object="' + c.id + '">' + esc(c.label) + '</button><button data-locate="' + c.id + '">定位</button>' + componentPorts[c.type].map(p => '<button data-object-port="' + c.id + ':' + p + '">' + esc(c.label + ' ' + p) + ' 油口</button>').join('') + '</div>').join('')
              + model.wires.map(w => '<div class="object-entry"><button data-wire-object="' + w.id + '">' + esc('管路 ' + (model.wires.indexOf(w) + 1) + ' · ' + endpointName(w.from) + ' → ' + endpointName(w.to)) + '</button></div>').join('');
        }
        const diagnostics = s.runtime.result.ok ? s.runtime.result.value.diagnostics || [] : s.runtime.result.diagnostics;
        const items = [...diagnostics, ...s.runtime.simulation.diagnostics];
        // Complete the topology summary with actual unconnected registered ports.
        for (const c of model.components) for (const port of componentPorts[c.type]) {
            const endpoint = c.id + ':' + port;
            if (!model.wires.some(w => w.from === endpoint || w.to === endpoint)) items.push({ code: 'PORT_UNCONNECTED', message: endpoint + ' 尚未连接', componentId: c.id, portId: port });
        }
        const key = JSON.stringify(items);
        if ($('diagnosticList').dataset.key !== key) {
            $('diagnosticList').dataset.key = key;
            $('diagnosticList').innerHTML = items.length ? items.map(d => '<div class="diagnostic-entry"><strong>⚠ ' + esc(diagnosticPresentation(d, diagnosticObject(d)).title) + '</strong><p>' + esc(diagnosticDisplayText(d, diagnosticObject(d))) + '</p><details><summary>技术详情</summary><pre>' + esc(diagnosticPresentation(d, diagnosticObject(d)).detail) + '</pre></details>' + (d.componentId ? '<button data-locate="' + esc(d.componentId) + '" data-locate-port="' + esc(d.portId || '') + '">定位对象 / 油口</button>' : '<button data-open-objects>查看对象与油口</button>') + '</div>').join('') : '<p>基础回路检查未发现错误。结果仍限准静态支持范围。</p>';
        }
    }
    $('fitBtn').onclick = () => { viewMode = 'fit'; renderView(); };
    $('actualBtn').onclick = () => {
        const scroll = $('boardScroll'), previous = viewPlan;
        const center = previous ? { x: previous.x + (scroll.scrollLeft + scroll.clientWidth / 2 - parseFloat($('board').style.marginLeft || '0')) / previous.scale,
          y: previous.y + (scroll.scrollTop + scroll.clientHeight / 2 - parseFloat($('board').style.marginTop || '0')) / previous.scale } : null;
        viewMode = 'actual'; locatedObject = selected; renderView();
        if (!selected && center) { scroll.scrollLeft = center.x - viewPlan.x - scroll.clientWidth / 2; scroll.scrollTop = center.y - viewPlan.y - scroll.clientHeight / 2; }
    };
    $('locateBtn').onclick = () => locateObject(selected);
    $('toggleDockBtn').onclick = e => { document.body.dataset.dock = document.body.dataset.dock === 'closed' ? 'open' : 'closed'; e.target.textContent = document.body.dataset.dock === 'closed' ? '展开结果' : '收起结果'; e.target.setAttribute('aria-expanded', String(document.body.dataset.dock !== 'closed')); renderView(); };
    new ResizeObserver(() => renderView()).observe($('boardScroll'));
    window.addEventListener('resize', () => { if (innerWidth >= 1100 && document.body.dataset.page === 'properties') showPage('circuit'); });
    $('propertiesBtn').onclick = () => { showPage('properties'); $('propertiesPage').focus(); };
    $('backCircuitBtn').onclick = () => showPage('circuit');
    $('diagnosticsBtn').onclick = $('statusBtn').onclick = () => { showPage('diagnostics'); $('diagnosticsPage').focus(); };
    $('objectsBtn').onclick = () => showPage('objects');
    document.querySelectorAll('[data-page]').forEach(b => { if (b.tagName === 'BUTTON') b.onclick = () => showPage(b.dataset.page); });
    document.addEventListener('click', async e => {
        const locate = e.target.closest('[data-locate]');
        if (locate) { locateObject(locate.dataset.locate, locate.dataset.locatePort); return; }
        if (e.target.closest('[data-open-objects]')) { showPage('objects'); return; }
        const object = e.target.closest('[data-object],[data-wire-object]'), port = e.target.closest('[data-object-port]');
        if (port) { connect(port.dataset.objectPort); return; }
        if (object && await guardInputs()) {
            store.select({ kind: object.dataset.object ? 'component' : 'connection', id: object.dataset.object || object.dataset.wireObject }); renderAll(); showPage('properties');
        }
    });
    $('objectList').addEventListener('keydown', e => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const buttons = [...$('objectList').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
        e.preventDefault(); buttons[next]?.focus();
    });
    $('board').addEventListener('dblclick', e => { if (e.target.closest('[data-component],[data-wire]')) showPage('properties'); });
    $('board').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('[data-component]') && !e.target.closest('[data-port]')) { e.preventDefault(); showPage('properties'); } });
    $('applyPropertiesBtn').onclick = applyProperties;
    $('cancelPropertiesBtn').onclick = cancelProperties;
    $('propertyBody').addEventListener('input', updateBufferStatus);
    $('propertyBody').addEventListener('change', updateBufferStatus);
    $('propertyBody').addEventListener('focusout', e => {
        const input = e.target;
        if (input.matches('input[inputmode=decimal]') && input.value !== propertyBaseline.get(input) && !decimalInput(input.value).ok) {
            input.setAttribute('aria-invalid', 'true'); $('inputErrors').textContent = '⚠ 请输入有限十进制数字，例如63；输入尚未应用。';
        }
    });
    $('propertyBody').addEventListener('keydown', e => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyProperties(); }
        if (e.key === 'Escape' && propertyBaseline.has(e.target)) {
            e.preventDefault(); e.stopPropagation(); e.target.value = propertyBaseline.get(e.target); e.target.removeAttribute('aria-invalid'); $('inputErrors').textContent = ''; updateBufferStatus();
        }
    });
    document.addEventListener('wheel', e => {
        if (e.ctrlKey || drag || placement || e.target.closest('[popover]:popover-open')) { e.preventDefault(); return; }
        if (e.target.matches('input[type=number]')) {
            e.preventDefault(); const container = e.target.closest('.scroll-body,.dialog-body'); if (container) container.scrollBy({ top: e.deltaY, left: e.deltaX });
        }
        if (e.shiftKey && e.target.closest('#boardScroll')) { e.preventDefault(); $('boardScroll').scrollLeft += e.deltaY || e.deltaX; }
    }, { passive: false });
    document.addEventListener('keydown', e => {
        if (e.key !== 'F6' || document.querySelector('dialog[open]')) return;
        e.preventDefault(); const regions = [...document.querySelectorAll('[data-region]')].filter(r => r.getClientRects().length);
        const current = regions.findIndex(r => r.contains(document.activeElement)), delta = e.shiftKey ? -1 : 1;
        regions[(current + delta + regions.length) % regions.length]?.focus();
    });
    for (const dialog of document.querySelectorAll('dialog')) {
        let returnFocus = null;
        dialog.addEventListener('beforetoggle', e => { if (e.newState === 'open') returnFocus = document.activeElement; });
        dialog.addEventListener('close', () => returnFocus?.focus());
    }
    $('addMenu').addEventListener('beforetoggle', e => { if (e.newState === 'open') $('addMenu').style.top = Math.min(124, innerHeight - 64 - 240) + 'px'; });
    $('previewBtn').onclick = () => { store.pause(); lastFrame = 0; store.refresh(); renderAll(); showPage('result'); };
    $('retrySaveBtn').onclick = () => fileAction(() => files.save());
    $('alternateSaveBtn').onclick = () => fileAction(() => files.save(true));

    const first = store.snapshot().document.design.components.find(c => c.typeId === 'cylinder' || c.typeId === 'motor');
    if (first)
        store.select({ kind: 'component', id: first.id });
    renderAll();
    let filesReady = false;
    document.body.inert = true;
    void files.initialize().then(async reply => {
        document.body.inert = false;
        if (!reportFileFailure(reply)) return;
        await updateFileLists(); renderAll();
        await fileAction(() => files.offerRecovery());
        filesReady = true;
    });
    window.projectFiles.onCloseRequested(() => { if (filesReady) void guardInputs().then(ok => { if (ok) void files.close().then(reply => { reportFileFailure(reply); if (reply.status !== 'ok') renderAll(); }); }); });
    setInterval(() => { if (filesReady) saveLocal(); }, 10000);
    Object.defineProperty(window, 'HydWorkbench', { value: Object.freeze({ snapshot: () => JSON.parse(JSON.stringify({
        ...store.snapshot(), ...displayState(store.snapshot()), files: files.snapshot(), filesReady, exportBusy, lastExport,
        ui: { page: document.body.dataset.page, viewMode, viewPlan, buffered: hasInputBuffer() } })) }) });
})();
