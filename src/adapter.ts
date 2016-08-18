
import {Task} from './migration';

export abstract class DbAdapter {
    abstract init(): Promise<void>;
    abstract getLastMigrationTask(): Promise<Task>;
    abstract logMigrationTask(task: Task): Promise<void>;
}
