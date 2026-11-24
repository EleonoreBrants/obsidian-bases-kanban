import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BasesPropertyId } from 'obsidian';
import { createQuickAddCard } from '../src/components/quickAdd.ts';
import { resolveParentProperties } from '../src/components/newCardRules.ts';
import { KanbanView } from '../src/kanbanView.ts';
import {
	getOptionalFilterProperties,
	getViewFilters,
	parseDefaultProperties,
	removeOptionalFilterValues,
	selectParentProperties,
} from '../src/utils/newCardProperties.ts';
import {
	createDivWithMethods,
	createMockApp,
	createMockBasesEntry,
	createMockQueryController,
	createMockTFile,
	setupKanbanViewWithApp,
	setupTestEnvironment,
	triggerDataUpdate,
} from './helpers.ts';

setupTestEnvironment();

test('parseDefaultProperties types values and keeps wikilinks intact', () => {
	const { defaults, invalid } = parseDefaultProperties([
		'Project = [[p1]]',
		'Done = true',
		'Points = 3',
		'tags = a, b',
		'Links = [[a, b]], [[c]]',
		'Status=Todo',
		'no separator',
		'Empty =',
	]);
	assert.deepEqual(defaults, {
		Project: '[[p1]]',
		Done: true,
		Points: 3,
		tags: ['a', 'b'],
		Links: ['[[a, b]]', '[[c]]'],
		Status: 'Todo',
	});
	assert.deepEqual(invalid, ['no separator', 'Empty =']);
});

const userFilters = {
	and: ['!status.isEmpty()', { or: ['status != "Done"', 'type == "projet"'] }],
};

test('only properties implied by or branches are optional', () => {
	assert.deepEqual([...getOptionalFilterProperties(userFilters)], ['type']);
	assert.deepEqual([...getOptionalFilterProperties({ and: ['type == "projet"', { or: ['type == "a", "b"'] }] })], []);
	assert.deepEqual([...getOptionalFilterProperties({ or: ['file.hasTag("x")', 'file.inFolder("y")'] })], ['tags']);
	assert.deepEqual([...getOptionalFilterProperties({ or: ['note["En présentiel"] == true', 'a == 1'] })].sort(), [
		'a',
		'en présentiel',
	]);
});

test('a one-element or behaves like and, and unreadable required filters protect their properties', () => {
	assert.deepEqual([...getOptionalFilterProperties({ or: ['type == "projet"'] })], []);
	assert.deepEqual(
		[...getOptionalFilterProperties({ and: ['len(type) > 3 && x', { or: ['type == "a"', 'other == 1'] }] })],
		['other'],
	);
});

test('filters of a view are combined with the global ones, and unknown views are skipped', () => {
	const base = { filters: { and: ['a == 1'] }, views: [{ name: 'Board', filters: { or: ['b == 1', 'c == 2'] } }] };
	assert.deepEqual(getViewFilters(base, 'Board'), [base.filters, base.views[0]?.filters]);
	assert.equal(getViewFilters(base, 'Other'), null);
	assert.equal(getViewFilters(null, 'Board'), null);
});

test('removing optional values keeps the placeholders of displayed properties', () => {
	const frontmatter: Record<string, unknown> = { type: 'projet', Place: 'x', Status: '', Other: 'y' };
	removeOptionalFilterValues(frontmatter, new Set(['type', 'place', 'status']), new Set(['place']));
	assert.deepEqual(frontmatter, { Place: null, Status: '', Other: 'y' });
});

test('parent properties follow the chosen mode and skip empty and reserved values', () => {
	const parentFm: Record<string, unknown> = {
		Project: '[[p1]]',
		tags: ['a'],
		Parent: '[[root]]',
		status: 'Todo',
		note: '',
		list: [],
	};
	const reserved = ['parent', 'status'];
	assert.deepEqual(selectParentProperties(parentFm, 'listed', [], reserved), {});
	assert.deepEqual(selectParentProperties(parentFm, 'listed', ['project', 'Parent', 'status'], reserved), {
		Project: '[[p1]]',
	});
	assert.deepEqual(selectParentProperties(parentFm, 'except', ['tags'], reserved), { Project: '[[p1]]' });
	assert.deepEqual(selectParentProperties(parentFm, 'except', [], reserved), { Project: '[[p1]]', tags: ['a'] });
	const copied = selectParentProperties(parentFm, 'except', [], reserved);
	assert.notEqual(copied.tags, parentFm.tags, 'arrays are cloned');
});

