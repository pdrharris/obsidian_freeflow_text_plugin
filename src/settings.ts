import { App, PluginSettingTab, Setting } from 'obsidian';
import type FreeFlowInkPlugin from './main';

// Bump this whenever you want to confirm at a glance that the iPad pulled the latest build.
// Keep it in step with the manifest "Sync marker".
export const FREEFLOW_BUILD_MARKER = '2026-07-23C';

export interface FreeFlowInkSettings {
	// Width of the rendered (inline) handwriting block as a fraction of the FULL editor pane width
	// (1 = the whole pane, centred). Only used when `matchTextWidth` is off.
	lineWidthScale: number;
	// When true, the rendered block matches Obsidian's readable-line (markdown text) width and lines
	// up with surrounding text; the width slider is then ignored. Device-local like the other settings.
	matchTextWidth: boolean;
	wordGapScale: number;
	renderLineHeightScale: number;
	renderStrokeFillScale: number;
	drawerHeightScale: number;
	idleAdvanceMs: number;
	releaseAdvanceDelayMs: number;
	advanceLinePosition: number;
	// Writing-line baseline guides are independent: one for the drawer (this setting) and one for
	// the rendered inline view (`showRenderWritingLine`, toggled from each block's meta row).
	showWritingLine: boolean;
	showRenderWritingLine: boolean;
	// Render-time multiplier on overall stroke thickness (not stored on the strokes, so it
	// re-weights existing handwriting too). Above 1 = heavier/bolder lines.
	strokeWeightScale: number;
	velocityWidth: boolean;
	// Fold Apple Pencil pressure (Touch.force, captured per point) into stroke width. Finger/mouse
	// report no real pressure (a constant mid value), so this is a no-op there and falls back to
	// velocity width.
	pressureWidth: boolean;
	// Taper each stroke's ends to a point (entry/exit), for a more penned look.
	taperStrokeEnds: boolean;
	// Optional broad-edge "calligraphy" nib: width depends on stroke direction (thin when moving
	// along the nib axis, full across it). `nibAngle` is the edge angle in degrees; `nibContrast`
	// (0..1) is how strong the thick/thin variation is (0 = round pen, 1 = razor edge).
	calligraphyNib: boolean;
	nibAngle: number;
	nibContrast: number;
	// Non-causal path smoothing strength 0..1 (render-time, non-destructive). Cleans hand jitter.
	handwritingSmoothing: number;
	// iOS only: once an Apple Pencil is seen, ignore finger/palm touches while drawing so a resting
	// hand doesn't lay down stray strokes.
	palmRejection: boolean;
	softBlockLimitKb: number;
	hardBlockLimitKb: number;
	showSoftLimitNotice: boolean;
	// One floating, draggable toolbar shared by the inline blocks and the drawer, replacing the
	// per-block button row and the drawer's duplicated style buttons. Context-sensitive: with a
	// selection the style buttons restyle it; without one (drawer open) they set the pen.
	unifiedToolbar: boolean;
	// Last dragged position of the floating toolbar (viewport px, clamped on restore).
	toolbarPosition: { x: number; y: number } | null;
	// Handwriting recognition (MyScript). Each user supplies their own free developer keys — the
	// plugin is open-source, so a baked-in key would leak. Empty keys just disable "Copy as text".
	myscriptAppKey: string;
	myscriptHmacKey: string;
	// MyScript recognition locale, e.g. "en_US", "en_GB", "fr_FR".
	recognitionLanguage: string;
}

export const DEFAULT_FREEFLOW_SETTINGS: FreeFlowInkSettings = {
	lineWidthScale: 1,
	matchTextWidth: true,
	wordGapScale: 1.35,
	renderLineHeightScale: 1,
	renderStrokeFillScale: 1,
	drawerHeightScale: 1,
	idleAdvanceMs: 2000,
	releaseAdvanceDelayMs: 260,
	advanceLinePosition: 85,
	showWritingLine: true,
	showRenderWritingLine: true,
	strokeWeightScale: 1.3,
	velocityWidth: true,
	pressureWidth: true,
	taperStrokeEnds: true,
	calligraphyNib: false,
	nibAngle: 40,
	nibContrast: 0.6,
	handwritingSmoothing: 0.35,
	palmRejection: true,
	softBlockLimitKb: 2048,
	hardBlockLimitKb: 8192,
	showSoftLimitNotice: false,
	unifiedToolbar: true,
	toolbarPosition: null,
	myscriptAppKey: '',
	myscriptHmacKey: '',
	recognitionLanguage: 'en_US',
};

