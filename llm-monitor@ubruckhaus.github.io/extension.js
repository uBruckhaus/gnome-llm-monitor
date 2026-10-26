// LLM Monitor for GNOME: a top bar indicator for local LLMs. Dim chip while no
// model is loaded; while a runtime holds one, the GPU memory of local models and
// how full the context is, coloured green to red, with a fill line underneath.
// It pulses while the GPU is generating. Left click opens the details, right
// click opens (or focuses) btop.
//
// The data comes from scripts/llm-monitor.py, which streams one JSON snapshot
// every two seconds while the extension is enabled. It only reads /proc, sysfs
// and the runtimes' local APIs; it never starts or stops a runtime.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GIB = 1073741824;
const MIB = 1048576;
const SPILL_SHOWN = 268435456;    // evicted model memory worth a "!" and a warning
const RESTART_DELAY = 5;          // seconds before a collector that exited starts again
const DIM = 150;                  // opacity of secondary text

// Context level: green < 50 % ≤ yellow < 75 % ≤ orange < 90 % ≤ red (GNOME palette).
const LEVELS = {green: '#33d17a', yellow: '#f6d32d', orange: '#ff7800', red: '#e01b24'};

function levelColor(fraction) {
    if (fraction >= 0.9)
        return LEVELS.red;
    if (fraction >= 0.75)
        return LEVELS.orange;
    if (fraction >= 0.5)
        return LEVELS.yellow;
    return LEVELS.green;
}

const gib = bytes => (Number(bytes || 0) / GIB).toFixed(1);
const pct = value => value === null || value === undefined ? '—' : `${Math.round(value)}%`;
const rate = value => value === null || value === undefined ? '—' : value.toFixed(value >= 100 ? 0 : 1);

function mib(bytes) {
    bytes = Number(bytes || 0);
    return bytes >= GIB ? `${gib(bytes)} GiB` : `${Math.round(bytes / MIB)} MiB`;
}

function tokens(value) {
    value = Number(value || 0);
    return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function ctxText(value) {
    if (!value)
        return '';
    return `${value >= 1024 ? `${Math.round(value / 1024)}k` : value} ctx`;
}

// Share of the main model's context in use, or -1 when unknown.
function contextFraction(stats) {
    const p = stats.primary;
    if (stats.active !== true || !p || !p.context || p.context_used === null || p.context_used === undefined)
        return -1;
    return Math.max(0, Math.min(1, p.context_used / p.context));
}

function runtimeState(runtime) {
    if (!runtime.running)
        return runtime.installed === false ? 'not installed' : 'stopped';
    const resident = runtime.models.filter(model => model.state !== 'sleeping').length;
    if (resident)
        return resident === 1 ? '1 model loaded' : `${resident} models loaded`;
    if (runtime.models.length)
        return 'model sleeping (GPU free)';
    return 'running, no model';
}

// ---------------------------------------------------------------------------------- collector

class Collector {
    constructor(script, onSnapshot) {
        this._script = script;
        this._onSnapshot = onSnapshot;
        this._stopped = false;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        const python = GLib.find_program_in_path('python3');
        try {
            if (!python)
                throw new Error('python3 not found');
            this._proc = Gio.Subprocess.new([python, '-I', this._script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`[LLM Monitor] collector did not start: ${e.message}`);
            this._restartLater();
            return;
        }
        const stream = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe(), close_base_stream: true});
        this._readLine(stream, this._cancellable);
        this._proc.wait_async(this._cancellable, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch {
                return;     // cancelled: stop() was called
            }
            this._restartLater();
        });
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(result);
            } catch {
                return;     // cancelled or the pipe closed
            }
            if (line === null)
                return;
            try {
                const data = JSON.parse(line);
                if (!data.error)
                    this._onSnapshot(data);
            } catch {
                // a partial line while the collector exits
            }
            this._readLine(s, cancellable);
        });
    }

    _restartLater() {
        if (this._stopped || this._restartId)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESTART_DELAY, () => {
            this._restartId = 0;
            if (!this._stopped)
                this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this._stopped = true;
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
        this._cancellable?.cancel();
        this._proc?.force_exit();
        this._proc = null;
    }
}

