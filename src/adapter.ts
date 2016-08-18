
import {Task, Migration, MigrationType} from './migration';
import {Commit} from './git';

export interface TableRow {
    id: number;
    name: string;
    type: MigrationType;
    commit: string;
    head: string;
    applied_at: Date;
}

export abstract class DbAdapter {

    public abstract init(): Promise<void>;
    public abstract getLastMigrationTask(): Promise<Task>;
    public abstract logMigrationTask(task: Task): Promise<void>;
    public abstract checkIfTaskCanExecute(task: Task): Promise<void>;

    protected rowToTask(row: TableRow): Task {
        return new Task({
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
    }
}
