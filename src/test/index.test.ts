import {
    isMerkelRepository,
    createConfig,
    generate,
    MigrationAlreadyExistsError,
    createMigrationDir,
    prepareCommitMsg
} from '../index';
import * as path from 'path';
import * as fs from 'mz/fs';
import * as del from 'del';
import * as assert from 'assert';
import {tmpdir} from 'os';
import {execFile} from 'mz/child_process';

const repo = path.join(tmpdir(), 'merkel_test_api');

describe('API', () => {
    before(async () => {
        try {
            await fs.access(repo);
        } catch (err) {
            await fs.mkdir(repo);
        }
        process.chdir(repo);
        await del('*', <any>{dot: true});
    });
    describe('isMerkelRepository', () => {
        it('should find merkel repositorys by the .merkelrc.json', async () => {
            assert(!(await isMerkelRepository()), 'a repo without config was thought to be a merkel repository');
            await createConfig({
                migrationDir: 'test',
                migrationOutDir: 'test_out'
            });
            assert(await isMerkelRepository(), 'a repo with config was thought to be no merkel repository');
        });
    });
    describe('generate', () => {
        beforeEach(async () => {
            await del('*', <any>{dot: true});
        });
        it('should generate typescript when tsconfig.json is present', async () => {
            await fs.writeFile('tsconfig.json', `
                {
                    "compilerOptions": {
                        "target": "es6"
                    }
                }
            `);
            await generate({
                migrationDir: 'test',
                name: 'test'
            });
            const content = await fs.readFile('test/test.ts', 'utf8');
            assert(content.includes('async'), 'no typescript migration was created.');
        });
        it('should generate typescript without async when told to', async () => {
            await fs.writeFile('tsconfig.json', `
                {
                    "compilerOptions": {
                        "target": "es3"
                    }
                }
            `);
            await generate({
                migrationDir: 'test',
                name: 'test'
            });
            const content = await fs.readFile('test/test.ts', 'utf8');
            assert(!content.includes('async'), 'async keyword was used for target < ES6.');
        });
        it('should generate javascript when no tsconfig.json is present', async () => {
            await generate({
                migrationDir: 'test',
                name: 'test'
            });
            try {
                await fs.access('test/test.js');
            } catch (err) {
                throw new assert.AssertionError({
                    message: 'no javascript migration was created.'
                });
            }
        });
        it('should render a template, if given', async () => {
            const template = `
                export function test() {
                }
            `;
            await fs.writeFile('template.js', template);
            await generate({
                migrationDir: 'test',
                name: 'test.js',
                template: 'template.js'
            });
            const content = await fs.readFile('test/test.js', 'utf8');
            assert.equal(content, template);
        });
        it('should throw if migration file would be overwritten', async () => {
            try {
                await createMigrationDir('test');
                await fs.writeFile('test/test.js', `
                    export function up() {
                    }
                `);
                await generate({
                    migrationDir: 'test',
                    name: 'test'
                });
                throw new assert.AssertionError({
                    message: 'it did not throw although migration was already present'
                });
            } catch (err) {
                if (!(err instanceof MigrationAlreadyExistsError)) {
                    throw err;
                }
            }
        });
        it('should not crash if template does not exist', async () => {
            await createMigrationDir('test');
            await generate({
                migrationDir: 'test',
                name: 'test',
                template: 'none'
            });
        });
    });
    describe('generateCommitMsg', () => {
        beforeEach(async () => {
            await del('*', <any>{dot: true});
        });
        it('should warn if is a revert commit', async () => {
            await execFile('git', ['init']);
            await fs.writeFile('msgfile', 'Revert: Commit 91ba39f');
            let warned = false;
            await prepareCommitMsg('msgfile', 'migrations', {
                warn: () => {
                    warned = true;
                },
                error: () => undefined,
                log: () => undefined
            });
            assert(warned, 'the generator has not echoed a warning');
        });
        it('should append a new migration to msg', async () => {
            await execFile('git', ['init']);
            await fs.mkdir('migrations');
            await fs.writeFile('migrations/test.js', 'export function up() {}');
            await execFile('git', ['add', 'migrations/test.js']);
            await fs.writeFile('msgfile', '');
            await prepareCommitMsg('msgfile', 'migrations');
            const content = await fs.readFile('msgfile', 'utf8');
            assert(content.includes('[merkel up test]'), 'migration was not correctly added to commit message');
            assert(!content.includes('[merkel down'), 'migration was not correctly added to commit message');
        });
    });
    after(async () => {
        await del('*', <any>{dot: true});
    });
});
