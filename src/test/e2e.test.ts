import { AssertionError } from 'assert'
import * as assert from 'assert'
import * as del from 'del'
import { exec, execFile } from 'mz/child_process'
import * as fs from 'mz/fs'
import { tmpdir } from 'os'
import * as path from 'path'
import * as pg from 'pg'
import { createAdapterFromUrl } from '../adapter'
import { addGitHook, getHead } from '../git'
import { createConfig, createMigrationDir, generate, getStatus, SILENT_LOGGER, Task } from '../index'

const PATH = path.resolve(__dirname + '/../../bin') + path.delimiter + process.env.PATH

describe('E2E', () => {
    let client: pg.Client
    const repo = tmpdir() + '/merkel_test_repo'
    before(async function(): Promise<void> {
        this.timeout(30000)
        client = new pg.Client({ connectionString: process.env.MERKEL_DB })
        await new Promise<void>((resolve, reject) => client.connect(err => (err ? reject(err) : resolve())))
        await client.query('DROP TABLE IF EXISTS "new_table"')
        await client.query('DROP TABLE IF EXISTS merkel_meta')
        try {
            await fs.access(repo)
        } catch (err) {
            await fs.mkdir(repo)
        }
        process.chdir(repo)
        await del('*', { dot: true } as any)
        await exec('npm i pg')
    })
    it('should behave properly', async function(): Promise<void> {
        this.timeout(10000)
        if (!process.env.MERKEL_DB) {
            throw new Error('Cant run E2E tests without MERKEL_DB set')
        }
        const adapter = createAdapterFromUrl(process.env.MERKEL_DB)
        await adapter.init()
        await execFile('git', ['init'])
        await createMigrationDir('migrations')
        await createConfig({
            migrationDir: 'migrations',
            migrationOutDir: 'migrations',
        })
        await addGitHook()
        let uuid = await generate({ migrationDir: 'migrations' }, SILENT_LOGGER)
        let file = `migrations/${uuid}.js`
        await fs.access(file).catch(() => new AssertionError({ message: 'migration file not created' }))
        await fs.writeFile('User.ts', 'class User {}')
        await fs.writeFile(file, await fs.readFile(__dirname + '/migrations/test_migration.js'))
        await execFile('git', ['config', 'user.email', 'whatever@whatever.com'])
        await execFile('git', ['config', 'user.name', 'whatever'])
        await execFile('git', ['add', file, 'User.ts', '.merkelrc.json'])
        await execFile('git', ['commit', '-m', `first migration\n\n[merkel up ${uuid}]`], { env: { PATH } })
        let status = await getStatus(adapter, await getHead())
        assert.equal(status.newCommits.length, 1)
        assert.equal(status.newCommits[0].tasks.length, 1)
        // add pending task
        await adapter.beginMigrationTask({ ...status.newCommits[0].tasks[0], head: await getHead() } as Task)
        let shouldHaveFinished = false
        // begin execution, this should wait
        const promise = (async () => {
            await status.executePendingTasks('migrations', adapter, SILENT_LOGGER)
            if (shouldHaveFinished) {
                return
            }
            throw new AssertionError({ message: 'Finished early' })
        })()
        // delete pending task
        await client.query(`DELETE FROM "merkel_meta"`)
        shouldHaveFinished = true
        // requested migration should begin now and finish correctly
        await promise
        const { rows } = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`)
        assert.equal(rows.length, 1)
        await execFile('git', ['revert', '--no-commit', 'HEAD'])
        await execFile('git', ['reset', 'HEAD', 'migrations'])
        await execFile('git', ['checkout', '--', 'migrations'])
        await execFile('git', ['commit', '-m', `Revert of User\n\n[merkel down ${uuid}]`], { env: { PATH } })
        const downStatus = await getStatus(adapter, await getHead())
        assert.equal(downStatus.newCommits.length, 1)
        await downStatus.executePendingTasks('migrations', adapter, SILENT_LOGGER)
        let response = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`)
        assert.equal(response.rows.length, 0)
        await createConfig({
            migrationDir: 'src/migrations',
            migrationOutDir: 'src/migrations',
        })
        uuid = await generate({ migrationDir: 'src/migrations' }, SILENT_LOGGER)
        file = `src/migrations/${uuid}.js`
        await fs.access(file).catch(() => new AssertionError({ message: 'migration file not created' }))
        await fs.writeFile(file, await fs.readFile(__dirname + '/migrations/test_migration.js'))
        await execFile('git', ['add', file, '.merkelrc.json'])
        await execFile('git', ['commit', '-m', `migration in a new folder\n\n[merkel up ${uuid}]`], { env: { PATH } })
        status = await getStatus(adapter, await getHead())
        assert.equal(status.newCommits.length, 1)
        await status.executePendingTasks('migrations', adapter, SILENT_LOGGER)
        response = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`)
        assert.equal(response.rows.length, 1)
        await adapter.close()
    })
    after(async () => await client.end())
})
