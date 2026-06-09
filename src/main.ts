import { Editor, MarkdownView, Modal, Notice, Platform, Plugin } from 'obsidian';
import { INK_CODE_BLOCK_LANGUAGE } from './ink/doc';
import { InkBlockRegistry } from './ink/blocks';
import { DrawerRuntimeConfig, InkDiagnosticResult, InkDrawer } from './ink/drawer';
import {
	DEFAULT_FREEFLOW_SETTINGS,
	FreeFlowInkSettingTab,
	FreeFlowInkSettings,
} from './settings';

export interface FreeFlowInkAdaptiveMetrics {
	viewportWidth: number;
	viewportHeight: number;
	isPhoneLike: boolean;
	lineWidthBasePx: number;
	lineWidthPx: number;
	renderLineHeightScale: number;
	renderStrokeFillScale: number;
	drawerHeightBasePx: number;
	drawerHeightPx: number;
}

export default class FreeFlowInkPlugin extends Plugin {
	settings: FreeFlowInkSettings = { ...DEFAULT_FREEFLOW_SETTINGS };
	private drawer: InkDrawer | null = null;
	private runtimeStyleEl: HTMLStyleElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.ensureRuntimeStyle();
		this.applyRuntimeStyles();

		this.drawer = new InkDrawer(() => this.getDrawerRuntimeConfig());
		this.addCommand({
			id: 'run-basic-ink-diagnostics',
			name: 'Run basic diagnostics',
			callback: () => {
				this.runBasicInkDiagnostics();
			},
		});
		this.addCommand({
			id: 'show-pencil-timing-summary',
			name: 'Show pencil timing summary',
			callback: () => {
				this.showPencilTimingSummary();
			},
		});
		this.addCommand({
			id: 'reset-pencil-timing-summary',
			name: 'Reset pencil timing summary',
			callback: () => {
				this.resetPencilTimingSummary();
			},
		});
		this.addCommand({
			id: 'insert-freeflow-ink-block',
			name: 'Insert handwriting block',
			editorCallback: (editor) => {
				this.insertInkBlockAtCursor(editor);
			},
		});
		this.addRibbonIcon('pencil-line', 'New handwriting block', () => {
			this.insertInkBlockFromRibbon();
		});
		const registry = new InkBlockRegistry(
			this,
			this.drawer,
			() => this.getWrapWidthWorld(),
			() => this.getWordGapScale(),
			() => this.getRenderLineHeightScale(),
			() => this.getRenderStrokeFillScale(),
			() => this.settings.showWritingLine,
			() => this.getSoftBlockLimitBytes(),
			() => this.getHardBlockLimitBytes(),
			() => this.settings.showSoftLimitNotice,
		);
		registry.register();
		this.addSettingTab(new FreeFlowInkSettingTab(this.app, this));
		this.registerDomEvent(activeWindow, 'resize', () => this.applyRuntimeStyles());

		this.register(() => {
			this.drawer?.destroy();
			this.drawer = null;
			this.runtimeStyleEl?.remove();
			this.runtimeStyleEl = null;
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_FREEFLOW_SETTINGS,
			(await this.loadData()) as Partial<FreeFlowInkSettings>,
		);
		this.normalizeSettings();
	}

	async saveSettings(): Promise<void> {
		this.normalizeSettings();
		await this.saveData(this.settings);
		this.applyRuntimeStyles();
	}

	private getDrawerRuntimeConfig(): DrawerRuntimeConfig {
		const iosLike = this.isIOSLikeDevice();
		return {
			wrapWidth: this.getWrapWidthWorld(),
			wordGapScale: this.getWordGapScale(),
			idleAdvanceMs: this.settings.idleAdvanceMs,
			releaseAdvanceDelayMs: this.settings.releaseAdvanceDelayMs,
			advanceTriggerRatio: clamp(this.settings.advanceLinePosition, 50, 95) / 100,
			showWritingLine: this.settings.showWritingLine,
			usePointerCapture: !iosLike,
			allowAnyNonMousePointer: iosLike,
		};
	}

	private getWordGapScale(): number {
		return clamp(this.settings.wordGapScale, 0.8, 2.5);
	}

	getAdaptiveMetrics(): FreeFlowInkAdaptiveMetrics {
		const viewportWidth = Math.max(320, activeWindow.innerWidth || window.innerWidth || 1024);
		const viewportHeight = Math.max(420, activeWindow.innerHeight || window.innerHeight || 900);
		const isPhoneLike = viewportWidth <= 700;

		const drawerFrameWidth = Math.max(240, viewportWidth - (isPhoneLike ? 86 : 100));
		const lineWidthBasePx = Math.round(drawerFrameWidth * (isPhoneLike ? 0.94 : 0.9));
		const lineWidthPx = clamp(
			Math.round(lineWidthBasePx * this.settings.lineWidthScale),
			80,
			1400,
		);

		const drawerHeightBasePx = Math.round(viewportHeight * (isPhoneLike ? 0.34 : 0.26));
		const drawerHeightPx = clamp(
			Math.round(drawerHeightBasePx * this.settings.drawerHeightScale),
			isPhoneLike ? 70 : 80,
			isPhoneLike ? 380 : 320,
		);

		return {
			viewportWidth,
			viewportHeight,
			isPhoneLike,
			lineWidthBasePx,
			lineWidthPx,
			renderLineHeightScale: this.getRenderLineHeightScale(),
			renderStrokeFillScale: this.getRenderStrokeFillScale(),
			drawerHeightBasePx,
			drawerHeightPx,
		};
	}

