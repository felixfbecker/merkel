import {PostgresAdapter} from '../adapters/postgres';
import {
    Migration,
    Task,
    MigrationRunTwiceError,
    FirstDownMigrationError
} from '../migration';
import {Commit} from '../git';
import * as pg from 'pg';
import * as assert from 'assert';

describe('PostgresAdapter', () => {
    beforeEach(async () => {
        const client = new pg.Client(process.env.DB_CONN);
        await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
        await client.query('DROP TABLE IF EXISTS "merkel_meta"');
        await client.query('DROP TYPE IF EXISTS "merkel_migration_type"');
        client.end();
    });
    describe('init', () => {
        it('should create the database schema', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const client = new pg.Client(process.env.DB_CONN);
            await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
            try {
                await client.query('CREATE TYPE "merkel_migration_type" AS ENUM (\'up\', \'down\')');
                throw new assert.AssertionError({
                    message: 'merkel_migration_type does not exist'
                });
            } catch (err) {
                assert.equal(err.code, 42710);
                // is existent
            }
            try {
                await client.query('CREATE TABLE "merkel_meta" ("test" INTEGER)');
                throw new assert.AssertionError({
                    message: 'table merkel_meta does not exist'
                });
            } catch (err) {
                // ignore
            }
            client.end();
        });

    });
    describe('logMigrationTask', () => {
        it('should log migrations correctly', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const date = new Date(Date.now());
            const task = new Task({
                appliedAt: date,
                type: 'up',
                migration: new Migration({
                    name: 'testlog'
                }),
                commit: new Commit({
                    sha1: '1234'
                }),
                head: new Commit({
                    sha1: '2345'
                })
            });
            await adapter.logMigrationTask(task);
            const test = await adapter.getLastMigrationTask();
            assert.deepEqual(test, task);
        });
    });
    describe('getLastMigrationTask', () => {
        it('should get the latest migration task', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const date = new Date(Date.now());
            adapter.logMigrationTask(new Task({
                appliedAt: date,
                type: 'up',
                commit: new Commit({
                    sha1: '123'
                }),
                head: new Commit({
                    sha1: '234'
                }),
                migration: new Migration({name: 'test'})
            }));
            const task = await adapter.getLastMigrationTask();
            assert.deepEqual(task, {
                id: 1,
                appliedAt: date,
                type: 'up',
                migration: {
                    name: 'test'
                },
                commit: {
                    sha1: '123',
                    tasks: []
                },
                head: {
                    sha1: '234',
                    tasks: []
                }
            });
        });
    });
    describe('checkIfTaskCanExecute', async () => {
        it('should not run the same migration up twice', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const upTask = new Task({
                appliedAt: new Date(Date.now()),
                migration: new Migration({
                    name: 'test'
                }),
                type: 'up',
                commit: new Commit({
                    sha1: '1'
                }),
                head: new Commit({
                    sha1: '2'
                })
            });
            await adapter.logMigrationTask(upTask);
            try {
                await adapter.checkIfTaskCanExecute(upTask);
                throw new assert.AssertionError({
                    message: 'task could be executed twice'
                });
            } catch (err) {
                if (!(err instanceof MigrationRunTwiceError)) {
                    throw err;
                }
            }
        });
        it('should not run the same migration down twice', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const downTask = new Task({
                appliedAt: new Date(Date.now()),
                migration: new Migration({
                    name: 'test'
                }),
                type: 'down',
                commit: new Commit({
                    sha1: '1'
                }),
                head: new Commit({
                    sha1: '2'
                })
            });
            await adapter.logMigrationTask(downTask);
            try {
                await adapter.checkIfTaskCanExecute(downTask);
                throw new assert.AssertionError({
                    message: 'task could be executed twice'
                });
            } catch (err) {
                if (!(err instanceof MigrationRunTwiceError)) {
                    throw err;
                }
            }
        });
        it('should not run a down migration first', async () => {
            const adapter = new PostgresAdapter(process.env.DB_CONN, pg);
            await adapter.init();
            const task = new Task({
                appliedAt: new Date(Date.now()),
                migration: new Migration({
                    name: 'test'
                }),
                type: 'down',
                commit: new Commit({
                    sha1: '1'
                }),
                head: new Commit({
                    sha1: '2'
                })
            });
            try {
                await adapter.checkIfTaskCanExecute(task);
                throw new assert.AssertionError({
                    message: 'down task could be executed first'
                });
            } catch (err) {
                if (!(err instanceof FirstDownMigrationError)) {
                    throw err;
                }
            }
        });
    });
});
