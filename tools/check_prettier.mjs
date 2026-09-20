/** Read-only Prettier check that accepts Bazel's symlinked source inputs. */
import { readFile } from 'node:fs/promises';
import * as prettier from '../web/node_modules/prettier/index.mjs';

const options = JSON.parse(await readFile('.prettierrc.json', 'utf8'));
let failed = false;
for (const filepath of process.argv.slice(2)) {
  const source = await readFile(filepath, 'utf8');
  if (!(await prettier.check(source, { ...options, filepath }))) {
    process.stderr.write(`Needs formatting: ${filepath}\n`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
