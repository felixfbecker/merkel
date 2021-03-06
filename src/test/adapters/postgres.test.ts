import { assert, use as useChaiPlugin } from 'chai'
import chaiAsPromised = require('chai-as-promised')
import * as pg from 'pg'
import { PostgresAdapter } from '../../adapters/postgres'
import { Commit } from '../../git'
import { FirstDownMigrationError, Migration, MigrationRunTwiceError, Task } from '../../migration'

useChaiPlugin(chaiAsPromised)

describe('PostgresAdapter', () => {
    let client: pg.Client
    let adapter: PostgresAdapter
    const MERKEL_DB = process.env.MERKEL_DB
    if (!MERKEL_DB) {
        throw new Error('Cannot run tests without MERKEL_DB set')
    }
    before(async () => {
        client = new pg.Client({ connectionString: MERKEL_DB })
        await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
    })
    after(() => client.end())
    beforeEach(async () => {
        await client.query('DROP TABLE IF EXISTS "merkel_meta"')
        await client.query('DROP TYPE IF EXISTS "merkel_migration_type"')
        adapter = new PostgresAdapter(MERKEL_DB, pg)
        await adapter.init()
    })
    afterEach(async () => {
        await adapter.close()
    })
    describe('init', () => {
        it('should create the database schema', async () => {
            const { rows } = await client.query(
                `SELECT column_name, data_type FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'merkel_meta' ORDER BY column_name ASC`
            )
            assert.deepEqual(rows, [
                { column_name: 'applied_at', data_type: 'timestamp with time zone' },
                { column_name: 'commit', data_type: 'text' },
                { column_name: 'head', data_type: 'text' },
                { column_name: 'id', data_type: 'integer' },
                { column_name: 'name', data_type: 'text' },
                { column_name: 'type', data_type: 'USER-DEFINED' },
            ])
        })
        it('should not fail initializing twice', async () => {
            const secondAdapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            try {
                await secondAdapter.init()
            } finally {
                await secondAdapter.close()
            }
        })
    })
    describe('logMigrationTask', () => {
        it('should log migrations correctly', async () => {
            const date = new Date(Date.now())
            const task = new Task({
                type: 'up',
                migration: new Migration('testlog'),
                commit: new Commit({ sha1: '1234' }),
                head: new Commit({ sha1: '2345' }),
                appliedAt: date,
            })
            await adapter.beginMigrationTask(task)
            await adapter.finishMigrationTask(task)
            const test = await adapter.getLastMigrationTask()
            assert.deepEqual(test, task)
        })
    })
    describe('getLastMigrationTask', () => {
        it('should get the latest migration task', async () => {
            const date = new Date(Date.now())
            const task = new Task({
                type: 'up',
                migration: new Migration('test'),
                commit: new Commit({ sha1: '123' }),
                head: new Commit({ sha1: '234' }),
                appliedAt: date,
            })
            await adapter.beginMigrationTask(task)
            await adapter.finishMigrationTask(task)
            const lastTask = await adapter.getLastMigrationTask()
            assert.deepEqual<any>(lastTask, {
                id: 1,
                appliedAt: date,
                type: 'up',
                migration: {
                    name: 'test',
                },
                commit: {
                    sha1: '123',
                    message: undefined,
                    tasks: [],
                },
                head: {
                    sha1: '234',
                    message: undefined,
                    tasks: [],
                },
            })
        })
    })
    describe('checkIfTaskCanExecute', async () => {
        it('should not run the same migration up twice', async () => {
            const upTask = new Task({
                type: 'up',
                migration: new Migration('test'),
                commit: new Commit({ sha1: '1' }),
                head: new Commit({ sha1: '2' }),
                appliedAt: new Date(Date.now()),
            })
            await adapter.beginMigrationTask(upTask)
            await adapter.finishMigrationTask(upTask)
            await assert.isRejected(adapter.checkIfTaskCanExecute(upTask), MigrationRunTwiceError)
        })
        it('should not run the same migration down twice', async () => {
            const downTask = new Task({
                type: 'down',
                migration: new Migration('test'),
                commit: new Commit({ sha1: '1' }),
                head: new Commit({ sha1: '2' }),
                appliedAt: new Date(Date.now()),
            })
            await adapter.beginMigrationTask(downTask)
            await adapter.finishMigrationTask(downTask)
            await assert.isRejected(adapter.checkIfTaskCanExecute(downTask), MigrationRunTwiceError)
        })
        it('should not run a down migration first', async () => {
            const task = new Task({
                type: 'down',
                migration: new Migration('test'),
                commit: new Commit({ sha1: '1' }),
                head: new Commit({ sha1: '2' }),
                appliedAt: new Date(Date.now()),
            })
            await assert.isRejected(adapter.checkIfTaskCanExecute(task), FirstDownMigrationError)
        })
    })
})
