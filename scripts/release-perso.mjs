#!/usr/bin/env node
// One-command personal release for BRAT: bump version, build, commit, tag, push, GitHub release.
// Usage: npm run release:perso -- [patch|minor|major|x.y.z] [-m "notes"] [--dry-run]
// If the current manifest version has never been released, it is released as-is (no bump).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readJson, writeJson } from './release-utils.mjs';

const root = process.cwd();
const FILES = ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'];
const ASSETS = ['dist/main.js', 'dist/manifest.json', 'dist/styles.css'];

const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryRun = (cmd, args) => {
	try {
		return run(cmd, args);
	} catch {
		return null;
	}
};
const npm = (...args) => {
	const result = spawnSync('npm', args, { stdio: 'inherit', shell: true });
	if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
};
const step = (msg) => console.log(`\n==> ${msg}`);
const fail = (msg) => {
	console.error(`\nError: ${msg}`);
	process.exit(1);
};

const args = process.argv.slice(2);
let bump;
let message;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--dry-run') dryRun = true;
	else if (arg === '-m' || arg === '--message') message = args[++i];
	else if (/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(arg)) bump = arg;
	else fail(`Unknown argument: ${arg}`);
}

const nextVersion = (current, kind) => {
	if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
	const [major, minor, patch] = current.split('.').map(Number);
	if (kind === 'major') return `${major + 1}.0.0`;
	if (kind === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
};

step('Checking environment');
const remoteUrl = run('git', ['remote', 'get-url', 'origin']);
const slug = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
if (!slug) fail(`Cannot derive a GitHub repository from origin: ${remoteUrl}`);
if (tryRun('gh', ['auth', 'status']) === null) fail('gh is not authenticated. Run: gh auth login');
const branch = run('git', ['branch', '--show-current']);
if (!branch) fail('Detached HEAD: check out a branch first.');
console.log(`Repository: ${slug} | branch: ${branch}`);

const tagTaken = (tag) =>
	tryRun('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]) !== null ||
	Boolean(tryRun('git', ['ls-remote', '--tags', 'origin', tag])) ||
	tryRun('gh', ['release', 'view', tag, '--repo', slug]) !== null;

const original = Object.fromEntries(FILES.filter((f) => existsSync(f)).map((f) => [f, readFileSync(f, 'utf8')]));
const current = readJson(root, 'package.json').version;
let version;
if (bump) version = nextVersion(current, bump);
else version = tagTaken(current) ? nextVersion(current, 'patch') : current;
if (tagTaken(version)) fail(`Version ${version} already exists as a tag or release.`);
console.log(`Version: ${current} -> ${version}`);
if (dryRun) {
	console.log('Dry run: nothing changed.');
	process.exit(0);
}

const restore = () => {
	for (const [file, content] of Object.entries(original)) writeFileSync(file, content);
};

try {
	// npm writes this file only when an install completes, so a partial node_modules is reinstalled.
	if (!existsSync('node_modules/.package-lock.json')) {
		step('Installing dependencies');
		npm('ci', '--maxsockets=4', '--fetch-retries=6', '--fetch-retry-mintimeout=2000', '--no-audit', '--no-fund');
	}
	step('Formatting and linting');
	npm('run', 'format');
	npm('run', 'lint');

	step(`Setting version ${version}`);
	if (version !== current) {
		const pkg = readJson(root, 'package.json');
		pkg.version = version;
		writeJson(root, 'package.json', pkg);
		if (existsSync('package-lock.json')) {
			const lock = readJson(root, 'package-lock.json');
			lock.version = version;
			if (lock.packages?.['']) lock.packages[''].version = version;
			writeJson(root, 'package-lock.json', lock);
		}
	}
	const manifest = readJson(root, 'manifest.json');
	manifest.version = version;
	writeJson(root, 'manifest.json', manifest);
	const versions = readJson(root, 'versions.json');
	versions[version] = manifest.minAppVersion;
	writeJson(root, 'versions.json', versions);

	step('Building');
	npm('run', 'build');
	for (const asset of ASSETS) if (!existsSync(asset)) throw new Error(`Missing build artifact: ${asset}`);
	if (readJson(root, 'dist/manifest.json').version !== version) throw new Error('dist/manifest.json version mismatch');
} catch (error) {
	restore();
	fail(`${error.message}\nVersion files restored; your source changes are untouched.`);
}

step('Committing and pushing');
const previousTag = tryRun('git', ['describe', '--tags', '--abbrev=0']);
run('git', ['add', '-A']);
run('git', [
	'commit',
	'-m',
	`release: ${version}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
]);
const sha = run('git', ['rev-parse', 'HEAD']);
run('git', ['tag', version, sha]);
run('git', ['push', '-u', 'origin', branch]);
run('git', ['push', 'origin', version]);

step('Creating GitHub release');
const log = tryRun('git', [
	'log',
	'--pretty=format:- %s',
	previousTag ? `${previousTag}..${sha}~1` : `${sha}~1`,
	'-n',
	'30',
]);
const notes = message ?? (log || 'Personal release');
run('gh', [
	'release',
	'create',
	version,
	...ASSETS,
	'--repo',
	slug,
	'--target',
	sha,
	'--title',
	version,
	'--notes',
	notes,
	'--latest',
]);

console.log(`\nReleased ${version}: https://github.com/${slug}/releases/tag/${version}`);
console.log(`BRAT: add beta plugin with repository "${slug}".`);
