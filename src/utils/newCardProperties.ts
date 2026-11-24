export type CopyFromParentMode = 'listed' | 'except';

export interface ParsedDefaultProperties {
	defaults: Record<string, unknown>;
	invalid: string[];
}

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const DEFAULT_LINE_RE = /^([^=]+?)\s*=\s*(.*)$/;

const lower = (text: string): string => text.toLowerCase();

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	return Array.isArray(value) && value.length === 0;
}

function findKey(frontmatter: Record<string, unknown>, name: string): string | undefined {
	const wanted = lower(name);
	return Object.keys(frontmatter).find((key) => lower(key) === wanted);
}

/** Split on commas that are not inside a `[[wikilink]]`. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (let i = 0; i < text.length; i++) {
		const pair = text.slice(i, i + 2);
		if (pair === '[[') {
			depth++;
			current += pair;
			i++;
		} else if (pair === ']]' && depth > 0) {
			depth--;
			current += pair;
			i++;
		} else if (text[i] === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += text[i];
		}
	}
	parts.push(current);
	return parts;
}

function parseScalar(text: string): unknown {
	if (text === 'true') return true;
	if (text === 'false') return false;
	if (NUMBER_RE.test(text)) return Number(text);
	return text;
}

function parseDefaultValue(text: string): unknown {
	const parts = splitTopLevel(text);
	if (parts.length === 1) return parseScalar(text);
	return parts
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.map(parseScalar);
}

/** Parse the "Default properties" option: one `Property = value` entry per line. */
export function parseDefaultProperties(raw: unknown): ParsedDefaultProperties {
	const defaults: Record<string, unknown> = {};
	const invalid: string[] = [];
	if (!Array.isArray(raw)) return { defaults, invalid };

	for (const entry of raw) {
		if (typeof entry !== 'string' || entry.trim() === '') continue;
		const match = entry.trim().match(DEFAULT_LINE_RE);
		const value = match?.[2]?.trim() ?? '';
		if (!match || value === '') {
			invalid.push(entry);
			continue;
		}
		const name = match[1] ?? '';
		const existing = findKey(defaults, name);
		if (existing) delete defaults[existing];
		defaults[name] = parseDefaultValue(value);
	}
	return { defaults, invalid };
}

export function parseCopyFromParentMode(raw: unknown): CopyFromParentMode {
	return raw === 'except' ? 'except' : 'listed';
}