// ---------------------------------------------------------------------------------- widgets

function label(text = '', styleClass = '', props = {}) {
    const actor = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function dimmed(actor) {
    actor.opacity = DIM;
    return actor;
}

function wrapping(actor) {
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

function hbox(props = {}) {
    return new St.BoxLayout({x_expand: true, ...props});
}

function vbox(props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, ...props});
}

// A rounded track with one or more fills side by side; each segment is
// {fraction, color} (a CSS colour) or {fraction, styleClass}.
class Bar {
    constructor(styleClass) {
        this.actor = new St.BoxLayout({style_class: `llm-monitor-track ${styleClass}`, x_expand: true});
        this._segments = [];
        this.actor.connect('notify::allocation', () => this._layout());
    }

    set(segments) {
        while (this._segments.length < segments.length) {
            const fill = new St.Widget({y_expand: true});
            this.actor.add_child(fill);
            this._segments.push(fill);
        }
        segments.forEach((segment, index) => {
            const fill = this._segments[index];
            fill._fraction = Math.max(0, Math.min(1, segment.fraction || 0));
            fill.style_class = segment.styleClass ?? '';
            const radius = segments.length === 1 ? 'border-radius: 99px;' : '';
            fill.style = (segment.color ? `background-color: ${segment.color};` : '') + radius;
        });
        this._segments.slice(segments.length).forEach(fill => (fill._fraction = 0));
        this._layout();
    }

    _layout() {
        // The allocation, not .width: asking an actor off the stage for its size is an error.
        const width = this.actor.has_allocation() ? this.actor.allocation.get_width() : 0;
        for (const fill of this._segments)
            fill.width = Math.round(width * (fill._fraction ?? 0));
    }
}

// Label left, value right, a bar underneath.
class Meter {
    constructor() {
        this.actor = vbox({style_class: 'llm-monitor-meter'});
        const row = hbox();
        this._label = dimmed(label('', 'llm-monitor-caption', {x_expand: true}));
        this._value = label('', 'llm-monitor-caption');
        row.add_child(this._label);
        row.add_child(this._value);
        this._bar = new Bar('llm-monitor-bar-meter');
        this.actor.add_child(row);
        this.actor.add_child(this._bar.actor);
    }

    update(name, value, fraction) {
        this._label.text = name;
        this._value.text = value;
        this._bar.set([{fraction, styleClass: 'llm-monitor-fill-neutral'}]);
    }
}