const status = 'note.status' as BasesPropertyId;
const type = 'note.type' as BasesPropertyId;
const place = 'note.place' as BasesPropertyId;

function buildView(options: Record<string, unknown>, baseFilters?: unknown) {
	const app = createMockApp();
	const created: Array<Record<string, unknown>> = [];
	(app.vault as any).getFolderByPath = (path: string) => ({ path, name: path });
	(app.vault as any).getFileByPath = (path: string) => createMockTFile(path);
	(app.vault as any).cachedRead = async () => JSON.stringify(baseFilters);
	const controller: any = createMockQueryController(
		[createMockBasesEntry(createMockTFile('A.md'), { [status]: 'Todo' })],
		[status, type, place],
	);
	controller.app = app;
	controller.config.getAsPropertyId = (key: string) => (key === 'groupByProperty' ? status : null);
	controller.config.getOrder = () => [place];
	controller.config.name = 'Board';
	for (const [key, value] of Object.entries({ quickAddFolder: 'cards', ...options })) controller.config.set(key, value);
	const view: any = new KanbanView(controller, createDivWithMethods());
	setupKanbanViewWithApp(view, app);
	if (baseFilters) view.queryController = { query: { file: createMockTFile('Board.base') } };
	triggerDataUpdate(view);
	view.createFileForView = async (_name: string, process?: (fm: Record<string, unknown>) => void) => {
		// What Bases writes before calling the plugin: filter values, then placeholders.
		const frontmatter: Record<string, unknown> = { type: 'projet', status: '', place: null };
		process?.(frontmatter);
		created.push(frontmatter);
	};
	return { view, app, created };
}

test('a new card drops or-only filter values and receives default properties', async () => {
	const { view, created } = buildView(
		{ defaultProperties: ['Project = [[p1]]', 'place = Lab', 'status = Wrong'] },
		{ filters: userFilters, views: [{ name: 'Board' }] },
	);
	await view.createQuickAddCard('Card', 'Doing', null);
	assert.deepEqual(created, [{ status: 'Doing', place: 'Lab', Project: '[[p1]]' }]);
	view.onClose();
});

test('without a readable Base, Bases values stay and defaults never override them', async () => {
	const { view, created } = buildView({ defaultProperties: ['type = other', 'Project = p2'] });
	await view.createQuickAddCard('Card', 'Doing', null);
	assert.deepEqual(created, [{ type: 'projet', status: 'Doing', place: null, Project: 'p2' }]);
	view.onClose();
});

test('a sub-page gets the column, the parent link, then copied values over Bases values', async () => {
	const { view, app, created } = buildView(
		{ copyFromParentMode: 'except', copyFromParentProperties: ['secret'] },
		{ filters: userFilters, views: [{ name: 'Board' }] },
	);
	const parentFile = createMockTFile('Parent.md');
	(app.metadataCache as any).getFileCache = () => ({
		frontmatter: { status: 'Todo', Parent: '[[Root]]', Project: '[[p1]]', secret: 'x', type: 'tache', place: 'Lab' },
	});
	const copied = resolveParentProperties(view, parentFile, ['status', 'Parent']);
	assert.deepEqual(copied, { Project: '[[p1]]', type: 'tache', place: 'Lab' });

	await createQuickAddCard('Child', 'Doing', null, view._buildQuickAddCtx(), view._buildQuickAddCallbacks(), {
		propertyName: 'Parent',
		link: '[[Parent]]',
		copied,
	});
	assert.deepEqual(created, [{ status: 'Doing', place: 'Lab', Project: '[[p1]]', type: 'tache', Parent: '[[Parent]]' }]);
	view.onClose();
});
