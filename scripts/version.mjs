import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const core = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
/** Versions that may be committed: the last released rc/stable version or the next one set by a release PR. */
export const COMMITTED_VERSION = new RegExp(`^${core}(?:-rc\\.([1-9]\\d*))?$`);
/** Versions that may be published: automatic dev builds, rc and stable releases. */
export const PUBLISHED_VERSION = new RegExp(`^${core}(?:-(dev|rc)\\.([1-9]\\d*))?$`);
const STABLE_TAG = new RegExp(`^v${core}$`);

const read = (root, path) => readFileSync(join(root, path), 'utf8');

/** Read package.json and both root package-lock.json versions; throws unless they agree. */
export function readVersion(root) {
  const pkg = JSON.parse(read(root, 'package.json'));
  const lock = JSON.parse(read(root, 'package-lock.json'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('Version sources must agree: package.json and both root package-lock.json entries.');
  }
  return pkg.version;
}

// Replace the first `"version": "<old>"` field after `anchor`, keeping the file's formatting.
function replaceVersionField(text, old, version, anchor = '') {
  const start = anchor ? text.indexOf(anchor) : 0;
  const field = new RegExp(`("version"\\s*:\\s*")${old.replaceAll('.', '\\.')}"`, 'g');
  field.lastIndex = Math.max(start, 0);
  const match = start < 0 ? null : field.exec(text);
  if (!match) throw new Error(`Cannot find version ${old}${anchor ? ` after ${anchor}` : ''}.`);
  return text.slice(0, match.index) + `${match[1]}${version}"` + text.slice(match.index + match[0].length);
}

/** Set every version source to `version`, preserving formatting, and verify the result. */
export function setVersion(root, version, { allowed = COMMITTED_VERSION } = {}) {
  if (!allowed.test(version)) throw new Error(`Unsupported version ${version}.`);
  const old = readVersion(root);
  let lock = replaceVersionField(read(root, 'package-lock.json'), old, version);
  lock = replaceVersionField(lock, old, version, '"packages"');
  const pkg = replaceVersionField(read(root, 'package.json'), old, version);
  writeFileSync(join(root, 'package-lock.json'), lock);
  writeFileSync(join(root, 'package.json'), pkg);
  if (readVersion(root) !== version) throw new Error('Version update did not reach every source.');
  return version;
}

export function parseVersion(version) {
  const match = PUBLISHED_VERSION.exec(version) ?? COMMITTED_VERSION.exec(version);
  if (!match) throw new Error(`Unsupported version ${version}.`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], text: `${match[1]}.${match[2]}.${match[3]}` };
}

export function compareCores(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The newest stable release tag (`vX.Y.Z`) among `tags`, or undefined. */
export function latestStableTag(tags) {
  return tags.filter(tag => STABLE_TAG.test(tag))
    .sort((a, b) => compareCores(parseVersion(a.slice(1)).core, parseVersion(b.slice(1)).core)).at(-1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, value, ...rest] = process.argv.slice(2);
    if (command === 'get' && value === undefined) console.log(readVersion(process.cwd()));
    else if (command === 'set' && value && !rest.length) console.log(setVersion(process.cwd(), value));
    else throw new Error('Usage: node scripts/version.mjs get | set <version>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
