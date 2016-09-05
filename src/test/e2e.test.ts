import {tmpdir} from 'os';
import {execFile} from 'mz/child_process';
import {createConfig, createMigrationDir, generate, getStatus} from '../index';
import {PostgresAdapter} from '../adapters/postgres';
import {addGitHook, getHead} from '../git';
import * as fs from 'mz/fs';
import * as assert from 'assert';
import {AssertionError} from 'assert';
import * as pg from 'pg';
import * as del from 'del';
import * as path from 'path';

const PATH = path.resolve(__dirname + '/../../bin') + path.delimiter + process.env.PATH;

describe.only('E2E', () => {
    describe('First migration in repository', () => {
        let client: pg.Client;
        const repo = tmpdir() + '/merkel_test_repo';
        before(async () => {
            client = new pg.Client(process.env.MERKEL_DB);
            await new Promise<void>((resolve, reject) => client.connect((err) => err ? reject(err) : resolve()));
            await client.query('DROP TABLE IF EXISTS "new_table"');
            await client.query('DROP TABLE IF EXISTS merkel_meta');
            try {
                await fs.access(repo);
            } catch (err) {
                await fs.mkdir(repo);
            }
            process.chdir(repo);
            await del('*', <any>{dot: true});
        });
        it('should behave properly', async () =>  {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB, pg);
            await adapter.init();
            await execFile('git', ['init']);
            await createMigrationDir('migrations');
            await createConfig({
                migrationDir: 'migrations',
                migrationOutDir: 'migrations'
            });
            await addGitHook();
            await generate({
                migrationDir: 'migrations'
            });
            const files = (await fs.readdir('migrations')).filter(item => item !== '.' && item !== '..');
            const file = 'migrations/' + files[0];
            const uuid = files[0].replace('.js', '');
            await fs.access(file).catch(() => new AssertionError({message: 'migration file not created'}));
            await fs.writeFile('User.ts', 'class User {}');
            await fs.writeFile(file, await fs.readFile(__dirname + '/migrations/test_migration.js'));
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', `first migration\n\n[merkel up ${uuid}]`], {env: PATH});
            const status = await getStatus(adapter, await getHead(), 'migrations');
            assert.equal(status.newCommits.length, 1);
            await execFile('npm', ['i', 'pg']);
            await status.executePendingTasks('migrations', adapter);
            const {rows} = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`);
            assert.equal(rows.length, 1);
            await execFile('git', ['revert', '--no-commit', 'HEAD']);
            await execFile('git', ['reset', 'HEAD', 'migrations']);
            await execFile('git', ['checkout', '--', 'migrations']);
            await execFile('git', ['commit', '-m', `Rollback on User\n\n[merkel down ${uuid}]`], {env: PATH});
            const downStatus = await getStatus(adapter, await getHead(), 'migrations');
            assert.equal(downStatus.newCommits.length, 1);
            await downStatus.executePendingTasks('migrations', adapter);
            const response = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`);
            assert.equal(response.rows.length, 0);
        });
        after(async () => await client.end());
    });
});
