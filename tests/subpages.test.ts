import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BasesPropertyId } from 'obsidian';
import { KanbanView } from '../src/kanbanView.ts';
import { arrangeSubpages, parseParentLinkText } from '../src/utils/subpages.ts';
import { ListValue, NullValue, StringValue } from './mocks/obsidian.ts';
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

const parents = (pairs: Record<string, string>) => new Map(Object.entries(pairs));

test('arrangeSubpages nests children under their parent and keeps sibling order', () => {
	const { order, info } = arrangeSubpages(['E', 'C', 'A', 'B', 'D'], parents({ B: 'A', C: 'A', D: 'B' }));
	assert.deepEqual(order, ['E', 'A', 'C', 'B', 'D']);
	assert.deepEqual(
		['E', 'A', 'C', 'B', 'D'].map((path) => info.get(path)?.depth),
		[0, 0, 1, 1, 2],
	);
});

test('a parent outside the cell leaves its child top-level and records the parent', () => {
	const { order, info } = arrangeSubpages(['B', 'A'], parents({ B: 'Elsewhere', A: 'Elsewhere' }));
	assert.deepEqual(order, ['B', 'A']);
	assert.equal(info.get('B')?.depth, 0);
	assert.equal(info.get('B')?.orphanParentPath, 'Elsewhere');
	assert.equal(arrangeSubpages(['A', 'B'], parents({ B: 'A' })).info.get('B')?.orphanParentPath, null);
});

test('cycles and self-parents cannot hide or duplicate cards', () => {
	const cycle = arrangeSubpages(['A', 'B', 'C'], parents({ A: 'B', B: 'A', C: 'C' }));
	assert.deepEqual([...cycle.order].sort(), ['A', 'B', 'C']);
	assert.equal(cycle.order.length, 3);
});

test('parseParentLinkText reads wikilinks, aliases, lists and empty values', () => {
	const text = (value: string) => new StringValue(value);
	assert.equal(parseParentLinkText(text('[[Folder/Parent#Heading|Shown]]')), 'Folder/Parent');
	assert.equal(parseParentLinkText(text('Plain name')), 'Plain name');
	assert.equal(parseParentLinkText(new ListValue([text('[[First]]'), text('[[Second]]')])), 'First');
	assert.equal(parseParentLinkText(new ListValue([])), null);
	assert.equal(parseParentLinkText(text('  ')), null);
	assert.equal(parseParentLinkText(new NullValue()), null);
	assert.equal(parseParentLinkText(null), null);
});

const status = 'note.status' as BasesPropertyId;
const parent = 'note.parent' as BasesPropertyId;

function buildBoard(t: { mock: { method: (...args: any[]) => any } }) {
	const specs: Array<[string, string, string | null]> = [
		['E', 'Todo', null],
		['B', 'Todo', 'A'],
		['A', 'Todo', null],
		['C', 'Todo', 'B'],
		['D', 'Done', 'A'],
	];
	const entries = specs.map(([name, phase, parentName]) =>
		createMockBasesEntry(createMockTFile(`${name}.md`), {
			[status]: phase,
			...(parentName ? { [parent]: `[[${parentName}]]` } : {}),
		}),
	);
	const app = createMockApp({}, { A: [], B: [], C: [], D: [], E: [] });
	const writes: Array<{ path: string; fm: Record<string, unknown> }> = [];
	t.mock.method(app.fileManager, 'processFrontMatter', async (file: { path: string }, fn: (fm: any) => void) => {
		const fm: Record<string, unknown> = {};
		fn(fm);
		writes.push({ path: file.path, fm });
	});
	const controller: any = createMockQueryController(entries, [status, parent]);
	controller.app = app;
	controller.config.getAsPropertyId = (key: string) =>
		key === 'groupByProperty' ? status : key === 'subpageParentProperty' ? parent : null;
	const view: any = new KanbanView(controller, createDivWithMethods());
	setupKanbanViewWithApp(view, app);
	triggerDataUpdate(view);
	const body = (column: string) =>
		view.containerEl.querySelector(`[data-column-value="${column}"] .obk-column-body`) as HTMLElement;
	const cards = (column: string) =>
		Array.from(body(column).querySelectorAll<HTMLElement>('.obk-card')).map((el) => [
			el.getAttribute('data-entry-path'),
			el.getAttribute('data-subpage-depth'),
		]);
	return { view, body, cards, writes };
}

test('cards are grouped parent-first with depth, and orphans show their parent', (t) => {
	const { view, cards } = buildBoard(t);
	assert.deepEqual(cards('Todo'), [
		['E.md', null],
		['A.md', null],
		['B.md', '1'],
		['C.md', '2'],
	]);
	assert.deepEqual(cards('Done'), [['D.md', null]]);
	const pill = view.containerEl.querySelector('[data-entry-path="D.md"] .obk-card-parent-pill');
	assert.equal(pill?.textContent, '↳ A');
	view.onClose();
});

test('every card offers a sub-page button only when the option is set', (t) => {
	const { view } = buildBoard(t);
	assert.equal(view.containerEl.querySelectorAll('.obk-card-add-child').length, 5);
	view.onClose();
});

test('dragging a parent moves its group and updates every member', async (t) => {
	const { view, body, cards, writes } = buildBoard(t);
	const parentCard = body('Todo').querySelector<HTMLElement>('[data-entry-path="A.md"]')!;
	const from = body('Todo');
	const to = body('Done');
	view._beginGroupDrag(parentCard);
	assert.equal(from.querySelectorAll('.obk-card--group-hidden').length, 2, 'children are hidden during the drag');
	to.appendChild(parentCard);
	const evt = { item: parentCard, from, to, oldIndex: 1, newIndex: 0 };
	const groupPaths = view._finishGroupDrag(evt);
	assert.deepEqual(groupPaths, ['B.md', 'C.md']);
	await view.handleCardDrop(evt, groupPaths);
	assert.deepEqual(
		cards('Done').map(([path]) => path),
		['A.md', 'D.md', 'B.md', 'C.md'],
		'D, already in Done, now nests under A ahead of the cards that arrived with it',
	);
	assert.deepEqual(cards('Todo'), [['E.md', null]]);
	assert.deepEqual(writes.map((w) => w.path).sort(), ['A.md', 'B.md', 'C.md']);
	assert.ok(writes.every((w) => w.fm.status === 'Done'));
	view.onClose();
});

test('a child dropped outside its group snaps back, among siblings it reorders', async (t) => {
	const { view, body, cards, writes } = buildBoard(t);
	const todo = body('Todo');
	const child = todo.querySelector<HTMLElement>('[data-entry-path="C.md"]')!;
	// Dropped above its own parent: it must return under B.
	view._beginGroupDrag(child);
	todo.insertBefore(child, todo.firstElementChild);
	const evt = { item: child, from: todo, to: todo, oldIndex: 3, newIndex: 0 };
	view._finishGroupDrag(evt);
	assert.deepEqual(
		cards('Todo').map(([path]) => path),
		['E.md', 'A.md', 'B.md', 'C.md'],
	);
	assert.equal(writes.length, 0);
	view.onClose();
});
