import { Editor, MarkdownView, Modal, Notice, Platform, Plugin } from 'obsidian';
import { INK_CODE_BLOCK_LANGUAGE } from './ink/doc';
import { InkBlockRegistry } from './ink/blocks';
import { DrawerRuntimeConfig, InkDiagnosticResult, InkDrawer } from './ink/drawer';
import { StrokeNib } from './ink/render';
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
	private registry: InkBlockRegistry | null = null;
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
			name: 'Copy pointer capture log',
			callback: () => {
				this.showPencilTimingSummary();
			},
		});
		this.addCommand({
			id: 'reset-pencil-timing-summary',
			name: 'Reset pointer capture log',
			callback: () => {
				this.resetPencilTimingSummary();
			},
		});
		this.addCommand({
			id: 'copy-swatch-diagnostics',
			name: 'Copy colour swatch diagnostics',
			callback: () => {
				this.showSwatchDiagnostics();
			},
		});
		this.addCommand({
			id: 'copy-width-diagnostics',
			name: 'Copy block width diagnostics',
			callback: () => {
				this.showWidthDiagnostics();
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
			() => this.settings.showRenderWritingLine,
			(value) => {
				this.settings.showRenderWritingLine = value;
				void this.saveSettings();
			},
			() => this.settings.velocityWidth,
			() => this.settings.pressureWidth,
			() => this.settings.taperStrokeEnds,
			() => this.getStrokeWeight(),
			() => this.getNibConfig(),
			() => this.getSmoothing(),
			() => this.settings.matchTextWidth,
			() => clamp(this.settings.lineWidthScale, 0.3, 1),
			() => this.getSoftBlockLimitBytes(),
			() => this.getHardBlockLimitBytes(),
			() => this.settings.showSoftLimitNotice,
		);
		this.registry = registry;
		registry.register();
		this.addSettingTab(new FreeFlowInkSettingTab(this.app, this));
		this.registerDomEvent(activeWindow, 'resize', () => {
			this.applyRuntimeStyles();
			// Recompute full-width blocks for the new viewport.
			this.refreshInlineBlocks();
		});

		// Switching a note to Reading view should commit whatever is in the drawer rather than
		// stranding it: closing the drawer flushes the active block's pending save, so the read-only
		// render then shows the latest strokes.
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.closeDrawerIfReadingMode()),
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.closeDrawerIfReadingMode()),
		);

		this.register(() => {
			this.drawer?.destroy();
			this.drawer = null;
			this.registry = null;
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

	// When the active note flips to Reading view, close the drawer so its content is committed.
	// A no-op when the drawer is already closed or the view is still editable.
	private closeDrawerIfReadingMode(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.getMode() === 'preview') {
			this.drawer?.close();
		}
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
			velocityWidth: this.settings.velocityWidth,
			pressureWidth: this.settings.pressureWidth,
			taperStrokeEnds: this.settings.taperStrokeEnds,
			strokeWeight: this.getStrokeWeight(),
			nib: this.getNibConfig(),
			smoothing: this.getSmoothing(),
			palmRejection: this.settings.palmRejection,
			usePointerCapture: !iosLike,
			allowAnyNonMousePointer: iosLike,
		};
	}

	private getWordGapScale(): number {
		return clamp(this.settings.wordGapScale, 0.8, 2.5);
	}

	private getStrokeWeight(): number {
		return clamp(this.settings.strokeWeightScale, 0.5, 3);
	}

	private getSmoothing(): number {
		return clamp(this.settings.handwritingSmoothing, 0, 1);
	}

	// Re-render every mounted inline block (e.g. after toggling "Fill editor width" so the change is
	// visible without reopening notes).
	refreshInlineBlocks(): void {
		this.registry?.refreshAllInline();
	}

	// The active calligraphy-nib config (angle in radians, contrast 0..1), or null when disabled.
	private getNibConfig(): StrokeNib | null {
		if (!this.settings.calligraphyNib) {
			return null;
		}
		return {
			angleRad: (clamp(this.settings.nibAngle, -90, 90) * Math.PI) / 180,
			contrast: clamp(this.settings.nibContrast, 0, 1),
		};
	}

	getAdaptiveMetrics(): FreeFlowInkAdaptiveMetrics {
		const viewportWidth = Math.max(320, activeWindow.innerWidth || window.innerWidth || 1024);
		const viewportHeight = Math.max(420, activeWindow.innerHeight || window.innerHeight || 900);
		const isPhoneLike = viewportWidth <= 700;

		// The drawer toolbar now sits on top of the sheet (not in a side column), so only a small
		// edge margin is reserved horizontally — the rest is writing width.
		const drawerFrameWidth = Math.max(240, viewportWidth - (isPhoneLike ? 16 : 40));
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
		return clamp(this.settings.renderLineHeightScale, 0.1, 4.0);
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
		this.settings.lineWidthScale = clamp(this.settings.lineWidthScale, 0.3, 1);
		this.settings.wordGapScale = clamp(this.settings.wordGapScale, 0.8, 2.5);
		this.settings.strokeWeightScale = clamp(this.settings.strokeWeightScale, 0.5, 3);
		this.settings.nibAngle = clamp(Math.round(this.settings.nibAngle), -90, 90);
		this.settings.nibContrast = clamp(this.settings.nibContrast, 0, 1);
		this.settings.handwritingSmoothing = clamp(this.settings.handwritingSmoothing, 0, 1);
		this.settings.renderLineHeightScale = clamp(this.settings.renderLineHeightScale, 0.1, 4.0);
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
		modal.setTitle('Pointer capture log');
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

	// Reports the live colour-swatch elements' inline + computed styles, so a blank swatch on iPad
	// can be diagnosed from real device data rather than guessed. Compares meta swatches (the broken
	// ones) against the drawer swatch (which paints), and reports the parent button's layout.
	private showSwatchDiagnostics(): void {
		const lines: string[] = [];
		lines.push(`platform isIosApp=${Platform.isIosApp} dpr=${window.devicePixelRatio || 1}`);
		const describe = (label: string, el: Element | null): void => {
			if (!(el instanceof HTMLElement)) {
				lines.push(`${label}: not found`);
				return;
			}
			const cs = activeWindow.getComputedStyle(el);
			const parent = el.parentElement;
			const pcs = parent ? activeWindow.getComputedStyle(parent) : null;
			lines.push(
				`${label}: inlineBg='${el.style.backgroundColor}' inlineColor='${el.style.color}' ` +
					`computedBg=${cs.backgroundColor} boxShadow=${cs.boxShadow} display=${cs.display} ` +
					`size=${el.offsetWidth}x${el.offsetHeight} || parentDisplay=${pcs?.display ?? '?'} ` +
					`parentAppearance=${pcs?.getPropertyValue('appearance') || '?'}/${pcs?.getPropertyValue('-webkit-appearance') || '?'}`,
			);
		};
		const metaSwatches = activeDocument.querySelectorAll(
			'.freeflow-ink-meta-action.freeflow-ink-color-btn .freeflow-ink-color-btn-swatch',
		);
		lines.push(`meta swatches found=${metaSwatches.length}`);
		metaSwatches.forEach((el, i) => describe(`meta#${i}`, el));
		describe('drawer', activeDocument.querySelector('.freeflow-ink-drawer-btn .freeflow-ink-color-btn-swatch'));

		const modal = new Modal(this.app);
		modal.setTitle('Colour swatch diagnostics');
		const infoEl = modal.contentEl.createEl('p', { text: 'Copy this text and paste it into chat.' });
		infoEl.addClass('freeflow-ink-diagnostic-hint');
		const textEl = modal.contentEl.createEl('textarea');
		textEl.addClass('freeflow-ink-diagnostic-textarea');
		textEl.value = lines.join('\n');
		textEl.rows = 12;
		textEl.readOnly = true;
		textEl.focus();
		textEl.select();
		modal.open();
	}

	// Walks the ancestor chain above a full-width handwriting block up to the editor scroller and
	// reports each element's overflow + widths, plus whether the engine supports the `:has()`
	// selector the un-clip CSS relies on. Lets the "sides cut off" clipping be pinned from real iPad
	// data rather than guessed (run with a block visible and "Match text width" turned off).
	private showWidthDiagnostics(): void {
		const lines: string[] = [];
		let hasSelectorSupport = false;
		try {
			hasSelectorSupport = window.CSS?.supports?.('selector(:has(*))') ?? false;
		} catch {
			hasSelectorSupport = false;
		}
		lines.push(
			`platform isIosApp=${Platform.isIosApp} hasSelectorSupport=${hasSelectorSupport} ` +
				`winW=${Math.round(window.innerWidth)} dpr=${window.devicePixelRatio || 1}`,
		);
		const fillCount = activeDocument.querySelectorAll('.freeflow-ink-block.is-fill-width').length;
		lines.push(`fill-width blocks on screen=${fillCount}`);
		const block =
			activeDocument.querySelector('.freeflow-ink-block.is-fill-width') ??
			activeDocument.querySelector('.freeflow-ink-block');
		if (!(block instanceof HTMLElement)) {
			lines.push('No .freeflow-ink-block found. Open a note with a handwriting block first.');
		} else {
			const bRect = block.getBoundingClientRect();
			const bcs = activeWindow.getComputedStyle(block);
			lines.push(
				`block: isFill=${block.classList.contains('is-fill-width')} marginLeft=${bcs.marginLeft} ` +
					`overflow=${bcs.overflowX} padding=${bcs.paddingLeft}/${bcs.paddingRight} ` +
					`offsetW=${block.offsetWidth} clientW=${block.clientWidth} rectW=${Math.round(bRect.width)} ` +
					`rectL=${Math.round(bRect.left)} rectR=${Math.round(bRect.right)}`,
			);
			lines.push(`block.style="${block.style.cssText}"`);
			const canvas = block.querySelector('canvas.freeflow-ink-inline-canvas');
			if (canvas instanceof HTMLCanvasElement) {
				const cRect = canvas.getBoundingClientRect();
				const ccs = activeWindow.getComputedStyle(canvas);
				lines.push(
					`canvas: bitmap=${canvas.width}x${canvas.height} cssW=${ccs.width} ` +
						`rectW=${Math.round(cRect.width)} rectL=${Math.round(cRect.left)} rectR=${Math.round(cRect.right)}`,
				);
			} else {
				lines.push('canvas: not found inside block');
			}
			let el: HTMLElement | null = block.parentElement;
			let depth = 0;
			while (el && depth < 20) {
				const cs = activeWindow.getComputedStyle(el);
				const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
				const rect = el.getBoundingClientRect();
				const contain = cs.getPropertyValue('contain') || '-';
				const cv = cs.getPropertyValue('content-visibility') || '-';
				lines.push(
					`#${depth} <${el.tagName.toLowerCase()}> "${cls}" ovX=${cs.overflowX} ` +
						`contain=${contain} cv=${cv} ` +
						`clientW=${el.clientWidth} scrollW=${el.scrollWidth} ` +
						`rectL=${Math.round(rect.left)} rectR=${Math.round(rect.right)}`,
				);
				if (
					el.classList.contains('markdown-preview-view') ||
					el.classList.contains('cm-scroller')
				) {
					break;
				}
				el = el.parentElement;
				depth += 1;
			}
		}

		const modal = new Modal(this.app);
		modal.setTitle('Block width diagnostics');
		const infoEl = modal.contentEl.createEl('p', { text: 'Copy this text and paste it into chat.' });
		infoEl.addClass('freeflow-ink-diagnostic-hint');
		const textEl = modal.contentEl.createEl('textarea');
		textEl.addClass('freeflow-ink-diagnostic-textarea');
		textEl.value = lines.join('\n');
		textEl.rows = 14;
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
