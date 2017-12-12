import { parse } from 'url'
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
    public abstract getLastMigrationTask(): Promise<Task>
    public abstract logMigrationTask(task: Task): Promise<void>
    public abstract checkIfTaskCanExecute(task: Task): Promise<void>
    public abstract close(): Promise<void>

    protected rowToTask(row: TableRow): Task {
        const task = new Task({
            id: row.id,
            type: row.type,
            appliedAt: row.applied_at,
            commit: new Commit({
                sha1: row.commit,
            }),
            head: new Commit({
                sha1: row.head,
            }),
            migration: new Migration({
                name: row.name,
            }),
        })
        return task
    }
}

import { PostgresAdapter } from './adapters/postgres'
export function createAdapterFromUrl(url: string): DbAdapter {
    const dialect = parse(url).protocol
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
