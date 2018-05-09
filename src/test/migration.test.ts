import * as chai from 'chai'
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
import * as del from 'del'
import * as fs from 'mz/fs'
import { tmpdir } from 'os'
import * as path from 'path'
import * as pg from 'pg'
import * as sinon from 'sinon'
import { PostgresAdapter } from '../adapters/postgres'
import { Commit } from '../git'
import {
    Migration,
    MigrationExecutionError,
    MigrationLoadError,
    MigrationNotFoundError,
    Task,
    TaskList,
    TaskTypeNotFoundError,
    UnknownTaskTypeError,
} from '../migration'

const repo = path.join(tmpdir(), 'merkel_test_api')

describe('migration', () => {
    describe('Migration', () => {
        before(async () => {
            try {
                await fs.access(repo)
            } catch (err) {
                await fs.mkdir(repo)
            }
            process.chdir(repo)
            await del('*', { dot: true } as any)
        })
        describe('getPath()', () => {
            it('should calculate the right path', async () => {
                await fs.mkdir(path.join(repo, 'migrations'))
                await fs.writeFile(path.join('migrations', 'test.js'), 'up')
                const migration = new Migration('test')
                assert.equal(await migration.getPath('migrations'), path.resolve('migrations/test.js'))
            })
            it('should throw MigrationNotFoundError for not found migrations', async () => {
                const migration = new Migration('migration_not_found')
                try {
                    await migration.getPath('migrations')
                } catch (err) {
                    if (!(err instanceof MigrationNotFoundError)) {
                        throw err
                    }
                }
            })
        })
        after(async () => {
            await del('*', { dot: true } as any)
        })
    })
    describe('TaskList', () => {
        let client: pg.Client
        let adapter: PostgresAdapter
        before(async () => {
            adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            client = new pg.Client({ connectionString: process.env.MERKEL_DB })
            await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
            await client.query('DROP TABLE IF EXISTS new_table')
            await client.query('TRUNCATE TABLE merkel_meta RESTART IDENTITY')
        })
        after(() => client.end())
        describe('execute()', () => {
            it('should run all its tasks', async () => {
                const taskList = new TaskList()
                const task = new Task(undefined, 'up', new Migration('whatever'))
                taskList.push(task)
                const stub = sinon.stub(task, 'execute')
                try {
                    await taskList.execute('some_dir', adapter)
                } finally {
                    stub.restore()
                }
                sinon.assert.calledOnce(stub)
            })
        })
        describe('toString()', () => {
            it('should return a string of merkel commands', async () => {
                const taskList = TaskList.from([
                    new Task(undefined, 'down', new Migration('a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025')),
                    new Task(undefined, 'up', new Migration('e55d537d-ad67-40e6-9ef1-50320e530676')),
                ])
                assert.equal(
                    taskList.toString(),
                    '[merkel up e55d537d-ad67-40e6-9ef1-50320e530676]\n[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]'
                )
            })
            it('should wrap long commands', async () => {
                const taskList = TaskList.from([
                    new Task(undefined, 'down', new Migration('a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025')),
                    new Task(undefined, 'up', new Migration('e55d537d-ad67-40e6-9ef1-50320e530676')),
                    new Task(undefined, 'up', new Migration('15ca72e9-241c-4fcd-97ad-aeb367403a27')),
                    new Task(undefined, 'up', new Migration('e55d537d-ad67-40e6-9ef1-50320e530676')),
                ])
                assert.equal(
                    taskList.toString(),
                    [
                        '[',
                        '  merkel up',
                        '  e55d537d-ad67-40e6-9ef1-50320e530676',
                        '  15ca72e9-241c-4fcd-97ad-aeb367403a27',
                        '  e55d537d-ad67-40e6-9ef1-50320e530676',
                        ']',
                        '[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]',
                    ].join('\n')
                )
            })
        })
    })
    describe('Task', () => {
        let client: pg.Client
        let adapter: PostgresAdapter
        before(async () => {
            adapter = new PostgresAdapter(process.env.MERKEL_DB!, pg)
            await adapter.init()
            client = new pg.Client({ connectionString: process.env.MERKEL_DB })
            await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
            await client.query('DROP TABLE IF EXISTS new_table')
            await client.query('TRUNCATE TABLE merkel_meta RESTART IDENTITY')
        })
        after(() => client.end())
        describe('invert()', () => {
            it('should return a new task that has the inverse type of the task', () => {
                const task = new Task(undefined, 'up', new Migration('whatever'))
                const inverted = task.invert()
                assert.notEqual(task, inverted)
                assert.equal(inverted.type, 'down')
            })
        })
        describe('execute()', () => {
            it('should execute an up task', async () => {
                const task = new Task(undefined, 'up', new Migration('test_migration'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await task.execute(__dirname + '/migrations', adapter, head, trigger)
                // Check if table was created
                const { rows } = await client.query(
                    `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`
                )
                assert.equal(rows.length, 1)
            })
            it('should throw a MigrationNotFoundError if the migration is not existent', async () => {
                const task = new Task(undefined, 'up', new Migration('not_found'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await assert.isRejected(
                    task.execute(__dirname + '/migrations', adapter, head, trigger),
                    MigrationNotFoundError
                )
            })
            it('should throw a MigrationLoadError if the migration fails loading', async () => {
                const task = new Task(undefined, 'up', new Migration('error_load'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await assert.isRejected(
                    task.execute(__dirname + '/migrations', adapter, head, trigger),
                    MigrationLoadError
                )
            })
            it('should throw a TaskTypeNotFoundError if the migration has no up or down function', async () => {
                const task = new Task(undefined, 'up', new Migration('no_up'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await assert.isRejected(
                    task.execute(__dirname + '/migrations', adapter, head, trigger),
                    TaskTypeNotFoundError
                )
            })
            it('should throw a MigrationExecutionError when the migration returns a rejected promise', async () => {
                const task = new Task(undefined, 'up', new Migration('error_async'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await assert.isRejected(
                    task.execute(__dirname + '/migrations', adapter, head, trigger),
                    MigrationExecutionError
                )
            })
            it('should throw a MigrationExecutionError when the migration throws sync', async () => {
                const task = new Task(undefined, 'up', new Migration('error_sync'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                await assert.isRejected(
                    task.execute(__dirname + '/migrations', adapter, head, trigger),
                    MigrationExecutionError
                )
            })
            it('should throw a MigrationExecutionError when the migration would crash the process', async () => {
                const task = new Task(undefined, 'up', new Migration('error_crash'))
                const head = new Commit({ sha1: 'HEADCOMMITSHA1' })
                const trigger = new Commit({ sha1: 'TRIGGERCOMMITSHA1' })
                let listener: ((error: Error) => void) | undefined
                try {
                    listener = process.listeners('uncaughtException').pop()
                    if (listener) {
                        process.removeListener('uncaughtException', listener)
                    }
                    await assert.isRejected(
                        task.execute(__dirname + '/migrations', adapter, head, trigger),
                        MigrationExecutionError
                    )
                } finally {
                    if (listener) {
                        process.addListener('uncaughtException', listener)
                    }
                }
            })
        })
        describe('toString', () => {
            it('should throw if the task type is unknown', async () => {
                const task = new Task(undefined, 'd' as any, new Migration('test'))
                assert.throws(() => task.toString(), UnknownTaskTypeError)
            })
        })
    })
})
