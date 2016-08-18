
import * as chalk from 'chalk';
import {resolve, sep} from 'path';
import {DbAdapter} from './adapter';
import {Commit} from './git';
import glob = require('globby');

export type MigrationType = 'up' | 'down';

export class MigrationNotFoundError extends Error {
    constructor(public migration: string, public migrationDir: string) {
        super('Error: Migration file ' + migrationDir + sep + chalk.bold(migration) + '.js does not exist');
    }
}
export class MigrationTypeNotFoundError extends Error {
    constructor(public migration: string, public migrationType: MigrationType, public migrationDir: string) {
        super('Error: Migration file ' + migrationDir + sep + chalk.bold(migration) + '.js does not export an up function');
    }
}
export class MigrationError extends Error {
    constructor(public original: any) {
        super(chalk.red(chalk.bold('Migration error: ') + original.stack || original));
    }
}

export class Migration {

    /** The name of the migration */
    public name: string;

    /** The migration directory */
    public migrationDir: string;

    constructor(options?: { name?: string, migrationDir?: string }) {
        Object.assign(this, options);
    }

    public async execute(type: MigrationType, adapter: DbAdapter, head: string): Promise<void> {
        let migrationExports: any;
        try {
            const path = await this.getPath();
            migrationExports = require(path);
        } catch (err) {
            throw new MigrationNotFoundError(this.name, this.migrationDir);
        }
        if (typeof migrationExports.up !== 'function') {
            throw new MigrationTypeNotFoundError(this.name, type, this.migrationDir);
        }
        let exceptionHandler: Function;
        try {
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
            throw new Error('\n' + chalk.red(chalk.bold('Migration error: ') + err.stack || err));
        }
        await adapter.logMigrationTask(this, head);
    }

    public async getPath(): Promise<string> {
        const basePath = resolve(this.migrationDir, this.name);
        const files = await glob(basePath + '.*');
        if (files.length === 0) {
            throw new MigrationNotFoundError(this.name, this.migrationDir);
        }
        return files[0];
    }
}

export class Task {

    /** The function that was executed */
    public type: MigrationType;

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

    constructor(options?: { id?: number, type?: MigrationType, migration?: Migration, commit?: Commit, head?: Commit, appliedAt?: Date }) {
        Object.assign(this, options);
    }

    /**
     * Executes the task
     */
    public execute(adapter: DbAdapter, head: string): Promise<void> {
        return this.migration.execute(this.type, adapter, head);
    }

    /**
     * Converts the task to a short string including the type and migration name that can be shown
     * in the CLI
     */
    public toString(): string {
        if (this.type === 'up') {
            return chalk.bgGreen('▲ UP   ' + this.migration.name);
        } else if (this.type === 'down') {
            return chalk.bgGreen('▼ DOWN ' + this.migration.name);
        } else {
            throw new Error('Unknown migration type ' + this.type);
        }
    }
}