export class FreeFlowInkSettingTab extends PluginSettingTab {
	private readonly plugin: FreeFlowInkPlugin;
	private detachPreviewResize: (() => void) | null = null;

	constructor(app: App, plugin: FreeFlowInkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.detachPreviewResize?.();
		this.detachPreviewResize = null;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Build')
			.setDesc(`Version ${this.plugin.manifest.version} · marker ${FREEFLOW_BUILD_MARKER}`);

		new Setting(containerEl).setName('Layout & sizing').setHeading();

		const previewSetting = new Setting(containerEl)
			.setName('Adaptive preview')
			.setDesc('Live values are based on your current viewport and slider settings.');
		const previewValueEl = previewSetting.descEl.createDiv({
			cls: 'freeflow-ink-settings-preview',
		});

		const renderAdaptivePreview = (): void => {
			const metrics = this.plugin.getAdaptiveMetrics();
			const screenProfile = metrics.isPhoneLike ? 'Phone profile' : 'Large-screen profile';
			const renderLineSpacingPercent = Math.round(metrics.renderLineHeightScale * 100);
			const renderStrokeFillPercent = Math.round(metrics.renderStrokeFillScale * 100);
			const drawerWritingLineMode = this.plugin.settings.showWritingLine ? 'On' : 'Off';
			previewValueEl.setText(
				`${screenProfile}\n` +
					`Viewport: ${metrics.viewportWidth}px x ${metrics.viewportHeight}px\n` +
					`Line width: ${metrics.lineWidthBasePx}px base -> ${metrics.lineWidthPx}px active\n` +
					`Rendered line spacing: ${renderLineSpacingPercent}%\n` +
					`Rendered stroke fill: ${renderStrokeFillPercent}%\n` +
					`Drawer writing line: ${drawerWritingLineMode}\n` +
					`Drawer height: ${metrics.drawerHeightBasePx}px base -> ${metrics.drawerHeightPx}px active`,
			);
		};
		renderAdaptivePreview();

		const onResize = (): void => {
			renderAdaptivePreview();
		};
		activeWindow.addEventListener('resize', onResize);
		this.detachPreviewResize = () => {
			activeWindow.removeEventListener('resize', onResize);
		};

		const lineWidthValueEl = createDiv();
		lineWidthValueEl.addClass('freeflow-ink-settings-value');
		const lineWidthPercent = Math.round(this.plugin.settings.lineWidthScale * 100);
		lineWidthValueEl.setText(`${lineWidthPercent}%`);

		new Setting(containerEl)
			.setName('Unified floating toolbar')
			.setDesc(
				'One draggable toolbar shared by the rendered blocks and the drawer, instead of a button row at the bottom of every block. With a selection its style buttons restyle the selection; while the drawer is open they set the pen. Blocks already on screen pick the change up after reopening the note.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.unifiedToolbar).onChange(async (value) => {
					this.plugin.settings.unifiedToolbar = value;
					await this.plugin.saveSettings();
					this.plugin.refreshInlineBlocks();
				}),
			);

		new Setting(containerEl)
			.setName('Match text width')
			.setDesc(
				'Render handwriting at the same width as Obsidian’s text (readable line length) so it lines up with surrounding notes. Turn this off to use the width slider below. The per-block resize handle still overrides both.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.matchTextWidth).onChange(async (value) => {
					this.plugin.settings.matchTextWidth = value;
					await this.plugin.saveSettings();
					this.plugin.refreshInlineBlocks();
				}),
			);

		new Setting(containerEl)
			.setName('Displayed line width')
			.setDesc(
				'Width of the rendered handwriting block: 100% spans the full editor width, lower values are narrower and centred. Only applies when “match text width” is off.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(30, 100, 1)
					.setValue(lineWidthPercent)					.onChange(async (value) => {
						this.plugin.settings.lineWidthScale = value / 100;
						lineWidthValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
						this.plugin.refreshInlineBlocks();
					}),
			)
			.controlEl.appendChild(lineWidthValueEl);

		const wordGapValueEl = createDiv();
		wordGapValueEl.addClass('freeflow-ink-settings-value');
		const wordGapPercent = Math.round(this.plugin.settings.wordGapScale * 100);
		wordGapValueEl.setText(`${wordGapPercent}%`);

		new Setting(containerEl)
			.setName('Word gap threshold')
			.setDesc(
				'Controls how much horizontal space is treated as a word break for wrapping and insertion spacing.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(80, 250, 5)
					.setValue(wordGapPercent)					.onChange(async (value) => {
						this.plugin.settings.wordGapScale = value / 100;
						wordGapValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(wordGapValueEl);

		const renderLineSpacingValueEl = createDiv();
		renderLineSpacingValueEl.addClass('freeflow-ink-settings-value');
		const renderLineSpacingPercent = Math.round(
			this.plugin.settings.renderLineHeightScale * 100,
		);
		renderLineSpacingValueEl.setText(`${renderLineSpacingPercent}%`);

		new Setting(containerEl)
			.setName('Rendered line spacing')
			.setDesc(
				'Controls spacing between rendered handwriting lines.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(10, 400, 1)
					.setValue(renderLineSpacingPercent)					.onChange(async (value) => {
						this.plugin.settings.renderLineHeightScale = value / 100;
						renderLineSpacingValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
					}),
			)
			.controlEl.appendChild(renderLineSpacingValueEl);

		const renderStrokeFillValueEl = createDiv();
		renderStrokeFillValueEl.addClass('freeflow-ink-settings-value');
		const renderStrokeFillPercent = Math.round(
			this.plugin.settings.renderStrokeFillScale * 100,
		);
		renderStrokeFillValueEl.setText(`${renderStrokeFillPercent}%`);

		new Setting(containerEl)
			.setName('Rendered stroke fill')
			.setDesc(
				'Controls how much of each rendered line the handwriting fills (for example 80% or 110%).',
			)
			.addSlider((slider) =>
				slider
					.setLimits(40, 160, 1)
					.setValue(renderStrokeFillPercent)					.onChange(async (value) => {
						this.plugin.settings.renderStrokeFillScale = value / 100;
						renderStrokeFillValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
					}),
			)
			.controlEl.appendChild(renderStrokeFillValueEl);

		const drawerHeightValueEl = createDiv();
		drawerHeightValueEl.addClass('freeflow-ink-settings-value');
		const drawerHeightPercent = Math.round(this.plugin.settings.drawerHeightScale * 100);
		drawerHeightValueEl.setText(`${drawerHeightPercent}%`);

		new Setting(containerEl)
			.setName('Drawer height')
			.setDesc(
				'Scales drawer height while keeping phone and desktop defaults adaptive to screen size.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(30, 150, 1)
					.setValue(drawerHeightPercent)					.onChange(async (value) => {
						this.plugin.settings.drawerHeightScale = value / 100;
						drawerHeightValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
					}),
			)
			.controlEl.appendChild(drawerHeightValueEl);

		const idleAdvanceValueEl = createDiv();
		idleAdvanceValueEl.addClass('freeflow-ink-settings-value');
		idleAdvanceValueEl.setText(`${this.plugin.settings.idleAdvanceMs} ms`);
		const releaseAdvanceDelayValueEl = createDiv();
		releaseAdvanceDelayValueEl.addClass('freeflow-ink-settings-value');
		releaseAdvanceDelayValueEl.setText(`${this.plugin.settings.releaseAdvanceDelayMs} ms`);
		const advanceLineValueEl = createDiv();
		advanceLineValueEl.addClass('freeflow-ink-settings-value');
		advanceLineValueEl.setText(`${this.plugin.settings.advanceLinePosition}%`);

		new Setting(containerEl).setName('Pen & ink').setHeading();

		const strokeWeightValueEl = createDiv();
		strokeWeightValueEl.addClass('freeflow-ink-settings-value');
		const strokeWeightPercent = Math.round(this.plugin.settings.strokeWeightScale * 100);
		strokeWeightValueEl.setText(`${strokeWeightPercent}%`);

		new Setting(containerEl)
			.setName('Line weight')
			.setDesc('Overall thickness of the ink. Raise it if strokes look too thin.')
			.addSlider((slider) =>
				slider
					.setLimits(50, 300, 5)
					.setValue(strokeWeightPercent)					.onChange(async (value) => {
						this.plugin.settings.strokeWeightScale = value / 100;
						strokeWeightValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(strokeWeightValueEl);

		new Setting(containerEl)
			.setName('Variable width by pen speed')
			.setDesc(
				'Renders faster strokes thinner and slower strokes thicker for a more natural ink look.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.velocityWidth)
					.onChange(async (value) => {
						this.plugin.settings.velocityWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Variable width by pen pressure')
			.setDesc(
				'Uses pen pressure from a pressure-sensitive stylus so harder presses render thicker. Finger and mouse have no real pressure, so it falls back to pen-speed width there.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.pressureWidth)
					.onChange(async (value) => {
						this.plugin.settings.pressureWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		const smoothingValueEl = createDiv();
		smoothingValueEl.addClass('freeflow-ink-settings-value');
		smoothingValueEl.setText(`${Math.round(this.plugin.settings.handwritingSmoothing * 100)}%`);

		new Setting(containerEl)
			.setName('Handwriting smoothing')
			.setDesc(
				'Cleans up jitter and shaky lines. Higher is smoother but rounds off fine detail. Applied when rendering, so it never changes your saved strokes.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 5)
					.setValue(Math.round(this.plugin.settings.handwritingSmoothing * 100))					.onChange(async (value) => {
						this.plugin.settings.handwritingSmoothing = value / 100;
						smoothingValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(smoothingValueEl);

		new Setting(containerEl)
			.setName('Taper stroke ends')
			.setDesc('Tapers the start and end of each stroke to a point for a more penned look.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.taperStrokeEnds)
					.onChange(async (value) => {
						this.plugin.settings.taperStrokeEnds = value;
						await this.plugin.saveSettings();
					}),
			);

		const nibAngleValueEl = createDiv();
		nibAngleValueEl.addClass('freeflow-ink-settings-value');
		nibAngleValueEl.setText(`${Math.round(this.plugin.settings.nibAngle)}°`);
		const nibContrastValueEl = createDiv();
		nibContrastValueEl.addClass('freeflow-ink-settings-value');
		nibContrastValueEl.setText(`${Math.round(this.plugin.settings.nibContrast * 100)}%`);

		new Setting(containerEl)
			.setName('Calligraphy nib')
			.setDesc(
				'Gives strokes a broad-edge pen feel: thin when moving along the nib angle, thick across it. Stacks with the width settings above.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.calligraphyNib)
					.onChange(async (value) => {
						this.plugin.settings.calligraphyNib = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Nib angle')
			.setDesc(
				'Angle of the pen edge. Positive tilts the edge one way (like an acute accent), negative the other (like a grave). Around 40° gives the classic thick-down, thin-across look.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(-90, 90, 1)
					.setValue(Math.round(this.plugin.settings.nibAngle))					.onChange(async (value) => {
						this.plugin.settings.nibAngle = value;
						nibAngleValueEl.setText(`${value}°`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(nibAngleValueEl);

		new Setting(containerEl)
			.setName('Nib contrast')
			.setDesc('How strong the thick/thin variation is. Lower is a milder, more subtle nib.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 100, 5)
					.setValue(Math.round(this.plugin.settings.nibContrast * 100))					.onChange(async (value) => {
						this.plugin.settings.nibContrast = value / 100;
						nibContrastValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(nibContrastValueEl);

		new Setting(containerEl).setName('Writing aids').setHeading();

		new Setting(containerEl)
			.setName('Palm rejection')
			.setDesc(
				'On touch devices, once a pen stylus is detected, ignore finger and palm contact while writing so a resting hand does not leave stray strokes. Toolbar buttons still respond to taps.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.palmRejection)
					.onChange(async (value) => {
						this.plugin.settings.palmRejection = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show writing line in drawer')
			.setDesc(
				'Shows a baseline guide in the writing drawer so letters sit consistently above and below it. The rendered (inline) view has its own writing-line toggle in each block’s toolbar.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showWritingLine)
					.onChange(async (value) => {
						this.plugin.settings.showWritingLine = value;
						await this.plugin.saveSettings();
						renderAdaptivePreview();
					}),
			);

		new Setting(containerEl).setName('Drawer auto-scroll').setHeading();

		new Setting(containerEl)
			.setName('Pause auto-scroll delay')
			.setDesc('If pen input pauses for this duration after lift, a step advance is triggered.')
			.addSlider((slider) =>
				slider
					.setLimits(500, 5000, 100)
					.setValue(this.plugin.settings.idleAdvanceMs)					.onChange(async (value) => {
						this.plugin.settings.idleAdvanceMs = value;
						idleAdvanceValueEl.setText(`${value} ms`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
					}),
			)
			.controlEl.appendChild(idleAdvanceValueEl);

		new Setting(containerEl)
			.setName('Edge auto-scroll delay')
			.setDesc(
				'Delay after pen lift before right-edge auto-scroll runs. Helpful for dotting i or crossing t before scrolling.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1200, 25)
					.setValue(this.plugin.settings.releaseAdvanceDelayMs)					.onChange(async (value) => {
						this.plugin.settings.releaseAdvanceDelayMs = value;
						releaseAdvanceDelayValueEl.setText(`${value} ms`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(releaseAdvanceDelayValueEl);

		new Setting(containerEl)
			.setName('Edge line position')
			.setDesc(
				'Where the dotted orange "near the right edge" guide sits in the drawer. Past this line, writing advances after the shorter (edge) delay; before it, only after the longer (pause) delay.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(50, 95, 1)
					.setValue(this.plugin.settings.advanceLinePosition)					.onChange(async (value) => {
						this.plugin.settings.advanceLinePosition = value;
						advanceLineValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(advanceLineValueEl);

		new Setting(containerEl).setName('Handwriting recognition (MyScript)').setHeading();

		new Setting(containerEl).setDesc(
			'"Copy as text" on a block sends its strokes to MyScript and copies back the recognised text. ' +
				'Create a free developer account at developer.myscript.com (about 2,000 recognitions/month at ' +
				'no cost) and paste your two keys below. They are stored only in this vault. Handwriting is ' +
				'sent to MyScript’s cloud when you use the feature.',
		);

		new Setting(containerEl)
			.setName('MyScript application key')
			.setDesc('The application key from your MyScript developer dashboard.')
			.addText((text) =>
				text
					.setPlaceholder('Application key')
					.setValue(this.plugin.settings.myscriptAppKey)
					.onChange(async (value) => {
						this.plugin.settings.myscriptAppKey = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('MyScript HMAC key')
			.setDesc('The HMAC key that pairs with the application key above.')
			.addText((text) => {
				text
					.setValue(this.plugin.settings.myscriptHmacKey)
					.onChange(async (value) => {
						this.plugin.settings.myscriptHmacKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password'; // it's a secret; don't show it in the clear
			});

		new Setting(containerEl)
			.setName('Recognition language')
			.setDesc('MyScript locale used for recognition, for example en_US, en_GB or fr_FR.')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.recognitionLanguage)
					.onChange(async (value) => {
						this.plugin.settings.recognitionLanguage = value.trim() || 'en_US';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Block size guardrails').setHeading();

		new Setting(containerEl)
			.setName('Large block warning')
			.setDesc('Shows a one-time notice when a block grows past your warning threshold.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSoftLimitNotice)
					.onChange(async (value) => {
						this.plugin.settings.showSoftLimitNotice = value;
						await this.plugin.saveSettings();
					}),
			);

		const softLimitValueEl = createDiv();
		softLimitValueEl.addClass('freeflow-ink-settings-value');
		softLimitValueEl.setText(`${this.plugin.settings.softBlockLimitKb} KB`);

		new Setting(containerEl)
			.setName('Warning threshold')
			.setDesc('Soft warning threshold. Recommended: 1000-4000 KB.')
			.addSlider((slider) =>
				slider
					.setLimits(200, 12000, 100)
					.setValue(this.plugin.settings.softBlockLimitKb)					.onChange(async (value) => {
						this.plugin.settings.softBlockLimitKb = value;
						if (this.plugin.settings.hardBlockLimitKb <= value) {
							this.plugin.settings.hardBlockLimitKb = Math.min(16000, value + 256);
						}
						softLimitValueEl.setText(`${this.plugin.settings.softBlockLimitKb} KB`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(softLimitValueEl);

		const hardLimitValueEl = createDiv();
		hardLimitValueEl.addClass('freeflow-ink-settings-value');
		hardLimitValueEl.setText(`${this.plugin.settings.hardBlockLimitKb} KB`);

		new Setting(containerEl)
			.setName('Hard save limit')
			.setDesc('Saving is blocked above this threshold to prevent severe performance issues.')
			.addSlider((slider) =>
				slider
					.setLimits(512, 16000, 256)
					.setValue(this.plugin.settings.hardBlockLimitKb)					.onChange(async (value) => {
						this.plugin.settings.hardBlockLimitKb = value;
						if (this.plugin.settings.softBlockLimitKb >= value) {
							this.plugin.settings.softBlockLimitKb = Math.max(200, value - 256);
							softLimitValueEl.setText(`${this.plugin.settings.softBlockLimitKb} KB`);
						}
						hardLimitValueEl.setText(`${this.plugin.settings.hardBlockLimitKb} KB`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(hardLimitValueEl);
	}

	hide(): void {
		this.detachPreviewResize?.();
		this.detachPreviewResize = null;
	}
}
