import type { BasesView, TFile } from 'obsidian';
import { parsePropertyId, parseYaml } from 'obsidian';
import type { NewCardRules } from './quickAdd.ts';
import {
	getOptionalFilterProperties,
	getViewFilters,
	isRecord,
	parseCopyFromParentMode,
	parseDefaultProperties,
	parsePropertyNames,
	selectParentProperties,
} from '../utils/newCardProperties.ts';

/** Bases internals (not in the public typings) used to find the `.base` file behind a view. */
function readInternalQuery(view: BasesView): { path: string; hasTemplate: boolean } | null {
	const controller: unknown = Reflect.get(view, 'queryController');
	const query = isRecord(controller) ? controller.query : null;
	const file = isRecord(query) ? query.file : null;
	if (!isRecord(query) || !isRecord(file) || typeof file.path !== 'string') return null;
	return { path: file.path, hasTemplate: Boolean(query.newItemTemplate) };
}

/** Properties implied only by `or`/`not` filter branches, read from the view's `.base` file. */
async function readOptionalFilterProperties(view: BasesView): Promise<Set<string>> {
	try {
		const source = readInternalQuery(view);
		// A "new item" template replaces the filter values, so nothing injected comes from the filters.
		if (!source || !source.path.endsWith('.base') || source.hasTemplate) return new Set();
		const file = view.app.vault.getFileByPath(source.path);
		if (!file) return new Set();
		const filters = getViewFilters(parseYaml(await view.app.vault.cachedRead(file)), view.config.name);
		return filters ? getOptionalFilterProperties(...filters) : new Set();
	} catch (error) {
		console.warn('KanbanView: could not analyse the Base filters', error);
		return new Set();
	}
}

export async function resolveNewCardRules(view: BasesView): Promise<NewCardRules> {
	const { defaults, invalid } = parseDefaultProperties(view.config?.get?.('defaultProperties'));
	if (invalid.length > 0) console.warn('KanbanView: ignored invalid default properties', invalid);

	const displayed = (view.config?.getOrder?.() ?? [])
		.map((id) => parsePropertyId(id))
		.filter((parsed) => parsed.type === 'note')
		.map((parsed) => parsed.name.toLowerCase());

	return {
		optionalFilterProperties: await readOptionalFilterProperties(view),
		displayedProperties: new Set(displayed),
		defaults,
	};
}

/** Values a new sub-page copies from its parent, following the "Copy from parent" options. */
export function resolveParentProperties(
	view: BasesView,
	parentFile: TFile,
	reserved: readonly string[],
): Record<string, unknown> {
	const frontmatter = view.app.metadataCache.getFileCache(parentFile)?.frontmatter;
	return selectParentProperties(
		frontmatter,
		parseCopyFromParentMode(view.config?.get?.('copyFromParentMode')),
		parsePropertyNames(view.config?.get?.('copyFromParentProperties')),
		reserved,
	);
}