	getRenderLineHeightScale(): number {
		return clamp(this.settings.renderLineHeightScale, 0.1, 2.2);
	}

	getRenderStrokeFillScale(): number {
		return clamp(this.settings.renderStrokeFillScale, 0.4, 1.6);
	}

	private getWrapWidthWorld(): number {
		return this.getAdaptiveMetrics().lineWidthPx;
	}

	private getSoftBlockLimitBytes(): number {
		return Math.max(200_000, Math.round(this.settings.softBlockLimitKb * 1024));
	}

	private getHardBlockLimitBytes(): number {
		return Math.max(512_000, Math.round(this.settings.hardBlockLimitKb * 1024));
	}

	private getDrawerHeightPx(): number {
		return this.getAdaptiveMetrics().drawerHeightPx;
	}

	private ensureRuntimeStyle(): void {
		if (this.runtimeStyleEl) {
			return;
		}
		const styleEl = activeDocument.createElement('style');
		styleEl.id = 'freeflow-ink-runtime-style';
		activeDocument.head.appendChild(styleEl);
		this.runtimeStyleEl = styleEl;
	}

	private applyRuntimeStyles(): void {
		this.ensureRuntimeStyle();
		if (!this.runtimeStyleEl) {
			return;
		}
		const drawerHeight = this.getDrawerHeightPx();
		this.runtimeStyleEl.textContent = `.freeflow-ink-drawer-canvas { height: ${drawerHeight}px; }`;
		this.drawer?.refreshLayout();
	}

	private normalizeSettings(): void {
		this.settings.softBlockLimitKb = clamp(Math.round(this.settings.softBlockLimitKb), 200, 12000);
		this.settings.hardBlockLimitKb = clamp(Math.round(this.settings.hardBlockLimitKb), 512, 16000);
		this.settings.wordGapScale = clamp(this.settings.wordGapScale, 0.8, 2.5);
		this.settings.renderLineHeightScale = clamp(this.settings.renderLineHeightScale, 0.1, 2.2);
		this.settings.renderStrokeFillScale = clamp(this.settings.renderStrokeFillScale, 0.4, 1.6);
		this.settings.drawerHeightScale = clamp(this.settings.drawerHeightScale, 0.3, 1.5);
		this.settings.idleAdvanceMs = clamp(Math.round(this.settings.idleAdvanceMs), 500, 5000);
		this.settings.releaseAdvanceDelayMs = clamp(
			Math.round(this.settings.releaseAdvanceDelayMs),
			0,
			1200,
		);
		this.settings.advanceLinePosition = clamp(Math.round(this.settings.advanceLinePosition), 50, 95);
		if (this.settings.hardBlockLimitKb <= this.settings.softBlockLimitKb) {
			this.settings.hardBlockLimitKb = Math.min(16000, this.settings.softBlockLimitKb + 256);
		}
	}

	private runBasicInkDiagnostics(): void {
		if (!this.drawer) {
			new Notice('Freeflow ink drawer is not ready yet.');
			return;
		}

		const results = this.drawer.runBasicDiagnostics();
		const failed = results.filter((result) => !result.pass);
		const status = failed.length === 0 ? 'PASS' : 'FAIL';
		const summary = `Ink diagnostics ${status}: ${results.length - failed.length}/${results.length} passing`;
		if (failed.length === 0) {
			new Notice(summary, 7000);
			return;
		}

		const failureLines = failed
			.slice(0, 3)
			.map((result: InkDiagnosticResult) => `${result.name}: ${result.detail}`)
			.join(' | ');
		new Notice(`${summary}. ${failureLines}`, 9000);
	}

	private showPencilTimingSummary(): void {
		if (!this.drawer) {
			new Notice('Ink drawer is not ready yet.');
			return;
		}
		const summary = this.drawer.getPencilTimingSummary();
		const modal = new Modal(this.app);
		modal.setTitle('Pencil timing summary');
		const infoEl = modal.contentEl.createEl('p', {
			text: 'Copy this text and paste it into chat.',
		});
		infoEl.addClass('freeflow-ink-diagnostic-hint');
		const textEl = modal.contentEl.createEl('textarea');
		textEl.addClass('freeflow-ink-diagnostic-textarea');
		textEl.value = `Pencil timing: ${summary}`;
		textEl.rows = 8;
		textEl.readOnly = true;
		textEl.focus();
		textEl.select();
		modal.open();
	}

	private resetPencilTimingSummary(): void {
		if (!this.drawer) {
			new Notice('Ink drawer is not ready yet.');
			return;
		}
		this.drawer.resetPencilTimingDiagnostics();
		new Notice('Pencil timing summary reset.');
	}

	private isIOSLikeDevice(): boolean {
		return Platform.isIosApp;
	}

	private insertInkBlockFromRibbon(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('Open a note in edit mode to add a handwriting block.');
			return;
		}
		this.insertInkBlockAtCursor(view.editor);
	}

	private insertInkBlockAtCursor(editor: Editor): void {
		const cursor = editor.getCursor();
		const onBlankLine = editor.getLine(cursor.line).trim().length === 0;
		const prefix = onBlankLine ? '' : '\n';
		// An empty body parses to an empty document, ready to write into.
		const block = `${prefix}\`\`\`${INK_CODE_BLOCK_LANGUAGE}\n\n\`\`\`\n`;
		editor.replaceSelection(block);
	}
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}
