
import {exec} from 'mz/child_process';
import {resolve} from 'path';
import {Migration, MigrationType, Task} from './migration';

export class Commit {

    /** The commit SHA1 */
    sha1: string;

    /** The commit message, without commands */
    message: string;

    /** Migrations that should be run, in the order they were defined in the commit message */
    tasks: Task[] = [];
}

/**
 * Gets all commits in the migration dir since the last migration head
 * @param migrationDir The migration directory
 * @param lastMigrationHead The commit sha1 of the commit when the last migration was Running
 */
export async function getNewCommits(migrationDir: string, lastMigrationHead?: string): Promise<Commit[]> {
    let command = 'git log --reverse --format=">>>>COMMIT%n%H%n%B"';
    let stdout: Buffer;
    try {
        [stdout] = await exec(command + (lastMigrationHead ? ` ${lastMigrationHead}..HEAD` : ''));
    } catch (err) {
        if (err.code !== 128) {
            throw err;
        }
        // the last migration head does not exist in this repository
        [stdout] = await exec(command);
    }
    const output = stdout.toString().trim();
    return parseGitLog(output, migrationDir);
}

/**
 * Parses the output of `git log --reverse --format=">>>>COMMIT%n%H%n%B" ${lastMigrationHead}`.
 * @private
 */
export function parseGitLog(gitLog: string, migrationDir: string): Commit[] {
    if (gitLog === '') {
        return [];
    }
    migrationDir = resolve(migrationDir);
    const commitStrings = gitLog.substr('>>>>COMMIT\n'.length).split('>>>>COMMIT\n');
    const commits = commitStrings.map(s => {
        let [, sha1, message] = s.match(/^(\w+)\n((?:.|\n|\r)*)$/);
        const commit = new Commit();
        commit.sha1 = sha1;
        // get commands from message
        const regExp = /\[\s*merkel[^\]]*\s*\]/g;
        const match = message.match(regExp);
        const commands: string[][] = match ? match.map(command => command.replace(/^\s*\[\s*/, '').replace(/\s*\]\s*$/, '').split(/\s+/g).slice(1)) : [];
        for (const command of commands) {
            const type = <MigrationType>command.shift();
            for (const name of command) {
                commit.tasks.push(new Task(type, new Migration(name, migrationDir, commit)));
            }
        }
        // strip commands from message
        commit.message = message.replace(regExp, '');
        return commit;
    });
    return commits;
}

/**
 * Gets the SHA1 of the current git HEAD
 */
export async function getHead(): Promise<string> {
    const [stdout] = await exec('git rev-parse HEAD');
    return stdout.toString().trim();
}

// /**
//  * Adds the migration directory back to the index
//  */
// export async function addMigrationDir(migrationDir: string): Promise<void> {
//     await exec(`git add ${migrationDir}`);
// };