export function parsePropertyNames(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Choose which of the parent's frontmatter values a new sub-page receives.
 * Empty values and the reserved properties (parent link, column, swimlane) are never copied.
 */
export function selectParentProperties(
	parentFrontmatter: Record<string, unknown> | null | undefined,
	mode: CopyFromParentMode,
	names: readonly string[],
	reserved: readonly string[],
): Record<string, unknown> {
	const selected: Record<string, unknown> = {};
	if (!parentFrontmatter) return selected;
	const listed = new Set(names.map(lower));
	const skipped = new Set(reserved.map(lower));

	for (const [key, value] of Object.entries(parentFrontmatter)) {
		const name = lower(key);
		if (skipped.has(name) || isEmptyValue(value)) continue;
		if (listed.has(name) !== (mode === 'listed')) continue;
		selected[key] = structuredClone(value);
	}
	return selected;
}

const NOTE_BRACKET_RE = /^note\[\s*(["'])(.+?)\1\s*\]/;
const NOTE_NAME_RE = /^(?:note\.)?([^\s=!<>()[\]"'.,]+)/;
const METHOD_OR_OPERATOR_RE = /^\s*(?:\.\w+\s*\(|==|!=|>=|<=|>|<)/;
const HAS_PROPERTY_RE = /^file\.hasProperty\(\s*(["'])(.+?)\1/;
const FILE_TAGS_RE = /^file\.(?:hasTag\(|tags\b)/;
const LIST_WRAPPER_RE = /^list\((.*?)\)(\..*)$/;

/**
 * Properties a single filter expression can make Bases write on a new card.
 * Returns null when the expression is not recognised.
 */
function leafProperties(expression: string): string[] | null {
	let text = expression.trim();
	while (text.startsWith('!') || text.startsWith('(')) text = text.slice(1).trim();

	const wrapped = text.match(LIST_WRAPPER_RE);
	if (wrapped) text = `${wrapped[1] ?? ''}${wrapped[2] ?? ''}`;

	const hasProperty = text.match(HAS_PROPERTY_RE);
	if (hasProperty?.[2]) return [hasProperty[2]];
	if (FILE_TAGS_RE.test(text)) return ['tags'];
	if (text.startsWith('file.') || text.startsWith('formula.')) return [];

	const bracket = text.match(NOTE_BRACKET_RE);
	if (bracket?.[2]) return METHOD_OR_OPERATOR_RE.test(text.slice(bracket[0].length)) ? [bracket[2]] : null;

	const named = text.match(NOTE_NAME_RE);
	if (named?.[1] && METHOD_OR_OPERATOR_RE.test(text.slice(named[0].length))) return [named[1]];
	return null;
}

interface FilterScan {
	optional: Set<string>;
	required: Set<string>;
	unparsedRequired: string[];
}

function scanFilter(node: unknown, optional: boolean, negated: boolean, scan: FilterScan): void {
	if (typeof node === 'string') {
		if (negated) return;
		const names = leafProperties(node);
		if (names === null) {
			if (!optional) scan.unparsedRequired.push(node);
			return;
		}
		for (const name of names) (optional ? scan.optional : scan.required).add(lower(name));
		return;
	}
	if (!isRecord(node)) return;

	const group = node;
	if (Array.isArray(group.and)) {
		for (const child of group.and) scanFilter(child, optional, negated, scan);
	}
	if (Array.isArray(group.or)) {
		// Bases collapses a one-element `or` into its only child.
		const branchOptional = optional || group.or.length > 1;
		for (const child of group.or) scanFilter(child, branchOptional, negated, scan);
	}
	if (Array.isArray(group.not)) {
		for (const child of group.not) scanFilter(child, optional, !negated, scan);
	}
}

/**
 * Properties that Bases copies onto a new card only because they appear in an
 * `or`/`not` branch of the filters, so the card does not need them to stay visible.
 * Lower-cased. Properties also required by an `and` condition, or mentioned by an
 * expression this parser does not understand, are never returned.
 */
export function getOptionalFilterProperties(...filters: unknown[]): Set<string> {
	const scan: FilterScan = { optional: new Set(), required: new Set(), unparsedRequired: [] };
	for (const filter of filters) scanFilter(filter, false, false, scan);

	const result = new Set<string>();
	for (const name of scan.optional) {
		if (scan.required.has(name)) continue;
		if (scan.unparsedRequired.some((text) => lower(text).includes(name))) continue;
		result.add(name);
	}
	return result;
}

/** Filters (global and for one view) of a parsed `.base` file, or null when the view is not found. */
export function getViewFilters(base: unknown, viewName: string): unknown[] | null {
	if (!isRecord(base) || !Array.isArray(base.views)) return null;
	const view: unknown = base.views.find((candidate: unknown) => isRecord(candidate) && candidate.name === viewName);
	if (!isRecord(view)) return null;
	return [base.filters, view.filters].filter((filter) => filter !== undefined && filter !== null);
}

/**
 * Drop values Bases injected from `or`/`not` filter branches. A displayed property
 * keeps its empty placeholder, as Bases would have created it.
 */
export function removeOptionalFilterValues(
	frontmatter: Record<string, unknown>,
	optional: ReadonlySet<string>,
	displayed: ReadonlySet<string>,
): void {
	if (optional.size === 0) return;
	for (const key of Object.keys(frontmatter)) {
		const name = lower(key);
		if (!optional.has(name) || isEmptyValue(frontmatter[key])) continue;
		if (displayed.has(name)) frontmatter[key] = null;
		else delete frontmatter[key];
	}
}

/** Set `value` unless a property of that name (any case) already holds one. */
export function setPropertyIfEmpty(frontmatter: Record<string, unknown>, name: string, value: unknown): void {
	const key = findKey(frontmatter, name) ?? name;
	if (isEmptyValue(frontmatter[key])) frontmatter[key] = structuredClone(value);
}

/** Set `value`, replacing a property of that name written in another case. */
export function setProperty(frontmatter: Record<string, unknown>, name: string, value: unknown): void {
	frontmatter[findKey(frontmatter, name) ?? name] = value;
}
