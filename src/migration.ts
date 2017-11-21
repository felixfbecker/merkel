
import * as chalk from 'chalk';
import {resolve, sep} from 'path';
import {DbAdapter} from './adapter';
import {Commit, getConfigurationForCommit} from './git';
import * as fs from 'mz/fs';

export type TaskType = 'up' | 'down';

export class MigrationLoadError extends Error {
    constructor(public migration: Migration, public migrationDir: string, public error: any) {
        super('Error loading migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js:\n' + error);
    }
}

export class FirstDownMigrationError extends Error {
    constructor(public migration: Migration) {
        super(`The first migration cannot be a down migration (${migration.name})`);
    }
}
export class MigrationRunTwiceError extends Error {
    constructor(public migration: Migration, public type: 'up' | 'down') {
        super(`Tried to run the same migration (${migration.name}) ${type} twice`);
    }
}
export class MigrationNotFoundError extends Error {
    constructor(public migration: Migration, public migrationDir: string) {
        super('Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not exist');
    }
}
export class TaskTypeNotFoundError extends Error {
    constructor(public migration: Migration, public taskType: TaskType, public migrationDir: string) {
        super('Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not export an up function');
    }
}
export class MigrationExecutionError extends Error {
    constructor(public original: any) {
        super(chalk.red(chalk.bold('Migration error: ') + original.stack || original));
    }
}
export class UnknownTaskTypeError extends Error {
    constructor(type: string) {
        super('Unknown migration type ' + type);
    }
}

export class Migration {

    /** The name of the migration */
    public name: string;

    constructor(options?: { name?: string }) {
        Object.assign(this, options);
    }

    /**
     * @param migrationDir The migration directory
     */
    public async getPath(migrationDir: string): Promise<string> {
        const file = resolve(migrationDir, (this.name || '') + '.js');
        try {
            await fs.access(file);
            return file;
        } catch (err) {
            throw new MigrationNotFoundError(this, migrationDir);
        }
    }
}

export class TaskList extends Array<Task> {

    /**
     * Converts the task list to a string of commands that can be embedded in a commit message
     */
    public toString(withComment: boolean = false): string {
        let str = '';
        if (this.length > 0) {
            if (withComment) {
                str += '# Merkel migrations that need to run after checking out this commit:\n';
            }
            for (const type of ['up', 'down']) {
                const tasks = this.filter(task => task.type === type);
                if (tasks.length === 0) {
                    continue;
                }
                let command = `[merkel ${type} ${tasks.map(task => task.migration.name).join(' ')}]\n`;
                if (command.length > 72) {
                    command = `[\n  merkel ${type}\n  ${tasks.map(task => task.migration.name).join('\n  ')}\n]\n`;
                }
                str += command;
            }
        }
        return str.trim();
    }

    public async execute(migrationDir: string, adapter: DbAdapter, head: Commit, commit?: Commit): Promise<void> {
        for (const task of this) {
            await task.execute(migrationDir, adapter, head, commit);
        }
    }
}

export class Task {

    /** The function that was executed */
    public type: TaskType;

    /** The migration that was run */
    public migration: Migration;

    // If the task was already executed:

    /** The sequential id of the task entry in the database */
    public id: number;

    /** The commit that triggered the task, if triggered by a commit */
    public commit: Commit;

    /** The git HEAD at the time the task was executed */
    public head: Commit;

    /** The date when the migration was applied if already executed */
    public appliedAt: Date;

    constructor(options?: { id?: number, type?: TaskType, migration?: Migration, commit?: Commit, head?: Commit, appliedAt?: Date }) {
        Object.assign(this, options);
    }

    public invert() {
        return Object.assign(new Task(this), { type: (<any>{up: 'down', down: 'up'})[this.type] });
    }

    /**
     * Executes the task
     * @param migrationDir the fallback folder to search the migration in if no merkelrc can be found
     */
    public async execute(migrationDir: string, adapter: DbAdapter, head: Commit, commit?: Commit): Promise<void> {
        await adapter.checkIfTaskCanExecute(this);
        let migrationExports: any;
        if (commit) {
            const config = await getConfigurationForCommit(commit);
            if (config && config.migrationOutDir) {
                migrationDir = config.migrationOutDir;
            }
        }
        const path = await this.migration.getPath(migrationDir);
        try {
            migrationExports = require(path);
        } catch (err) {
            throw new MigrationLoadError(this.migration, migrationDir, err);
        }
        if (typeof migrationExports[this.type] !== 'function') {
            throw new TaskTypeNotFoundError(this.migration, this.type, migrationDir);
        }
        try {
            let exceptionHandler: Function;
            try {
                await Promise.race([
                    new Promise((resolve, reject) => {
                        exceptionHandler = reject;
                        process.on('uncaughtException', reject);
                    }),
                    Promise.resolve(migrationExports[this.type]())
                ]);
            } finally {
                process.removeListener('uncaughtException', exceptionHandler);
            }
        } catch (err) {
            throw new MigrationExecutionError(err);
        }
        this.head = head;
        this.commit = commit;
        this.appliedAt = new Date();
        await adapter.logMigrationTask(this);
    }

    /**
     * Converts the task to a short string including the type and migration name that can be shown
     * in the CLI
     */
    public toString(): string {
        if (this.type === 'up') {
            return chalk.bgGreen('▲ UP   ' + this.migration.name);
        } else if (this.type === 'down') {
            return chalk.bgRed('▼ DOWN ' + this.migration.name);
        } else {
            throw new UnknownTaskTypeError(this.type);
        }
    }
}
