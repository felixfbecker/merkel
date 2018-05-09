import { assert, use as useChaiPlugin } from 'chai'
import chaiAsPromised = require('chai-as-promised')
import * as pg from 'pg'
import { PostgresAdapter } from '../../adapters/postgres'
import { Commit } from '../../git'
import { FirstDownMigrationError, Migration, MigrationRunTwiceError, Task } from '../../migration'

useChaiPlugin(chaiAsPromised)

describe('PostgresAdapter', () => {
    let client: pg.Client
    if (!process.env.MERKEL_DB) {
        throw new Error()
    }
    before(async () => {
        client = new pg.Client({ connectionString: process.env.MERKEL_DB })
        await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
    })
    after(() => client.end())
    beforeEach(async () => {
        await client.query('DROP TABLE IF EXISTS "merkel_meta"')
        await client.query('DROP TYPE IF EXISTS "merkel_migration_type"')
    })
    describe('init', () => {
        it('should create the database schema', async () => {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const client = new pg.Client({ connectionString: process.env.MERKEL_DB })
            await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
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
            await client.end()
        })
        it('should not fail initializing twice', async () => {
            let adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            await adapter.close()
            adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
        })
    })
    describe('logMigrationTask', () => {
        it('should log migrations correctly', async () => {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const date = new Date(Date.now())
            const task = new Task(
                undefined,
                'up',
                new Migration('testlog'),
                new Commit('1234'),
                new Commit('2345'),
                date
            )
            await adapter.logMigrationTask(task)
            const test = await adapter.getLastMigrationTask()
            assert.deepEqual(test, task)
        })
    })
    describe('getLastMigrationTask', () => {
        it('should get the latest migration task', async () => {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const date = new Date(Date.now())
            await adapter.logMigrationTask(
                new Task(undefined, 'up', new Migration('test'), new Commit('123'), new Commit('234'), date)
            )
            const task = await adapter.getLastMigrationTask()
            assert.deepEqual<any>(task, {
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
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const upTask = new Task(
                undefined,
                'up',
                new Migration('test'),
                new Commit('1'),
                new Commit('2'),
                new Date(Date.now())
            )
            await adapter.logMigrationTask(upTask)
            await assert.isRejected(adapter.checkIfTaskCanExecute(upTask), MigrationRunTwiceError)
        })
        it('should not run the same migration down twice', async () => {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const downTask = new Task(
                undefined,
                'down',
                new Migration('test'),
                new Commit('1'),
                new Commit('2'),
                new Date(Date.now())
            )
            await adapter.logMigrationTask(downTask)
            await assert.isRejected(adapter.checkIfTaskCanExecute(downTask), MigrationRunTwiceError)
        })
        it('should not run a down migration first', async () => {
            const adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            const task = new Task(
                undefined,
                'down',
                new Migration('test'),
                new Commit('1'),
                new Commit('2'),
                new Date(Date.now())
            )
            await assert.isRejected(adapter.checkIfTaskCanExecute(task), FirstDownMigrationError)
        })
    })
})
