
import {ChildProcess, execFile, spawn} from 'mz/child_process';
import * as chalk from 'chalk';
import * as path from 'path';
import * as fs from 'mz/fs';
import {Migration, TaskType, Task, TaskList} from './migration';
import {MerkelConfiguration} from './index';
import {resolve, basename} from 'path';

export class HookAlreadyFoundError extends Error {
}

export class NoCommitsError extends Error {
}

export class UnknownCommitError extends Error {
    constructor(commit: Commit) {
        super(`The commit ${commit.shortSha1} does not exist in this repository. Did you do a shallow clone?`);
    }
}

export class CommitSequence extends Array<Commit> {
    /**
     * Wether the HEAD commit was before the last migration HEAD commit
     */
    public isReversed: boolean = false;
}

export class Commit {

    /** The commit SHA1 */
    sha1: string;

    /** The commit message, without tasks */
    message: string;

    /** Migrations that should be run, in the order they were defined in the commit message */
    tasks: TaskList = new TaskList();

    /** The first 6 letters of the SHA1 */
    get shortSha1(): string {
        return this.sha1.substring(0, 7);
    }

    /** The first line of the commit message */
    get subject(): string {
        return this.message && this.message.split('\n', 1)[0];
    }

    constructor(options?: { sha1?: string, message?: string, tasks?: TaskList }) {
        Object.assign(this, options);
    }

    /**
     * Loads more info by using `git show <sha1>`
     */
    public async loadSubject(): Promise<void> {
        if (this.message === undefined) {
            const [stdout] = await execFile('git', ['log', '--format=%B', this.sha1]);
            this.message = stdout.toString();
        }
    }

    public toString(): string {
        return chalk.yellow.bold(this.shortSha1) + ' ' + (this.subject ? this.subject : '<unknown commit>');
    }
}

