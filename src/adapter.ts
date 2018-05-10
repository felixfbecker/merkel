import chalk from 'chalk'
import { parse } from 'url'
import { Logger } from '.'
import { Commit } from './git'
import { Migration, Task, TaskType } from './migration'

export class InvalidConnectionError extends Error {
    constructor(url: string) {
        super('Invalid connection URL ' + url)
    }
}

export class UnsupportedDialectError extends Error {
    constructor(dialect: string) {
        super('Unsupported dialect: ' + dialect)
    }
}

export class PendingMigrationTimedOutError extends Error {
    /* istanbul ignore next */
    public readonly name = 'PendingMigrationTimedOutError'
}

export class PendingMigrationFoundError extends Error {
    /* istanbul ignore next */
    public readonly name = 'PendingMigrationFoundError'
}

export interface TableRow {
    id: number
    name: string
    type: TaskType
    commit: string
    head: string
    applied_at: Date
}

export abstract class DbAdapter {
    public abstract init(): Promise<void>
    public abstract getLastMigrationTask(): Promise<Task | null>
    public abstract beginMigrationTask(task: Task): Promise<void>
    public abstract finishMigrationTask(task: Task): Promise<void>
    public abstract checkIfTaskCanExecute(task: Task): Promise<void>
    public abstract close(): Promise<void>
    protected abstract hasPendingMigration(): Promise<boolean>

    public async waitForPending(logger: Logger): Promise<boolean> {
        let wasPending = false
        let shouldRetry = true
        await Promise.race([
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new PendingMigrationTimedOutError()), 1000 * 60 * 10)
            ),
            (async () => {
                // fail after 10 min
                let interval: NodeJS.Timer | undefined
                while (shouldRetry) {
                    // if there are rows, a migration is already running
                    if (!(await this.hasPendingMigration())) {
                        if (wasPending) {
                            logger.log('\n\n')
                        }
                        break
                    }
                    if (!wasPending) {
                        logger.log(`${chalk.yellow('Waiting for pending migrations')} ...`)
                        // we had to wait for at least 1 pending migration
                        wasPending = true
                        interval = setInterval(() => logger.log('.'), 300)
                    }
                    // wait for 1000ms before retrying
                    await new Promise<void>(resolve => setTimeout(resolve, 1000))
                }
                if (interval) {
                    clearInterval(interval)
                }
            })(),
        ])
        shouldRetry = false
        return wasPending
    }

    protected rowToTask(row: TableRow): Task {
        const task = new Task({
            id: row.id,
            type: row.type,
            migration: new Migration(row.name),
            commit: new Commit({ sha1: row.commit }),
            head: new Commit({ sha1: row.head }),
            appliedAt: row.applied_at,
        })
        return task
    }
}

import { PostgresAdapter } from './adapters/postgres'
export function createAdapterFromUrl(url: string): DbAdapter {
    const dialect = parse(url).protocol as string | null
    switch (dialect) {
        case 'postgres:':
            try {
                return new PostgresAdapter(url, require(process.cwd() + '/node_modules/pg'))
            } catch (err) {
                /* istanbul ignore next */
                return new PostgresAdapter(url, require('pg'))
            }
        case null:
            throw new InvalidConnectionError(url)
        default:
            throw new UnsupportedDialectError(dialect)
    }
}
