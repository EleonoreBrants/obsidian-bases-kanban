import type { BasesPropertyId } from 'obsidian';
import { NullValue } from 'obsidian';

export type ColorRuleOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'empty' | '!empty';

export interface ColorRule {
	propertyId: BasesPropertyId;
	operator: ColorRuleOperator;
	value: string;
	color: string;
}

export interface ParsedColorRules {
	rules: ColorRule[];
	invalid: string[];
}

/** Minimal shape of a Bases `Value`, so rules can be evaluated without importing obsidian at runtime. */
export interface RuleValue {
	toString(): string;
}

const SYMBOL_OPERATOR_RE = /^(.+?)\s*(>=|<=|!=|=|>|<)\s*(.*)$/;
const WORD_OPERATOR_RE = /^(.+?)\s+(contains|!empty|empty)(?:\s+(.*))?$/;
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([^()]*\)|var\(--[\w-]+\))$/i;
const PROPERTY_PREFIX_RE = /^(note|file|formula)\./;
const WIKILINK_RE = /^\[\[([^\]]+)\]\]$/;

function stripQuotes(text: string): string {
	const match = text.match(/^(["'])(.*)\1$/);
	return match ? match[2] : text;
}

function isPropertyId(name: string): name is BasesPropertyId {
	return PROPERTY_PREFIX_RE.test(name);
}

function toPropertyId(name: string): BasesPropertyId {
	return isPropertyId(name) ? name : `note.${name}`;
}

const OPERATORS: readonly string[] = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'empty', '!empty'];

function isOperator(text: string): text is ColorRuleOperator {
	return OPERATORS.includes(text);
}

interface ListLike {
	length: () => number;
	get: (index: number) => RuleValue;
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

function parseRule(line: string): ColorRule | null {
	const arrow = line.lastIndexOf('->');
	if (arrow < 0) return null;
	const condition = line.slice(0, arrow).trim();
	const color = line.slice(arrow + 2).trim();
	if (!condition || !COLOR_RE.test(color)) return null;

	const symbol = condition.match(SYMBOL_OPERATOR_RE);
	const word = condition.match(WORD_OPERATOR_RE);
	// The operator that appears first wins, so a value may itself contain "=" or "contains".
	const useWord = word !== null && (symbol === null || word[1].length < symbol[1].length);
	const match = useWord ? word : symbol;
	if (!match) return null;

	const property = match[1].trim();
	const operator = match[2];
	if (!isOperator(operator)) return null;
	const value = stripQuotes((match[3] ?? '').trim());
	const needsValue = operator !== 'empty' && operator !== '!empty';
	if (!property || (needsValue && !value) || (!needsValue && value)) return null;
	return { propertyId: toPropertyId(property), operator, value, color };
}

/**
 * Parse the "Color rules" option. Accepts one rule per entry (multitext option)
 * or a newline-separated string. Format: `Property operator value -> color`.
 */
export function parseColorRules(raw: unknown): ParsedColorRules {
	const lines = Array.isArray(raw)
		? raw.filter((item): item is string => typeof item === 'string')
		: typeof raw === 'string'
			? raw.split(/\r?\n/)
			: [];
	const rules: ColorRule[] = [];
	const invalid: string[] = [];
	for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
		const rule = parseRule(line);
		if (rule) rules.push(rule);
		else invalid.push(line);
	}
	return { rules, invalid };
}

function normalize(text: string): string {
	return text.trim().toLowerCase();
}

/** Candidate strings for one list item; a wikilink matches both its target name and its alias. */
function itemCandidates(text: string): string[] {
	const link = text.trim().match(WIKILINK_RE);
	if (!link) return [normalize(text)];
	const [target, alias] = link[1].split('|');
	const name =
		target
			.replace(/[#^].*$/, '')
			.split('/')
			.pop() ?? target;
	return [normalize(name), ...(alias ? [normalize(alias)] : [])];
}

function valueStrings(value: RuleValue | null | undefined): string[][] {
	// Bases stringifies a missing property as "null"; it must count as empty.
	if (!value || value instanceof NullValue) return [];
	const items: string[] = [];
	if (isListLike(value)) {
		const count = value.length();
		for (let i = 0; i < count; i++) {
			const item = value.get(i);
			if (!(item instanceof NullValue)) items.push(item.toString());
		}
	} else {
		items.push(value.toString());
	}
	return items.filter((item) => item.trim() !== '').map(itemCandidates);
}

function compare(left: string, right: string): number {
	const leftNumber = Number(left);
	const rightNumber = Number(right);
	if (left !== '' && right !== '' && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
		return leftNumber - rightNumber;
	}
	return left < right ? -1 : left > right ? 1 : 0;
}

export function ruleMatches(rule: ColorRule, value: RuleValue | null | undefined): boolean {
	const items = valueStrings(value);
	// A link written in the rule (`[[Note]]`) compares by note name, like the property value does.
	const expectedCandidates = itemCandidates(rule.value);
	const expected = expectedCandidates[0];
	const any = (test: (candidate: string) => boolean) => items.some((candidates) => candidates.some(test));
	switch (rule.operator) {
		case 'empty':
			return items.length === 0;
		case '!empty':
			return items.length > 0;
		case '=':
			return any((c) => expectedCandidates.includes(c));
		case '!=':
			return !any((c) => expectedCandidates.includes(c));
		case 'contains':
			return any((c) => c.includes(expected));
		case '>':
			return any((c) => compare(c, expected) > 0);
		case '<':
			return any((c) => compare(c, expected) < 0);
		case '>=':
			return any((c) => compare(c, expected) >= 0);
		case '<=':
			return any((c) => compare(c, expected) <= 0);
	}
}

/** Color of the first matching rule, or null when no rule matches. */
export function findRuleColor(
	rules: readonly ColorRule[],
	getValue: (propertyId: BasesPropertyId) => RuleValue | null | undefined,
): string | null {
	for (const rule of rules) {
		if (ruleMatches(rule, getValue(rule.propertyId))) return rule.color;
	}
	return null;
}