async function hasHead(): Promise<Boolean> {
    try {
        await execFile('git', ['show', '--format=%H', '--no-patch', 'HEAD']);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Gets all commits in the migration dir since the last migration head
 * @param from The commit sha1 of the commit when the last migration was running
 */
export async function getNewCommits(since?: Commit): Promise<CommitSequence> {
    if (since) {
        try {
            await execFile('git', ['show', '--format=%H', '--no-patch', since.sha1]);
        } catch (err) {
            // the last migration head does not exist in this repository
            throw new UnknownCommitError(since);
        }
    }
    if (!(await hasHead())) {
        return new CommitSequence();
    }
    // check if the HEAD is behind the last migration
    let headBehindLastMigration = false;
    if (since) {
        try {
            await execFile('git', ['merge-base', '--is-ancestor', since.sha1, 'HEAD']);
        } catch (err) {
            /* istanbul ignore next */
            if (err.code !== 1) {
                throw err;
            }
            headBehindLastMigration = true;
        }
    }
    const args = ['log', '--reverse', '--format=>>>>COMMIT%n%H%n%B'];
    if (since) {
        args.push(headBehindLastMigration ? 'HEAD..' + since.sha1 : since.sha1 + '..HEAD');
    }
    const commits = await (new Promise<CommitSequence>((resolve, reject) => {
        const gitProcess = spawn('git', args);
        let buffer = '';
        const parsedCommits = new CommitSequence();
        gitProcess.stdout.on('data', data => {
            buffer += data.toString().trim();
            const commitMarkerIndex = buffer.lastIndexOf('>>>>COMMIT\n');
            if (commitMarkerIndex !== -1) {
                const completeCommits = buffer.substring(0, commitMarkerIndex);
                buffer = buffer.substring(commitMarkerIndex);
                const parsedLog = parseGitLog(completeCommits);
                for (const commit of parsedLog) {
                    parsedCommits.push(commit);
                }
            }
        });
        gitProcess.on('error', reject);
        gitProcess.on('exit', code => {
            if (code !== 0) {
                reject(new Error('git errored: ' + code));
            }
            const parsedLog = parseGitLog(buffer);
            for (const commit of parsedLog) {
                parsedCommits.push(commit);
            }
            resolve(parsedCommits);
        });
    }));
    commits.isReversed = headBehindLastMigration;
    return commits;
}

export async function getConfigurationForCommit(commit: Commit): Promise<MerkelConfiguration> {
    if (commit.sha1) {
        try {
            const [merkelRc] = await execFile('git', ['show', `${commit.sha1}:.merkelrc.json`]);
            const merkelConfig = JSON.parse(merkelRc);
            if (merkelConfig) {
                return <MerkelConfiguration>merkelConfig;
            }
        } catch (err) {
            /* istanbul ignore next */
            if (~~err.code !== 128) {
                throw err;
            }
            // no merkelrc in this commit
        }
    }
    return null;
}

export async function addGitHook(): Promise<['appended' | 'created', string]> {
    const hookPath = path.normalize('.git/hooks/prepare-commit-msg');
    const hook = [
        '',
        'PATH="$(pwd)/node_modules/merkel/bin:$PATH"',
        'merkel prepare-commit-msg $1 $2 $3',
        ''
    ].join('\n');
    let content: string;
    try {
        content = await fs.readFile(hookPath, 'utf8');
    } catch (err) {
        await fs.writeFile(hookPath, '#!/bin/sh\n' + hook);
        return ['created', hookPath] as ['created', string];
    }
    if (content && content.indexOf(hook.substring(1, hook.length - 1)) !== -1) {
        throw new HookAlreadyFoundError();
    }
    await fs.appendFile(hookPath, hook);
    return ['appended', hookPath] as ['appended', string];
}

/**
 * Parses the output of `git log --reverse --format=">>>>COMMIT%n%H%n%B" ${lastMigrationHead}`.
 */
export function parseGitLog(gitLog: string): CommitSequence {
    if (gitLog === '') {
        return new CommitSequence();
    }
    const commitStrings = gitLog.substr('>>>>COMMIT\n'.length).split('>>>>COMMIT\n');
    const commits = new CommitSequence();
    for (const s of commitStrings) {
        let [, sha1, message] = s.match(/^(\w+)\n((?:.|\n|\r)*)$/);
        message = message.trim();
        const commit = new Commit({ sha1 });
        // get commands from message
        const regExp = /\[\s*merkel[^\]]*\s*\]/g;
        const match = message.match(regExp);
        const commands: string[][] = match ? match.map(command => command.replace(/^\s*\[\s*/, '').replace(/\s*\]\s*$/, '').split(/\s+/g).slice(1)) : [];
        for (const command of commands) {
            const type = <TaskType>command.shift();
            for (const name of command) {
                commit.tasks.push(new Task({ type, migration: new Migration({ name }), commit }));
            }
        }
        // strip commands from message
        commit.message = message.replace(regExp, '').trim();
        commits.push(commit);
    }
    return commits;
}

/**
 * Gets the SHA1 of the current git HEAD
 */
export async function getHead(): Promise<Commit> {
    try {
        const [stdout] = await execFile('git', ['rev-parse', 'HEAD']);
        return new Commit({ sha1: stdout.trim() });
    } catch (err) {
        throw new NoCommitsError(err.message);
    }
}

export async function getTasksForNewCommit(migrationDir: string): Promise<TaskList> {
    migrationDir = resolve(migrationDir);
    const [stdout] = await execFile('git', ['diff', '--staged', '--name-status']);
    const output = stdout.toString().trim();
    const tasks = new TaskList();
    // added migration files should be executed up
    for (const line of output.split('\n')) {
        const status = line.charAt(0);
        const file = resolve(line.substr(1).trim());
        if (status === 'A' && file.startsWith(migrationDir)) {
            const name = basename(file).replace(/\.\w*$/, '');
            tasks.push(new Task({ type: 'up', migration: new Migration({ name }) }));
        }
    }
    return tasks;
}

export function isRevertCommit(message: string): boolean {
    return /Revert/.test(message);
}
