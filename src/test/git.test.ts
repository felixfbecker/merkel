import {
    addGitHook,
    getNewCommits,
    getHead,
    Commit,
    NoCommitsError,
    isRevertCommit,
    parseGitLog,
    getTasksForNewCommit,
    CommitSequence,
    HookAlreadyFoundError,
    UnknownCommitError,
    getConfigurationForCommit
} from '../git';
import {
    createConfig
} from '../index';
import {execFile} from 'mz/child_process';
import * as fs from 'mz/fs';
import * as path from 'path';
import * as del from 'del';
import {tmpdir} from 'os';
import { assert, use as useChaiPlugin } from 'chai';
import chaiAsPromised = require('chai-as-promised');
useChaiPlugin(chaiAsPromised);
const repo = path.join(tmpdir(), 'merkel_test_repo');
console.log(repo);

describe('git', () => {
    beforeEach(async () => {
        try {
            await fs.access(repo);
        } catch (err) {
            await fs.mkdir(repo);
        }
        process.chdir(repo);
        await del('*', <any>{dot: true});
        await execFile('git', ['init']);
    });
    describe('hook', () => {
        it('should add githook', async () => {
            await addGitHook();
            const hook = await fs.readFile(path.join(process.cwd(), '.git/hooks/prepare-commit-msg'), 'utf8');
            assert(hook.includes('merkel prepare-commit-msg'));
        });
        it('should not add githook twice', async () => {
            await addGitHook();
            await assert.isRejected(addGitHook(), HookAlreadyFoundError);
        });
        it('should append the githook, when the prepare-commit-msg hook already exists', async () => {
            await fs.writeFile(path.join(process.cwd(), '.git', 'hooks', 'prepare-commit-msg'), 'keep me\n');
            await addGitHook();
            const hook = await fs.readFile(path.join(process.cwd(), '.git/hooks/prepare-commit-msg'), 'utf8');
            assert(hook.includes('keep me'));
        });
    });
    describe('getConfigurationForCommit', () => {
        it('should get the configuration for every commit', async () => {
            await createConfig({
                migrationDir: 'migrations',
                migrationOutDir: 'migrations'
            });
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', 'initial commit']);
            await createConfig({
                migrationDir: 'src/migrations',
                migrationOutDir: 'dist/migrations'
            });
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', 'fixes migrations']);
            const commits = await getNewCommits();
            let config = await getConfigurationForCommit(commits[0]);
            assert.equal(config.migrationDir, 'migrations');
            assert.equal(config.migrationOutDir, 'migrations');
            config = await getConfigurationForCommit(commits[1]);
            assert.equal(config.migrationDir, 'src/migrations');
            assert.equal(config.migrationOutDir, 'dist/migrations');
        });
        it('should return null if no merkelrc is in commit', async () => {
            await fs.writeFile('test.js', 'const one = 1;');
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', 'initial commit']);
            const head = await getHead();
            assert.equal(await getConfigurationForCommit(head), null);
            await createConfig({
                migrationDir: 'migrations',
                migrationOutDir: 'migrations'
            });
            assert.equal(await getConfigurationForCommit(head), null);
        });
    });
    describe('getNewCommits', () => {
        it('should return all new commits', async () => {
            for (let i = 0; i < 3; i++) {
                await fs.appendFile('test.txt', `${i}\n`);
                await execFile('git', ['add', '.']);
                await execFile('git', ['commit', '-m', `${i}`]);
            }
            const commitSequence = await getNewCommits();
            assert.equal(commitSequence.length, 3);
            assert.equal(commitSequence.isReversed, false);
            assert.equal(commitSequence[0].message, '0');
            assert.equal(commitSequence[1].message, '1');
            assert.equal(commitSequence[2].message, '2');
        });
        it('should return all new commits since a given commit', async () => {
            let since: Commit;
            for (let i = 0; i < 4; i++) {
                await fs.appendFile('test.txt', `${i}\n`);
                await execFile('git', ['add', '.']);
                await execFile('git', ['commit', '-m', `${i}`]);
                if (i === 1) {
                    since = await getHead();
                }
            }
            const commitSequence = await getNewCommits(since);
            assert.equal(commitSequence.isReversed, false);
            assert.equal(commitSequence.length, 2);
            assert.equal(commitSequence[0].message, '2');
            assert.equal(commitSequence[1].message, '3');
        });
        it('should return 0 without any commits', async () => {
            const commitSequence = await getNewCommits();
            assert.equal(commitSequence.length, 0);
            assert.equal(commitSequence.isReversed, false);
        });
        describe('when HEAD is behind since', () => {
            it('should return all commits between HEAD and since in reverse', async () => {
                let since: Commit;
                for (let i = 0; i < 4; i++) {
                    await fs.appendFile('test.txt', `${i}\n`);
                    await execFile('git', ['add', '.']);
                    await execFile('git', ['commit', '-m', i + '']);
                    if (i === 3) {
                        since = await getHead();
                    }
                }
                await execFile('git', ['checkout', 'HEAD^^']);
                const commitSequence = await getNewCommits(since);
                assert.equal(commitSequence.isReversed, true);
                assert.equal(commitSequence.length, 2);
                assert.equal(commitSequence[0].message, '2');
                assert.equal(commitSequence[1].message, '3');
            });
        });
        it('should throw an UnknownCommitError when the since commit is unknown', async () => {
            await assert.isRejected(getNewCommits(new Commit({sha1: 'whatever'})), UnknownCommitError);
        });
    });
    describe('getHead', () => {
        it('should get the correct head when a head is present', async () => {
            for (let i = 0; i < 2; i++) {
                await fs.appendFile('test.txt', `${i}\n`);
                await execFile('git', ['add', '.']);
                await execFile('git', ['commit', '-m', `${i}`]);
            }
            const commit = await getHead();
            assert.equal(typeof commit.sha1, 'string');
        });
        it('should get error when no HEAD exists', async () => {
            try {
                await getHead();
                assert.fail('Getting HEAD should have failed');
            } catch (err) {
                if (!(err instanceof NoCommitsError)) {
                    throw err;
                }
            }
        });
    });
    describe('isRevertCommit', () => {
        it('should find revert commits', async () => {
            await fs.appendFile('test.txt', 'A');
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', 'Msg']);
            await execFile('git', ['revert', 'HEAD']);
            const commitSequence = await getNewCommits();
            assert(isRevertCommit(commitSequence[1].message));
        });
        it('should just find revert commits', async () => {
            await fs.appendFile('test.txt', 'A');
            await execFile('git', ['add', '.']);
            await execFile('git', ['commit', '-m', 'Msg']);
            const commitSequence = await getNewCommits();
            assert(!isRevertCommit(commitSequence[0].message));
        });
    });
    describe('parseGitLog', () => {
        it('should return empty array on empty log', () => {
            assert.deepEqual(parseGitLog(''), new CommitSequence());
        });
        it('should parse hash, message and merkel tasks', async () => {
            const commits = parseGitLog(await fs.readFile(path.resolve(path.join(__dirname, '../../src/test/git_log_output.txt')), 'utf8'));
            for (const commit of commits) {
                for (const task of commit.tasks) {
                    delete task.commit;
                }
            }
            assert.deepEqual(commits, <CommitSequence>CommitSequence.from([
                {
                    sha1: 'c3555604ddfc24022508c5e1f9398c81f3b9b6fa',
                    message: 'Revert changes to user model\n\nThis reverts commit b9fb8f15176d958d42dba4f14e35f1bf71ec0be9\nand 900931208ae7dabfd9ede49a78d4a961aa8043ba.',
                    tasks: [
                        {
                            type: 'down',
                            migration: {
                                name: 'd9271b98-1a2e-445f-8363-783b2bee0ef0'
                            }
                        },
                        {
                            type: 'down',
                            migration: {
                                name: '694b8b6c-3aaa-4e4d-8d54-76515ba90617'
                            }
                        }
                    ]
                },
                {
                    sha1: 'b9fb8f15176d958d42dba4f14e35f1bf71ec0be9',
                    message: 'Change the User model',
                    tasks: [
                        {
                            type: 'up',
                            migration: {
                                name: '694b8b6c-3aaa-4e4d-8d54-76515ba90617'
                            }
                        },
                        {
                            type: 'up',
                            migration: {
                                name: 'd9271b98-1a2e-445f-8363-783b2bee0ef0'
                            }
                        }
                    ]
                },
                {
                    sha1: '900931208ae7dabfd9ede49a78d4a961aa8043ba',
                    message: 'Initial Commit',
                    tasks: []
                }
            ]));
        });
    });
    describe('getTasksForNewCommit', () => {
        it('should find new migrations', async () => {
            await addGitHook();
            await fs.mkdir('migrations');
            await fs.appendFile('migrations/text.txt', 'ABC');
            await execFile('git', ['add', '.']);
            const tasks = await getTasksForNewCommit('migrations');
            assert.deepEqual(tasks, [
                {
                    migration: {
                        name: 'text'
                    },
                    type: 'up'
                }
            ]);
        });
    });
    after(() => {
        return del('.git');
    });
});
