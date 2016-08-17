
import {exec} from 'mz/child_process';
import {resolve, basename} from 'path';

export type MigrationType = 'up' | 'down';

export interface Migration {
    type: 'up' | 'down';
    name: string;
}

export interface Commit {
    /** The commit SHA1 */
    sha1: string;
    /** The commit message, without commands */
    message: string;
    /** Migrations that should be run */
    migrations: Migration[];
}

/**
 * Gets all commits in the migration dir since the last migration head
 * @param migrationDir The migration directory
 * @param lastMigrationHead The commit sha1 of the commit when the last migration was Running
 */
export async function getNewCommits(migrationDir: string, lastMigrationHead: string): Promise<Commit[]> {
    const [stdout] = await exec(`git log --reverse --format=">>>>START%n%H%n%B>>>>END" --name-status ${lastMigrationHead}`);
    const output = stdout.toString().trim();
    return parseGitLog(output, migrationDir);
}

/**
 * Parses the output of `git log --reverse --format=">>>>START%n%H%n%B>>>>END" --name-status ${lastMigrationHead}`.
 * @private
 */
export function parseGitLog(gitLog: string, migrationDir: string): Commit[] {
    migrationDir = resolve(migrationDir);
    const commitStrings = gitLog.substr('>>>>START\n'.length).split('>>>>START\n');
    const commits = commitStrings.map(s => {
        let [, sha1, message, changesString] = s.match(/^(\w+)\n((?:.|\n|\r)*)>>>>END\n\n((?:.|\n)*)$/);
        // get commands from message
        const regExp = /\[\s*merkel[^\]]*\s*\]/g;
        const match = message.match(regExp);
        const commands: string[][] = match ? match.map(command => command.replace(/^\s*\[\s*/, '').replace(/\s*\]\s*$/, '').split(/\s+/g).slice(1)) : [];
        const migrations: Migration[] = [];
        for (const command of commands) {
            const type = <MigrationType>command.shift();
            for (const name of command.slice(1)) {
                migrations.push({ type, name });
            }
        }
        // look for added migration file
        const changes = changesString.replace(/\n$/, '').split('\n');
        for (const change of changes) {
            const status = change.charAt(0);
            const file = resolve(change.substr(1).trim());
            if (status === 'A' && file.startsWith(migrationDir)) {
                migrations.push({ type: 'up', name: basename(file).replace(/(?:\.\w +)* $ /, '') });
                break;
            }
        }
        message = message.replace(regExp, '');
        return { sha1, message, migrations };
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
