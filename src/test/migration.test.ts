import * as assert from 'assert';
import * as fs from 'mz/fs';
import * as path from 'path';
import * as pg from 'pg';
import {Migration, MigrationNotFoundError, Task, TaskList} from '../migration';
import {Commit} from '../git';
import {PostgresAdapter} from '../adapters/postgres';

describe('migration', () => {
    describe('Migration', () => {
        describe('getPath()', () => {
            it('should calculate the right path', async () => {
                await fs.appendFile(path.join('migrations', 'test.js'), 'up');
                const migration = new Migration({name: 'test'});
                assert.equal(await migration.getPath('migrations'), path.resolve('migrations/test.js'));
            });
            it('should throw MigrationNotFoundError for not found migrations', async () => {
                const migration = new Migration();
                try {
                    await migration.getPath('migrations');
                } catch (err) {
                    if (!(err instanceof MigrationNotFoundError)) {
                        throw err;
                    }
                }
            });
        });
    });
    describe('TaskList', () => {
        describe('toString()', () => {
            it('should return a string of merkel commands', async () => {
                const taskList = TaskList.from([
                    new Task({type: 'down', migration: new Migration({name: 'a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})})
                ]);
                assert.equal(taskList.toString(), '[merkel up e55d537d-ad67-40e6-9ef1-50320e530676]\n[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]');
            });
            it('should wrap long commands', async () => {
                const taskList = TaskList.from([
                    new Task({type: 'down', migration: new Migration({name: 'a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})}),
                    new Task({type: 'up', migration: new Migration({name: '15ca72e9-241c-4fcd-97ad-aeb367403a27'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})})
                ]);
                assert.equal(taskList.toString(), [
                    '[',
                    '  merkel up',
                    '  e55d537d-ad67-40e6-9ef1-50320e530676',
                    '  15ca72e9-241c-4fcd-97ad-aeb367403a27',
                    '  e55d537d-ad67-40e6-9ef1-50320e530676',
                    ']',
                    '[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]'
                ].join('\n'));
            });
        });
    });
    describe('Task', () => {
        describe('invert()', () => {
            it('should return a new tasklist that is the inverse of the task', () => {
                const task = new Task({type: 'up'});
                const inverted = task.invert();
                assert.notEqual(task, inverted);
                assert.equal(inverted.type, 'down');
            });
        });
        describe('execute()', () => {
            let client: pg.Client;
            before(async () => {
                client = new pg.Client(process.env.MERKEL_DB);
                await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
                await client.query('DROP TABLE IF EXISTS new_table');
                await client.query('TRUNCATE TABLE merkel_meta RESTART IDENTITY');
            });
            after(() => client.end());
            it('should execute an up task', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'test_migration'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                const adapter = new PostgresAdapter(process.env.MERKEL_DB, pg);
                await adapter.init();
                await task.execute(__dirname, adapter, head, trigger);
                // Check if table was created
                const {rows} = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`);
                assert.equal(rows.length, 1);
            });
            it('should throw a MigrationExecutionError when the migration returns a rejected promise');
            it('should throw a MigrationExecutionError when the migration throws sync');
            it('should throw a MigrationExecutionError when the migration would crash the process');
        });
    });
});
