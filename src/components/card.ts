import type { App, BasesEntry, BasesPropertyId, Component } from 'obsidian';
import { Keymap, MarkdownRenderer, NullValue, StringValue, setIcon } from 'obsidian';
import type { TFile } from 'obsidian';
import { CSS_CLASSES, DATA_ATTRIBUTES } from '../constants.ts';
import { findRuleColor, type ColorRule } from '../utils/colorRules.ts';
import { MAX_RENDERED_DEPTH, type SubpageInfo } from '../utils/subpages.ts';

export interface SubpageRenderCtx {
	enabled: boolean;
	info: Map<string, SubpageInfo>;
}

export interface CardRenderCtx {
	subpages: SubpageRenderCtx;
	colorRules: ColorRule[];
	app: App;
	component: Component;
	groupByPropertyId: BasesPropertyId | null;
	cardTitlePropertyId: BasesPropertyId | null;
	imagePropertyId: BasesPropertyId | null;
	imageFit: string;
	imageAspectRatio: number;
	wrapValues: boolean;
	order: BasesPropertyId[];
	getDisplayName: (id: BasesPropertyId) => string;
}

export interface CardCallbacks {
	onHoverPreview: (linktext: string, sourcePath: string, event: MouseEvent, targetEl: HTMLElement) => void;
	onSetActiveCard: (path: string | null) => void;
	onOpenInBackgroundTab: (file: TFile) => void;
	onAddChild: (cardEl: HTMLElement, file: TFile) => void;
}

export function applyCardDepth(cardEl: HTMLElement, info: SubpageInfo | undefined): void {
	const depth = info?.depth ?? 0;
	if (depth === 0) {
		cardEl.removeAttribute(DATA_ATTRIBUTES.SUBPAGE_DEPTH);
		cardEl.style.removeProperty('--obk-depth');
		cardEl.classList.remove(CSS_CLASSES.CARD_SUBPAGE);
		return;
	}
	cardEl.setAttribute(DATA_ATTRIBUTES.SUBPAGE_DEPTH, String(depth));
	cardEl.style.setProperty('--obk-depth', String(Math.min(depth, MAX_RENDERED_DEPTH)));
	cardEl.classList.add(CSS_CLASSES.CARD_SUBPAGE);
}

