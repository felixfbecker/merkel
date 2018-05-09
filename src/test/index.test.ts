import { assert, use as useChaiPlugin } from 'chai'
import chaiAsPromised = require('chai-as-promised')
import chalk from 'chalk'
import * as del from 'del'
import { execFile } from 'mz/child_process'
import * as fs from 'mz/fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { Commit, CommitSequence } from '../git'
import {
    createConfig,
    createMigrationDir,
    generate,
    isMerkelRepository,
    MigrationAlreadyExistsError,
    prepareCommitMsg,
    SILENT_LOGGER,
    Status,
    TemplateNotFoundError,
} from '../index'
import { Migration, Task, TaskList } from '../migration'
useChaiPlugin(chaiAsPromised)

chalk.enabled = false

const repo = path.join(tmpdir(), 'merkel_test_api')

describe('index', () => {
    before(async () => {
        try {
            await fs.access(repo)
        } catch (err) {
            await fs.mkdir(repo)
        }
        process.chdir(repo)
        await del('*', { dot: true } as any)
    })
    describe('isMerkelRepository', () => {
        it('should find merkel repositorys by the .merkelrc.json', async () => {
            assert(!(await isMerkelRepository()), 'a repo without config was thought to be a merkel repository')
            await createConfig({
                migrationDir: 'test',
                migrationOutDir: 'test_out',
            })
            assert(await isMerkelRepository(), 'a repo with config was thought to be no merkel repository')
        })
    })
    describe('generate', () => {
        beforeEach(async () => {
            await del('*', { dot: true } as any)
        })
        it('should generate typescript when tsconfig.json is present', async () => {
            await fs.writeFile(
                'tsconfig.json',
                `
                {
                    "compilerOptions": {
                        "target": "es6"
                    }
                }
            `
            )
            await generate({ migrationDir: 'test', name: 'test' }, SILENT_LOGGER)
            const content = await fs.readFile('test/test.ts', 'utf8')
            assert(content.includes('async'), 'no typescript migration was created.')
        })
        it('should generate typescript without async when told to', async () => {
            await fs.writeFile(
                'tsconfig.json',
                `
                {
                    "compilerOptions": {
                        "target": "es3"
                    }
                }
            `
            )
            await generate({ migrationDir: 'test', name: 'test' }, SILENT_LOGGER)
            const content = await fs.readFile('test/test.ts', 'utf8')
            assert(!content.includes('async'), 'async keyword was used for target < ES6.')
        })
        it('should generate javascript when no tsconfig.json is present', async () => {
            await generate({ migrationDir: 'test', name: 'test' }, SILENT_LOGGER)
            assert.isTrue(await fs.exists('test/test.js'), 'Expected javascript migration to be created')
        })
        it('should render a template, if given', async () => {
            const template = `
                export function test() {
                }
            `
            await fs.writeFile('template.js', template)
            await generate(
                {
                    migrationDir: 'test',
                    name: 'test.js',
                    template: 'template.js',
                },
                SILENT_LOGGER
            )
            const content = await fs.readFile('test/test.js', 'utf8')
            assert.equal(content, template)
        })
        it('should throw if migration file would be overwritten', async () => {
            await createMigrationDir('test')
            await fs.writeFile(
                'test/test.js',
                `
                export function up() {
                }
            `
            )
            await assert.isRejected(
                generate(
                    {
                        migrationDir: 'test',
                        name: 'test',
                    },
                    SILENT_LOGGER
                ),
                MigrationAlreadyExistsError
            )
        })
        it('should crash if template does not exist', async () => {
            await createMigrationDir('test')
            await assert.isRejected(
                generate(
                    {
                        migrationDir: 'test',
                        name: 'test',
                        template: 'none',
                    },
                    SILENT_LOGGER
                ),
                TemplateNotFoundError
            )
        })
    })
    describe('generateCommitMsg', () => {
        beforeEach(async () => {
            await del('*', { dot: true } as any)
        })
        it('should warn if is a revert commit', async () => {
            await execFile('git', ['init'])
            await fs.writeFile('msgfile', 'Revert: Commit 91ba39f')
            let warned = false
            await prepareCommitMsg('msgfile', 'migrations', {
                warn: () => {
                    warned = true
                },
                error: () => undefined,
                log: () => undefined,
            })
            assert(warned, 'the generator has not echoed a warning')
        })
        it('should append a new migration to msg', async () => {
            await execFile('git', ['init'])
            await fs.mkdir('migrations')
            await fs.writeFile('migrations/test.js', 'export function up() {}')
            await execFile('git', ['add', 'migrations/test.js'])
            await fs.writeFile('msgfile', '')
            await prepareCommitMsg('msgfile', 'migrations')
            const content = await fs.readFile('msgfile', 'utf8')
            assert(content.includes('[merkel up test]'), 'migration was not correctly added to commit message')
            assert(!content.includes('[merkel down'), 'migration was not correctly added to commit message')
        })
    })
    describe('Status', () => {
        describe('toString', () => {
            it('should print the repositories current status', () => {
                const status = new Status({
                    head: new Commit({ sha1: '0c0302301' }),
                    newCommits: new CommitSequence(),
                    lastTask: null,
                })
                const tasks = new TaskList()
                tasks.push(new Task({ type: 'up', migration: new Migration('user') }))
                const commit = new Commit({ sha1: '0c0302301' })
                commit.tasks = tasks
                status.newCommits.push(commit)
                const output = status.toString()
                assert(output.includes('Last migration:      No migration run yet'))
                assert(output.includes('<unknown commit>'))
                assert(output.includes('1 pending migration:'))
                assert(output.includes('▲ UP   user'))
            })
            it('should print the last task', () => {
                const status = new Status({
                    head: new Commit({ sha1: '0c0302301', message: 'top' }),
                    newCommits: new CommitSequence(),
                    lastTask: new Task({
                        id: 1,
                        type: 'up',
                        migration: new Migration('user'),
                        commit: new Commit({ sha1: '9913944', message: 'initial' }),
                        head: new Commit({ sha1: '9991920', message: 'header' }),
                        appliedAt: new Date(0),
                    }),
                })
                const output = status.toString()
                assert.include(output, '▲ UP   user')
                assert.include(output, new Date(0).toString())
                assert.include(output, 'initial')
                assert.include(output, 'header')
                assert.include(output, '‖')
                assert.include(output, 'top')
            })
        })
    })
    after(async () => {
        await del('*', { dot: true } as any)
    })
})
