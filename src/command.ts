import { readFileSync } from 'node:fs';

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

// npx/npm exec runs the package without putting `lambdadb` on PATH, so suggest a command that works without a global install.
export const cli = process.env.npm_command === 'exec' ? `npx -y ${name}@${version}` : 'lambdadb';
