import { App, PluginSettingTab, Setting } from 'obsidian';
import type FreeFlowInkPlugin from './main';

// Bump this whenever you want to confirm at a glance that the iPad pulled the latest build.
// Keep it in step with the manifest "Sync marker".
export const FREEFLOW_BUILD_MARKER = '2026-06-10B';

export interface FreeFlowInkSettings {
	lineWidthScale: number;
	wordGapScale: number;
	renderLineHeightScale: number;
	renderStrokeFillScale: number;
	drawerHeightScale: number;
	idleAdvanceMs: number;
	releaseAdvanceDelayMs: number;
	advanceLinePosition: number;
	showWritingLine: boolean;
	velocityWidth: boolean;
	softBlockLimitKb: number;
	hardBlockLimitKb: number;
	showSoftLimitNotice: boolean;
}

export const DEFAULT_FREEFLOW_SETTINGS: FreeFlowInkSettings = {
	lineWidthScale: 1,
	wordGapScale: 1.35,
	renderLineHeightScale: 1,
	renderStrokeFillScale: 1,
	drawerHeightScale: 1,
	idleAdvanceMs: 2000,
	releaseAdvanceDelayMs: 260,
	advanceLinePosition: 85,
	showWritingLine: true,
	velocityWidth: true,
	softBlockLimitKb: 2048,
	hardBlockLimitKb: 8192,
	showSoftLimitNotice: false,
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

		new Setting(containerEl).setName('Writing behavior').setHeading();

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
			const writingLineMode = this.plugin.settings.showWritingLine ? 'On' : 'Off';
			previewValueEl.setText(
				`${screenProfile}\n` +
					`Viewport: ${metrics.viewportWidth}px x ${metrics.viewportHeight}px\n` +
					`Line width: ${metrics.lineWidthBasePx}px base -> ${metrics.lineWidthPx}px active\n` +
					`Rendered line spacing: ${renderLineSpacingPercent}%\n` +
					`Rendered stroke fill: ${renderStrokeFillPercent}%\n` +
					`Writing line guide: ${writingLineMode}\n` +
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
			.setName('Displayed line width')
			.setDesc(
				'Adjusts where inline handwriting wraps. Defaults are adaptive for phones and larger screens.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(40, 130, 1)
					.setValue(lineWidthPercent)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.lineWidthScale = value / 100;
						lineWidthValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
						renderAdaptivePreview();
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
					.setValue(wordGapPercent)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setLimits(10, 220, 1)
					.setValue(renderLineSpacingPercent)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setValue(renderStrokeFillPercent)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setValue(drawerHeightPercent)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
			.setName('Show writing line')
			.setDesc(
				'Shows a baseline guide in the drawer and rendered view so letters sit consistently above and below it.',
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

		new Setting(containerEl)
			.setName('Pause auto-scroll delay')
			.setDesc('If pen input pauses for this duration after lift, a step advance is triggered.')
			.addSlider((slider) =>
				slider
					.setLimits(500, 5000, 100)
					.setValue(this.plugin.settings.idleAdvanceMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setValue(this.plugin.settings.releaseAdvanceDelayMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setValue(this.plugin.settings.advanceLinePosition)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.advanceLinePosition = value;
						advanceLineValueEl.setText(`${value}%`);
						await this.plugin.saveSettings();
					}),
			)
			.controlEl.appendChild(advanceLineValueEl);

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
					.setValue(this.plugin.settings.softBlockLimitKb)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
					.setValue(this.plugin.settings.hardBlockLimitKb)
					.setDynamicTooltip()
					.onChange(async (value) => {
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