// Swatch, name, amount; an optional note below and an optional level bar.
class LegendRow {
    constructor({outlined = false, withBar = false} = {}) {
        this.actor = vbox({style_class: 'llm-monitor-legend'});
        const row = hbox();
        this._swatch = new St.Widget({
            style_class: outlined ? 'llm-monitor-swatch llm-monitor-swatch-outlined' : 'llm-monitor-swatch',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = label('', 'llm-monitor-caption', {x_expand: true});
        this._amount = label('', 'llm-monitor-caption');
        row.add_child(this._swatch);
        row.add_child(this._name);
        row.add_child(this._amount);
        this._note = dimmed(label('', 'llm-monitor-caption llm-monitor-indented'));
        this.actor.add_child(row);
        this.actor.add_child(this._note);
        if (withBar) {
            this._bar = new Bar('llm-monitor-bar-small llm-monitor-indented');
            this.actor.add_child(this._bar.actor);
        }
    }

    update({name, amount, note = '', color = null, styleClass = null, fraction = -1}) {
        this._name.text = name;
        this._amount.text = amount;
        this._note.text = note;
        this._note.visible = note !== '';
        this._swatch.style = color ? `background-color: ${color};` : '';
        if (styleClass)
            this._swatch.style_class = `llm-monitor-swatch ${styleClass}`;
        if (this._bar) {
            this._bar.actor.visible = fraction >= 0;
            this._bar.set([{fraction, color: levelColor(fraction)}]);
        }
    }
}

function sectionHeader(text) {
    return label(text.toUpperCase(), 'llm-monitor-section');
}

// ---------------------------------------------------------------------------------- panel

class DetailPanel {
    constructor(gicon) {
        this.actor = vbox({style_class: 'llm-monitor-panel'});

        // Header: chip, title, what is loaded, generating / idle.
        const hero = hbox({style_class: 'llm-monitor-hero'});
        this._heroIcon = new St.Icon({gicon, style_class: 'llm-monitor-hero-icon', y_align: Clutter.ActorAlign.CENTER});
        const heroText = vbox({y_align: Clutter.ActorAlign.CENTER});
        heroText.add_child(label('LLM Monitor', 'llm-monitor-title'));
        this._heroMeta = dimmed(label('', 'llm-monitor-caption'));
        this._heroMeta.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        heroText.add_child(this._heroMeta);
        this._pill = label('', 'llm-monitor-pill', {y_align: Clutter.ActorAlign.CENTER});
        hero.add_child(this._heroIcon);
        hero.add_child(heroText);
        hero.add_child(this._pill);
        this.actor.add_child(hero);

        // GPU memory: total, one stacked bar (LLM / desktop & apps / free), legend.
        this.actor.add_child(new St.Widget({style_class: 'llm-monitor-separator', x_expand: true}));
        this.actor.add_child(sectionHeader('GPU memory'));
        const total = hbox();
        this._total = label('', 'llm-monitor-strong', {x_expand: true});
        this._free = dimmed(label('', 'llm-monitor-caption'));
        total.add_child(this._total);
        total.add_child(this._free);
        this.actor.add_child(total);
        this._stack = new Bar('llm-monitor-bar-stack');
        this.actor.add_child(this._stack.actor);
        this._legendLlm = new LegendRow();
        this._legendContext = new LegendRow({withBar: true});
        this._legendOutput = new LegendRow({withBar: true});
        this._legendOther = new LegendRow();
        this._legendFree = new LegendRow({outlined: true});
        for (const row of [this._legendLlm, this._legendContext, this._legendOutput, this._legendOther, this._legendFree])
            this.actor.add_child(row.actor);
        this._spilled = wrapping(label('', 'llm-monitor-caption llm-monitor-warning'));
        this.actor.add_child(this._spilled);

        // GPU activity and generation speed.
        this.actor.add_child(sectionHeader('GPU activity'));
        this._load = new Meter();
        this._speed = new Meter();
        this.actor.add_child(this._load.actor);
        this.actor.add_child(this._speed.actor);

        this.actor.add_child(sectionHeader('System'));
        this._cpu = new Meter();
        this._ram = new Meter();
        this.actor.add_child(this._cpu.actor);
        this.actor.add_child(this._ram.actor);

        // One block per runtime, rebuilt with every snapshot while the menu is open.
        this.actor.add_child(new St.Widget({style_class: 'llm-monitor-separator', x_expand: true}));
        this.actor.add_child(sectionHeader('Runtimes'));
        this._runtimes = vbox({style_class: 'llm-monitor-runtimes'});
        this.actor.add_child(this._runtimes);
    }

    update(stats) {
        const gpu = stats.gpu || {};
        const system = stats.system || {};
        const primary = stats.primary || {};
        const free = Math.max(0, (gpu.vram_total || 0) - (gpu.vram_used || 0));

        this._heroIcon.opacity = stats.active ? 255 : DIM;
        this._heroIcon.style_class = `llm-monitor-hero-icon${stats.active ? ' llm-monitor-accent' : ''}`;
        this._heroMeta.text = stats.primary
            ? primary.runtime + (primary.model ? ` · ${primary.model}` : '')
            : 'No local model loaded';
        this._pill.text = stats.busy ? 'generating' : stats.active ? 'idle' : '';
        this._pill.visible = this._pill.text !== '';

        this._total.text = `${gib(gpu.vram_used)} of ${gib(gpu.vram_total)} GiB in use`;
        this._free.text = `${gib(free)} GiB free`;
        const all = gpu.vram_total || 1;
        this._stack.set([
            {fraction: (stats.llm_vram || 0) / all, styleClass: 'llm-monitor-fill-accent'},
            {fraction: (stats.other_vram || 0) / all, styleClass: 'llm-monitor-fill-neutral'},
        ]);

        this._legendLlm.update({
            name: 'LLM models', amount: `${gib(stats.llm_vram)} GiB`,
            note: '↑ this number is shown in the bar', styleClass: 'llm-monitor-fill-accent',
        });

        // The two buffers that fill while you work: the context (whole conversation)
        // and the reply being generated. Memory is the KV cache those tokens occupy.
        const hasContext = !!primary.context && primary.context_used !== null && primary.context_used !== undefined;
        this._legendContext.actor.visible = hasContext;
        if (hasContext) {
            const filled = (primary.context_used || 0) / primary.context;
            this._legendContext.update({
                name: 'Context buffer',
                amount: primary.context_memory
                    ? `≈ ${mib(primary.context_memory * filled)} of ${mib(primary.context_memory)}`
                    : `${Math.round(filled * 100)}%`,
                note: `${tokens(primary.context_used)} / ${tokens(primary.context)} tokens (${Math.round(filled * 100)}%)`,
                color: levelColor(filled), fraction: filled,
            });
        }
        this._legendOutput.actor.visible = !!primary.output_limit;
        if (primary.output_limit) {
            const filled = (primary.output_used || 0) / primary.output_limit;
            const counts = `${tokens(primary.output_used)} / ${tokens(primary.output_limit)} tokens (${Math.round(filled * 100)}%)`;
            this._legendOutput.update({
                name: 'Output buffer',
                amount: primary.context_memory && primary.context
                    ? `≈ ${mib(primary.context_memory * (primary.output_used || 0) / primary.context)}`
                    : `${Math.round(filled * 100)}%`,
                note: primary.generating ? `generating ${counts}` : `last reply ${counts}`,
                color: levelColor(filled), fraction: filled,
            });
        }
        this._legendOther.update({
            name: 'Desktop & apps', amount: `${gib(stats.other_vram)} GiB`,
            note: (stats.other_apps || []).map(app => `${app.name} ${gib(app.vram)}`).join(' · '),
            styleClass: 'llm-monitor-fill-neutral',
        });
        this._legendFree.update({name: 'Free', amount: `${gib(free)} GiB`});

        const spilled = stats.llm_spilled || 0;
        this._spilled.visible = spilled > SPILL_SHOWN;
        this._spilled.text = `⚠ ${gib(spilled)} GiB of model memory does not fit in VRAM and was moved to system RAM. ` +
            'Generation is much slower; unload other models or free GPU memory.';

        this._load.update('Load',
            pct(gpu.busy) + (gpu.temp ? `  ·  ${Math.round(gpu.temp)} °C` : '') + (gpu.power ? `  ·  ${Math.round(gpu.power)} W` : ''),
            (gpu.busy || 0) / 100);

        // Generation speed: live while it writes, plus min / avg / max over the
        // replies since the monitor started watching the model.
        const speed = primary.speed || null;
        this._speed.actor.visible = speed !== null;
        if (speed) {
            const stat = speed.count
                ? `  ·  min ${rate(speed.min)}  avg ${rate(speed.avg)}  max ${rate(speed.max)}`
                : speed.avg ? `  ·  avg ${rate(speed.avg)} since load` : '';
            const now = speed.now !== null && speed.now !== undefined;
            this._speed.update(`Speed${stat}`, now ? `${rate(speed.now)} tok/s` : speed.avg ? 'idle' : '',
                speed.now ? speed.now / Math.max(speed.now, speed.max || 0) : 0);
        }

        this._cpu.update('CPU', pct(system.cpu), (system.cpu || 0) / 100);
        this._ram.update('RAM', `${gib(system.mem_used)} / ${gib(system.mem_total)} GiB`,
            system.mem_total ? system.mem_used / system.mem_total : 0);

        this._runtimes.destroy_all_children();
        for (const runtime of stats.runtimes || [])
            this._runtimes.add_child(this._runtimeBlock(runtime));
    }

    _runtimeBlock(runtime) {
        const block = vbox({style_class: 'llm-monitor-runtime'});
        const loaded = runtime.models.some(model => model.state !== 'sleeping');
        const head = hbox();
        let dotClass = 'llm-monitor-dot';
        if (loaded)
            dotClass += ' llm-monitor-dot-loaded';
        else if (runtime.running)
            dotClass += ' llm-monitor-dot-running';
        head.add_child(new St.Widget({style_class: dotClass, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label(runtime.name, loaded ? 'llm-monitor-strong' : '', {x_expand: true}));
        const state = label(runtimeState(runtime), `llm-monitor-caption${loaded ? ' llm-monitor-accent' : ''}`);
        if (!loaded)
            dimmed(state);
        head.add_child(state);
        block.add_child(head);

        for (const model of runtime.models) {
            const hasUsage = model.context_used !== undefined && model.context_used !== null && model.context > 0;
            const name = label(model.name +
                (model.context && !hasUsage ? `  ·  ${ctxText(model.context)}` : '') +
                (model.state && model.state !== 'loaded' ? `  ·  ${model.state}` : ''),
            'llm-monitor-caption llm-monitor-indented');
            name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            block.add_child(name);
            if (!hasUsage)
                continue;
            // Tokens in the context window, and the VRAM llama.cpp reserved for it (KV cache).
            const fraction = model.context_used / model.context;
            const row = hbox({style_class: 'llm-monitor-indented'});
            row.add_child(dimmed(label('Context' + (model.context_memory ? `  ·  ${mib(model.context_memory)} VRAM` : ''),
                'llm-monitor-caption', {x_expand: true})));
            const value = label(`${tokens(model.context_used)} / ${tokens(model.context)} tokens (${Math.round(fraction * 100)}%)`,
                'llm-monitor-caption');
            if (fraction >= 0.9)
                value.style = `color: ${levelColor(fraction)};`;
            row.add_child(value);
            block.add_child(row);
            const bar = new Bar('llm-monitor-bar-small llm-monitor-indented');
            bar.set([{fraction, color: levelColor(fraction)}]);
            block.add_child(bar.actor);
        }

        if (runtime.running) {
            const details = [`VRAM ${gib(runtime.vram)} GiB` +
                ((runtime.spilled || 0) > SPILL_SHOWN ? ` (+${gib(runtime.spilled)} GiB in RAM)` : ''),
            `CPU ${pct(runtime.cpu)}`, `RAM ${gib(runtime.memory)} GiB`];
            if (runtime.clients.length)
                details.push(`used by ${runtime.clients.join(', ')}`);
            block.add_child(wrapping(dimmed(label(details.join('  ·  '), 'llm-monitor-caption llm-monitor-indented'))));
        }
        return block;
    }
}

// ---------------------------------------------------------------------------------- indicator

const Indicator = GObject.registerClass(
class LlmMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'LLM Monitor', false);
        this._extension = extension;
        this._stats = {};
        this._fraction = -1;
        this.add_style_class_name('llm-monitor-button');

        // Only the left button opens the menu; the right one opens btop.
        this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        const rightClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY});
        rightClick.set_recognize_on_press(true);
        rightClick.connect('recognize', () => extension.openBtop());
        this.add_action(rightClick);

        const gicon = Gio.FileIcon.new(extension.dir.get_child('icons').get_child('llm-chip-symbolic.svg'));
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true});
        this._row = new St.BoxLayout({style_class: 'llm-monitor-row', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({gicon, style_class: 'system-status-icon llm-monitor-icon'});
        this._label = new St.Label({style_class: 'llm-monitor-label', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._row.add_child(this._icon);
        this._row.add_child(this._label);
        // Context fill under the chip: grows with the tokens in use, coloured by level.
        this._line = new Bar('llm-monitor-line');
        this._line.actor.y_align = Clutter.ActorAlign.END;
        this._line.actor.x_align = Clutter.ActorAlign.FILL;
        stack.add_child(this._row);
        stack.add_child(this._line.actor);
        this.add_child(stack);

        this._panel = new DetailPanel(gicon);
        // Scrolls when the details are taller than the screen (many models, small screen).
        this._scroll = new St.ScrollView({
            style_class: 'llm-monitor-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scroll.child = this._panel.actor;
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(this._scroll);
        this.menu.addMenuItem(item);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._freeItem = this.menu.addAction('Free GPU memory', () => extension.freeGpu(), 'edit-clear-all-symbolic');
        this.menu.addAction('Open btop', () => extension.openBtop(), 'utilities-system-monitor-symbolic');
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            // Room for the menu's own padding and the two actions below the details.
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._scroll.style = `max-height: ${Math.max(200, Math.round(workArea.height / scale) - 160)}px;`;
            this._panel.update(this._stats);
        });
        this._render();
    }

    setStats(stats) {
        this._stats = stats;
        this._render();
        if (this.menu.isOpen)
            this._panel.update(stats);
    }

    _render() {
        const stats = this._stats;
        const active = stats.active === true;
        this._fraction = contextFraction(stats);
        let text = '';
        if (active) {
            // "!" marks model memory that was evicted from VRAM (overcommitted GPU).
            text = `${gib(stats.llm_vram)}G${(stats.llm_spilled || 0) > SPILL_SHOWN ? '!' : ''}` +
                (this._fraction >= 0 ? ` ${Math.round(this._fraction * 100)}%` : '');
        }
        this._label.text = text;
        this._label.visible = active;
        const color = active && this._fraction >= 0 ? levelColor(this._fraction) : null;
        for (const actor of [this._icon, this._label]) {
            actor.style = color ? `color: ${color};` : '';
            if (active && !color)
                actor.add_style_class_name('llm-monitor-accent');
            else
                actor.remove_style_class_name('llm-monitor-accent');
        }
        this._line.actor.visible = this._fraction >= 0;
        this._line.set([{fraction: Math.max(0.03, this._fraction), color: color ?? undefined}]);
        this._freeItem.setSensitive(active);
        this._setPulse(stats.busy === true);
        if (!stats.busy)
            this._row.opacity = active ? 255 : DIM;
    }

    // The chip pulses while the GPU is generating.
    _setPulse(on) {
        if (on === !!this._pulsing)
            return;
        this._pulsing = on;
        this._row.remove_all_transitions();
        if (on) {
            this._row.opacity = 255;
            this._row.ease({
                opacity: 90, duration: 650, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1, autoReverse: true,
            });
        }
    }

    _onDestroy() {
        this._row.remove_all_transitions();
        super._onDestroy();
    }
});

// ---------------------------------------------------------------------------------- extension

export default class LlmMonitorExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        const script = this.dir.get_child('scripts').get_child('llm-monitor.py').get_path();
        this._collector = new Collector(script, stats => this._indicator?.setStats(stats));
        this._collector.start();
    }

    disable() {
        this._collector?.stop();
        this._collector = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // Stops the llama-server, Ollama and vLLM user services and unloads LM Studio's
    // models: the only action that changes anything. One run at a time; the script
    // gives each step a time limit and tells in a notification what it freed.
    // A run is not cut short on disable: a half-done systemctl stop helps nobody.
    freeGpu() {
        if (this._freeing)
            return;
        const script = this.dir.get_child('scripts').get_child('free-gpu.sh').get_path();
        const proc = this._spawn(['bash', script]);
        if (!proc)
            return;
        this._freeing = true;
        proc.wait_async(null, () => (this._freeing = false));
    }

    // Focus a btop window if one is open, else start btop in the default terminal.
    openBtop() {
        this._indicator?.menu.close();
        const window = global.get_window_actors().map(actor => actor.meta_window)
            .find(win => /\bbtop\b/i.test(win.get_title() ?? ''));
        if (window) {
            Main.activateWindow(window);
            return;
        }
        if (!GLib.find_program_in_path('btop')) {
            Main.notify('LLM Monitor', 'btop is not installed.');
            return;
        }
        const terminals = [
            ['xdg-terminal-exec', 'btop'],
            ['ptyxis', '--new-window', '--', 'btop'],
            ['kgx', '-e', 'btop'],
            ['gnome-terminal', '--', 'btop'],
        ];
        const argv = terminals.find(([command]) => GLib.find_program_in_path(command));
        if (argv)
            this._spawn(argv);
        else
            Main.notify('LLM Monitor', 'No terminal found to run btop in.');
    }

    _spawn(argv) {
        try {
            return Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`[LLM Monitor] ${argv[0]}: ${e.message}`);
            return null;
        }
    }
}
