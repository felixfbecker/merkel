
import * as chalk from 'chalk';
import {resolve, sep} from 'path';
import {DbAdapter} from './adapter';
import {Commit} from './git';
import glob = require('globby');

export type TaskType = 'up' | 'down';

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
        const basePath = resolve(migrationDir, this.name ? this.name : '');
        const files = await glob(basePath + '*.*');
        if (files.length === 0) {
            throw new MigrationNotFoundError(this, migrationDir);
        }
        return resolve(files[0]);
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
     */
    public async execute(migrationDir: string, adapter: DbAdapter, head: Commit, commit?: Commit): Promise<void> {
        await adapter.checkIfTaskCanExecute(this);
        let migrationExports: any;
        try {
            const path = await this.migration.getPath(migrationDir);
            migrationExports = require(path);
        } catch (err) {
            throw new MigrationNotFoundError(this.migration, migrationDir);
        }
        if (typeof migrationExports.up !== 'function') {
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
                    Promise.resolve(migrationExports.up())
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
            throw new Error('Unknown migration type ' + this.type);
        }
    }
}
