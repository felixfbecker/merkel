import chalk from 'chalk'
import * as fs from 'mz/fs'
import { resolve, sep } from 'path'
import { DbAdapter } from './adapter'
import { Commit, getConfigurationForCommit } from './git'

export type TaskType = 'up' | 'down'

export class MigrationLoadError extends Error {
    constructor(public migration: Migration, public migrationDir: string, public error: any) {
        super('Error loading migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js:\n' + error)
    }
}

export class FirstDownMigrationError extends Error {
    constructor(public migration: Migration) {
        super(`The first migration cannot be a down migration (${migration.name})`)
    }
}
export class MigrationRunTwiceError extends Error {
    constructor(public migration: Migration, public type: 'up' | 'down') {
        super(`Tried to run the same migration (${migration.name}) ${type} twice`)
    }
}
export class MigrationNotFoundError extends Error {
    constructor(public migration: Migration, public migrationDir: string) {
        super('Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not exist')
    }
}
export class TaskTypeNotFoundError extends Error {
    constructor(public migration: Migration, public taskType: TaskType, public migrationDir: string) {
        super(
            'Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not export an up function'
        )
    }
}
export class MigrationExecutionError extends Error {
    constructor(public original: any) {
        super(chalk.red(chalk.bold('Migration error: ') + original.stack || original))
    }
}
export class UnknownTaskTypeError extends Error {
    constructor(type: string) {
        super('Unknown migration type ' + type)
    }
}

export class Migration {
    constructor(
        /** The name of the migration */
        public name: string
    ) {}

    /**
     * @param migrationDir The migration directory
     */
    public async getPath(migrationDir: string): Promise<string> {
        const file = resolve(migrationDir, (this.name || '') + '.js')
        try {
            await fs.access(file)
            return file
        } catch (err) {
            throw new MigrationNotFoundError(this, migrationDir)
        }
    }
}

export class TaskList extends Array<Task> {
    /**
     * Converts the task list to a string of commands that can be embedded in a commit message
     */
    public toString(withComment = false): string {
        let str = ''
        if (this.length > 0) {
            if (withComment) {
                str += '# Merkel migrations that need to run after checking out this commit:\n'
            }
            for (const type of ['up', 'down']) {
                const tasks = this.filter(task => task.type === type)
                if (tasks.length === 0) {
                    continue
                }
                let command = `[merkel ${type} ${tasks.map(task => task.migration.name).join(' ')}]\n`
                if (command.length > 72) {
                    command = `[\n  merkel ${type}\n  ${tasks.map(task => task.migration.name).join('\n  ')}\n]\n`
                }
                str += command
            }
        }
        return str.trim()
    }

    public async execute(migrationDir: string, adapter: DbAdapter, head?: Commit, commit?: Commit): Promise<void> {
        for (const task of this) {
            await task.execute(migrationDir, adapter, head, commit)
        }
    }
}

export class Task {
    // If the task was already executed:
    /** The sequential id of the task entry in the database */
    public id: number | undefined
    /** The function that was executed */
    public type: TaskType
    /** The migration that was run */
    public migration: Migration
    /** The commit that triggered the task, if triggered by a commit */
    public commit?: Commit
    /** The git HEAD at the time the task was executed */
    public head?: Commit
    /** The date when the migration was applied if already executed */
    public appliedAt?: Date

    constructor(options: {
        id?: number
        type: TaskType
        migration: Migration
        commit?: Commit
        head?: Commit
        appliedAt?: Date
    }) {
        this.id = options.id
        this.type = options.type
        this.migration = options.migration
        this.commit = options.commit
        this.head = options.head
        this.appliedAt = options.appliedAt
    }

    public invert(): Task {
        return new Task({
            id: this.id,
            type: this.type === 'up' ? 'down' : 'up',
            migration: this.migration,
            commit: this.commit,
            head: this.head,
            appliedAt: this.appliedAt,
        })
    }

    /**
     * Executes the task
     * @param migrationDir the fallback folder to search the migration in if no merkelrc can be found
     */
    public async execute(migrationDir: string, adapter: DbAdapter, head?: Commit, commit?: Commit): Promise<void> {
        await adapter.checkIfTaskCanExecute(this)
        let migrationExports: any
        if (commit) {
            const currentConfig = await getConfigurationForCommit(new Commit({ sha1: 'HEAD' }))
            if (!(currentConfig && currentConfig.configLookback === false)) {
                const config = await getConfigurationForCommit(commit)
                if (config && config.migrationOutDir) {
                    migrationDir = config.migrationOutDir
                }
            }
        }
        const path = await this.migration.getPath(migrationDir)
        try {
            migrationExports = require(path)
        } catch (err) {
            throw new MigrationLoadError(this.migration, migrationDir, err)
        }
        if (typeof migrationExports[this.type] !== 'function') {
            throw new TaskTypeNotFoundError(this.migration, this.type, migrationDir)
        }
        try {
            let exceptionHandler: (() => void) | undefined
            try {
                await Promise.race([
                    new Promise<never>((_, reject) => {
                        exceptionHandler = reject
                        process.on('uncaughtException', reject)
                    }),
                    Promise.resolve(migrationExports[this.type]()),
                ])
            } finally {
                if (exceptionHandler) {
                    process.removeListener('uncaughtException', exceptionHandler)
                }
            }
        } catch (err) {
            throw new MigrationExecutionError(err)
        }
        this.head = head
        this.commit = commit
        this.appliedAt = new Date()
        await adapter.finishMigrationTask(this)
    }

    /**
     * Converts the task to a short string including the type and migration name that can be shown
     * in the CLI
     */
    public toString(): string {
        if (this.type === 'up') {
            return chalk.bgGreen('▲ UP   ' + this.migration.name)
        } else if (this.type === 'down') {
            return chalk.bgRed('▼ DOWN ' + this.migration.name)
        } else {
            throw new UnknownTaskTypeError(this.type)
        }
    }
}
