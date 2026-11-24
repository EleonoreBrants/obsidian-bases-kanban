import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCardFingerprint, createCard } from '../src/components/card.ts';
import { KanbanView } from '../src/kanbanView.ts';
import { findRuleColor, parseColorRules } from '../src/utils/colorRules.ts';
import { ListValue, LinkValue, NullValue, NumberValue, StringValue } from './mocks/obsidian.ts';
import {
	createDivWithMethods,
	createMockApp,
	createMockBasesEntry,
	createMockQueryController,
	createMockTFile,
	setupKanbanViewWithApp,
	setupTestEnvironment,
} from './helpers.ts';

setupTestEnvironment();

const colorFor = (rule: string, value: unknown) =>
	findRuleColor(parseColorRules([`${rule} -> green`]).rules, () => value as any);

test('parseColorRules parses operators, quoted values and property prefixes', () => {
	const { rules, invalid } = parseColorRules([
		'Projet = Alpha -> green',
		'Date de fin <= "2026-12-01" -> #ff8800',
		'file.name contains x -> var(--color-red)',
		'Notes empty -> blue',
		'Notes contains a=b -> rgb(1, 2, 3)',
	]);
	assert.deepEqual(invalid, []);
	assert.deepEqual(
		rules.map((r) => [r.propertyId, r.operator, r.value, r.color]),
		[
			['note.Projet', '=', 'Alpha', 'green'],
			['note.Date de fin', '<=', '2026-12-01', '#ff8800'],
			['file.name', 'contains', 'x', 'var(--color-red)'],
			['note.Notes', 'empty', '', 'blue'],
			['note.Notes', 'contains', 'a=b', 'rgb(1, 2, 3)'],
		],
	);
});

test('parseColorRules reports malformed lines and accepts a newline-separated string', () => {
	const { rules, invalid } = parseColorRules(
		['A = 1 -> red', 'no arrow', 'A = -> red', 'A empty x -> red', 'A = 1 -> not a color', 'A ~ 1 -> red'].join('\n'),
	);
	assert.equal(rules.length, 1);
	assert.equal(invalid.length, 5);
});

test('rules compare case-insensitively and match list items and link targets', () => {
	assert.equal(colorFor('Projet = alpha', new StringValue('ALPHA')), 'green');
	assert.equal(colorFor('Tags = b', new ListValue([new StringValue('a'), new StringValue('b')])), 'green');
	assert.equal(colorFor('Parent = Alpha', new StringValue('[[Folder/Alpha#Heading|Shown]]')), 'green');
	assert.equal(colorFor('Parent = Shown', new LinkValue('[[Folder/Alpha|Shown]]')), 'green');
	assert.equal(colorFor('Projet = [[🛰️D3SIR - Main]]', new StringValue('[[Notes/🛰️D3SIR - Main]]')), 'green');
	assert.equal(colorFor('Projet = 🛰️D3SIR - Main', new LinkValue('[[🛰️D3SIR - Main]]')), 'green');
	assert.equal(colorFor('Projet contains D3SIR', new StringValue('[[🛰️D3SIR - Main]]')), 'green');
	assert.equal(colorFor('Projet contains D3SIR', new ListValue([new StringValue('[[Autre]]')])), null);
	assert.equal(colorFor('Projet = alpha', new StringValue('beta')), null);
});

test('!=, empty and !empty treat missing values as empty', () => {
	assert.equal(colorFor('Statut != Done', null), 'green');
	// Bases reports a missing property as NullValue, whose text is "null".
	class BasesNull extends NullValue {
		toString() {
			return 'null';
		}
	}
	assert.equal(colorFor('Statut empty', new BasesNull()), 'green');
	assert.equal(colorFor('Statut != Done', new BasesNull()), 'green');
	assert.equal(colorFor('Statut contains null', new BasesNull()), null);
	assert.equal(colorFor('Statut != Done', new StringValue('done')), null);
	assert.equal(colorFor('Statut empty', new StringValue('  ')), 'green');
	assert.equal(colorFor('Statut !empty', null), null);
	assert.equal(colorFor('Statut !empty', new StringValue('x')), 'green');
});

test('ordering operators compare numbers numerically and dates as ISO text', () => {
	assert.equal(colorFor('Prix > 9', new NumberValue(10)), 'green');
	assert.equal(colorFor('Prix > 9', new StringValue('10')), 'green');
	assert.equal(colorFor('Prix >= 10', new NumberValue(10)), 'green');
	assert.equal(colorFor('Prix < 9', new NumberValue(10)), null);
	assert.equal(colorFor('Échéance < 2026-12-01', new StringValue('2026-11-24')), 'green');
	assert.equal(colorFor('Échéance >= 2026-12-01', new StringValue('2026-11-24')), null);
});

test('the first matching rule wins', () => {
	const { rules } = parseColorRules(['Projet = Alpha -> red', 'Projet !empty -> blue']);
	assert.equal(
		findRuleColor(rules, () => new StringValue('Alpha') as any),
		'red',
	);
	assert.equal(
		findRuleColor(rules, () => new StringValue('Beta') as any),
		'blue',
	);
});

function buildCtx(colorRules: unknown) {
	const app = createMockApp();
	const controller: any = createMockQueryController([], []);
	controller.app = app;
	const view: any = new KanbanView(controller, createDivWithMethods());
	setupKanbanViewWithApp(view, app);
	controller.config.set('colorRules', colorRules);
	view._refreshColorRules();
	return { view, ctx: view._buildCardCtx() };
}

test('cards get a banner only when a rule matches, and the fingerprint tracks the color', () => {
	const { view, ctx } = buildCtx(['note.Projet = Alpha -> green']);
	const matching = createMockBasesEntry(createMockTFile('A.md'), { 'note.Projet': 'Alpha' });
	const plain = createMockBasesEntry(createMockTFile('B.md'), { 'note.Projet': 'Beta' });
	const callbacks = view._buildCardCallbacks();

	const banner = createCard(matching, ctx, callbacks).querySelector<HTMLElement>('.obk-card-banner');
	assert.equal(banner?.style.backgroundColor, 'green');
	assert.equal(createCard(plain, ctx, callbacks).querySelector('.obk-card-banner'), null);

	const uncolored = { ...ctx, colorRules: [] };
	assert.notEqual(computeCardFingerprint(matching, ctx), computeCardFingerprint(matching, uncolored));
	assert.equal(computeCardFingerprint(plain, ctx), computeCardFingerprint(plain, uncolored));
	view.onClose();
});

test('color rule changes are detected once per change', () => {
	const { view } = buildCtx(['note.Projet = Alpha -> green']);
	assert.equal(view._refreshColorRules(), false);
	view.config.set('colorRules', ['note.Projet = Alpha -> red']);
	assert.equal(view._refreshColorRules(), true);
	assert.equal(view._colorRules[0].color, 'red');
	view.onClose();
});

test('Color rules is a multitext view option', () => {
	const option = KanbanView.getViewOptions().find((o: any) => o.key === 'colorRules') as any;
	assert.equal(option?.type, 'multitext');
});
