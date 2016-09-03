
import {Task, Migration, TaskType} from './migration';
import {PostgresAdapter} from './adapters/postgres';
import {Commit} from './git';
import {parse} from 'url';

export interface TableRow {
    id: number;
    name: string;
    type: TaskType;
    commit: string;
    head: string;
    applied_at: Date;
}

export abstract class DbAdapter {

    public abstract init(): Promise<void>;
    public abstract getLastMigrationTask(): Promise<Task>;
    public abstract logMigrationTask(task: Task): Promise<void>;
    public abstract checkIfTaskCanExecute(task: Task): Promise<void>;

    static getFromUrl(url: string): DbAdapter {
        const dialect = parse(url).protocol;
        switch (dialect) {
            case 'postgres:': return new PostgresAdapter(url, require(process.cwd() + '/node_modules/pg'));
            case null: throw new Error('Invalid connection URL ' + url);
            default: throw new Error('Unssuported dialect ' + dialect);
        }
    }

    protected rowToTask(row: TableRow): Task {
        const task = new Task({
            id: row['id'],
            type: row['type'],
            appliedAt: row['applied_at'],
            commit: new Commit({
                sha1: row['commit']
            }),
            head: new Commit({
                sha1: row['head']
            }),
            migration: new Migration({
                name: row['name']
            })
        });
        return task;
    }
}