export function computeCardFingerprint(entry: BasesEntry, ctx: CardRenderCtx): string {
	const parts: string[] = [];
	for (const propId of ctx.order) {
		if (propId === ctx.groupByPropertyId) continue;
		const val = entry.getValue(propId);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.cardTitlePropertyId) {
		const val = entry.getValue(ctx.cardTitlePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	if (ctx.imagePropertyId) {
		const val = entry.getValue(ctx.imagePropertyId);
		parts.push(val === null ? '' : val.toString());
	}
	parts.push(getCardBannerColor(entry, ctx) ?? '');
	if (ctx.subpages.enabled) parts.push(ctx.subpages.info.get(entry.file.path)?.orphanParentPath ?? '');
	return parts.join('\x00');
}

export function getCardBannerColor(entry: BasesEntry, ctx: CardRenderCtx): string | null {
	if (ctx.colorRules.length === 0) return null;
	return findRuleColor(ctx.colorRules, (id) => entry.getValue(id));
}

export function renderCardTitle(titleEl: HTMLElement, entry: BasesEntry, ctx: CardRenderCtx): void {
	if (!ctx.cardTitlePropertyId) {
		titleEl.textContent = entry.file.basename;
		return;
	}
	const titleValue = entry.getValue(ctx.cardTitlePropertyId);
	if (!titleValue || titleValue instanceof NullValue) {
		titleEl.textContent = entry.file.basename;
		return;
	}
	titleValue.renderTo(titleEl, ctx.app.renderContext);
}

export function renderCardCover(
	coverEl: HTMLElement,
	entry: BasesEntry,
	filePath: string,
	ctx: CardRenderCtx,
): boolean {
	if (!ctx.imagePropertyId) return false;
	const value = entry.getValue(ctx.imagePropertyId);
	if (!value || value instanceof NullValue) return false;
	const raw = value.toString().trim();
	if (!raw) return false;

	if (/^https?:\/\//i.test(raw)) {
		coverEl.createEl('img', { attr: { src: raw, alt: '' } });
		return true;
	}

	let linkText = raw.replace(/^!\s*/, '');
	const wikiMatch = linkText.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
	if (wikiMatch) linkText = wikiMatch[1];
	linkText = linkText.trim();
	if (!linkText) return false;

	const app = ctx.app;
	if (!app) return false;
	const file = app.metadataCache.getFirstLinkpathDest(linkText, filePath);
	if (!file) return false;

	coverEl.createEl('img', {
		attr: { src: app.vault.getResourcePath(file), alt: '' },
	});
	return true;
}

export function createCard(entry: BasesEntry, ctx: CardRenderCtx, cb: CardCallbacks): HTMLElement {
	const cardEl = createDiv({ cls: CSS_CLASSES.CARD });
	const filePath = entry.file.path;
	cardEl.setAttribute(DATA_ATTRIBUTES.ENTRY_PATH, filePath);

	const bannerColor = getCardBannerColor(entry, ctx);
	if (bannerColor) {
		cardEl.createDiv({ cls: CSS_CLASSES.CARD_BANNER }).style.backgroundColor = bannerColor;
	}

	if (ctx.imagePropertyId) {
		const coverEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_COVER });
		coverEl.classList.add(
			ctx.imageFit === 'contain' ? CSS_CLASSES.CARD_COVER_FIT_CONTAIN : CSS_CLASSES.CARD_COVER_FIT_COVER,
		);
		coverEl.style.aspectRatio = `1 / ${ctx.imageAspectRatio}`;
		const rendered = renderCardCover(coverEl, entry, filePath, ctx);
		if (!rendered) coverEl.remove();
	}

	const titleEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_TITLE });
	renderCardTitle(titleEl, entry, ctx);

	if (ctx.subpages.enabled) {
		const subpageInfo = ctx.subpages.info.get(filePath);
		applyCardDepth(cardEl, subpageInfo);
		const orphanParent = subpageInfo?.orphanParentPath;
		if (orphanParent) {
			const parentName = orphanParent.split('/').pop()?.replace(/\.md$/i, '') ?? orphanParent;
			const pill = cardEl.createDiv({ cls: CSS_CLASSES.CARD_PARENT_PILL, text: `↳ ${parentName}` });
			pill.setAttribute('title', `Parent: ${parentName}`);
			pill.addEventListener('click', (e) => {
				e.stopPropagation();
				void ctx.app.workspace.openLinkText(orphanParent, '', Keymap.isModEvent(e));
			});
		}
		const addBtn = cardEl.createDiv({ cls: CSS_CLASSES.CARD_ADD_CHILD });
		addBtn.setAttribute('role', 'button');
		addBtn.setAttribute('tabindex', '0');
		addBtn.setAttribute('aria-label', `Add sub-page to ${entry.file.basename}`);
		setIcon(addBtn, 'plus');
		const addChild = (e: Event) => {
			e.stopPropagation();
			e.preventDefault();
			cb.onAddChild(cardEl, entry.file);
		};
		addBtn.addEventListener('click', addChild);
		addBtn.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') addChild(e);
		});
		addBtn.addEventListener('auxclick', (e) => e.stopPropagation());
	}

	for (const propertyId of ctx.order) {
		if (propertyId === ctx.groupByPropertyId) continue;
		const value = entry.getValue(propertyId);
		if (!value || value instanceof NullValue) continue;
		if (!value.toString().trim()) continue;
		const label = ctx.getDisplayName(propertyId);
		const propertyEl = cardEl.createDiv({ cls: CSS_CLASSES.CARD_PROPERTY });
		propertyEl.setAttribute('data-label', propertyId);
		if (ctx.wrapValues) {
			propertyEl.classList.add(CSS_CLASSES.CARD_PROPERTY_WRAP);
		}
		propertyEl.createSpan({ text: label, cls: CSS_CLASSES.CARD_PROPERTY_LABEL });
		const valueEl = propertyEl.createSpan({ cls: CSS_CLASSES.CARD_PROPERTY_VALUE });
		// Keep typed values on their native renderers, including localized dates.
		// Only plain strings containing Markdown links need parsing.
		const text = value.toString();
		if (
			Object.getPrototypeOf(value) === StringValue.prototype &&
			/\[[^\]\n]+\]\([^\n]+\)/.test(text) &&
			!/[!<]/.test(text)
		) {
			void MarkdownRenderer.render(ctx.app, text, valueEl, filePath, ctx.component).catch((error: unknown) => {
				valueEl.textContent = text;
				console.error('KanbanView: could not render property link', error);
			});
		} else value.renderTo(valueEl, ctx.app.renderContext);
	}

	// JS-managed hover: mouseenter/mouseleave instead of CSS :hover so the
	// class is never applied when an element slides under a stationary cursor
	// after a drag reorders the DOM.
	cardEl.addEventListener('mouseenter', () => cardEl.classList.add(CSS_CLASSES.CARD_HOVER));
	cardEl.addEventListener('mouseleave', () => cardEl.classList.remove(CSS_CLASSES.CARD_HOVER));
	cardEl.addEventListener('mouseover', (e) => {
		if (e.target instanceof Element && e.target.closest('a')) return;
		if (e.relatedTarget instanceof Element && cardEl.contains(e.relatedTarget)) return;
		cb.onHoverPreview(filePath, '', e, cardEl);
	});

	const clickHandler = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest('a')) return;
		if (e.type === 'auxclick' && e.button !== 1) return;
		cb.onSetActiveCard(filePath);
		if (!ctx.app?.workspace) return;
		if (e.button === 1) {
			cb.onOpenInBackgroundTab(entry.file);
			return;
		}
		void ctx.app.workspace.openLinkText(filePath, '', Keymap.isModEvent(e));
	};
	cardEl.addEventListener('click', clickHandler);
	cardEl.addEventListener('auxclick', clickHandler);

	// Prevent middle-click autoscroll inside cards.
	cardEl.addEventListener('mousedown', (e) => {
		if (e.button !== 1) return;
		if (e.target instanceof Element && e.target.closest('a')) return;
		e.preventDefault();
	});

	return cardEl;
}
