import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkMetadata(pkg, lock, release) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|rc)\.(0|[1-9]\d*))?$/.exec(pkg.version);
  if (!match) throw new Error('Version must be X.Y.Z, X.Y.Z-dev.N or X.Y.Z-rc.N.');
  for (const item of [lock, lock.packages?.['']]) {
    if (!item || item.name !== pkg.name || item.version !== pkg.version) throw new Error('Package and lockfile name/version must agree.');
  }
  if (pkg.repository?.url !== 'git+https://github.com/lambdadb/lambdadb-cli.git') throw new Error('Repository metadata must match the publishing repository.');
  const channel = match[4] ?? 'latest';
  if (release) {
    if (release.tag !== `v${pkg.version}`) throw new Error('Release tag must exactly match package version.');
    if (release.prerelease !== (channel !== 'latest')) throw new Error('GitHub prerelease flag must match the version channel.');
    if (pkg.private !== false) throw new Error('Publication is blocked until a reviewed release sets private: false.');
    if (!pkg.license || pkg.license === 'UNLICENSED') throw new Error('Choose and review the package license before publication.');
  }
  return { version: pkg.version, channel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--release')) throw new Error('Usage: node scripts/check-release.mjs [--release]');
    const release = process.argv.includes('--release') ? {
      tag: process.env.RELEASE_TAG,
      prerelease: process.env.RELEASE_PRERELEASE === 'true',
    } : undefined;
    if (release && !['true', 'false'].includes(process.env.RELEASE_PRERELEASE)) throw new Error('RELEASE_PRERELEASE must be true or false.');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const result = checkMetadata(pkg, lock, release);
    if (release && !readFileSync('CHANGELOG.md', 'utf8').includes(`## [${result.version}] - `)) throw new Error('Add a dated changelog entry for the release version.');
    if (release && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nchannel=${result.channel}\n`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
