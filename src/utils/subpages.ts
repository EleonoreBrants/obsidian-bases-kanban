export interface SubpageInfo {
	/** Nesting level inside the cell: 0 for top-level cards. */
	depth: number;
	/** Parent note path when the parent exists but is not in the same cell. */
	orphanParentPath: string | null;
}

export interface SubpageLayout {
	order: string[];
	info: Map<string, SubpageInfo>;
}

/** Levels beyond this render with the same indentation as this one. */
export const MAX_RENDERED_DEPTH = 4;

const WIKILINK_RE = /^\[\[([^\]]+)\]\]$/;

interface ListLike {
	length: () => number;
	get: (index: number) => { toString(): string };
}

function isListLike(value: unknown): value is ListLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'length' in value &&
		typeof value.length === 'function' &&
		'get' in value &&
		typeof value.get === 'function'
	);
}

/**
 * Link text of the parent stored in a property value, or null when empty.
 * Only the first item of a list counts. `[[Note|alias]]`/`[[Note#Heading]]`
 * reduce to `Note`; any other text is used as-is.
 */
export function parseParentLinkText(value: { toString(): string } | null | undefined): string | null {
	if (!value) return null;
	const raw = isListLike(value) ? (value.length() > 0 ? value.get(0).toString() : '') : value.toString();
	const text = raw.trim();
	if (!text) return null;
	const link = text.match(WIKILINK_RE);
	const target = (link ? link[1].split('|')[0] : text).replace(/[#^].*$/, '').trim();
	return target || null;
}

/**
 * Group cards of one cell under their parents. Siblings keep their relative
 * input order (manual or sorted), and a parent absent from `paths` leaves its
 * children as top-level cards. Cycles are broken at the first card seen.
 */
export function arrangeSubpages(paths: readonly string[], parentOf: ReadonlyMap<string, string>): SubpageLayout {
	const inCell = new Set(paths);
	const children = new Map<string, string[]>();
	const roots: string[] = [];
	for (const path of paths) {
		const parent = parentOf.get(path);
		if (parent && parent !== path && inCell.has(parent)) {
			const siblings = children.get(parent) ?? [];
			siblings.push(path);
			children.set(parent, siblings);
		} else {
			roots.push(path);
		}
	}

	const order: string[] = [];
	const info = new Map<string, SubpageInfo>();
	const visit = (path: string, depth: number): void => {
		if (info.has(path)) return;
		info.set(path, { depth, orphanParentPath: null });
		order.push(path);
		for (const child of children.get(path) ?? []) visit(child, depth + 1);
	};

	for (const root of roots) {
		visit(root, 0);
		const parent = parentOf.get(root);
		if (parent && parent !== root) {
			const entry = info.get(root);
			if (entry) entry.orphanParentPath = parent;
		}
	}
	for (const path of paths) visit(path, 0);
	return { order, info };
}
