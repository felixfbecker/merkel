import {TaskType, Task, Migration} from './src/migration';
import {getHead} from './src/git';
import {DbAdapter} from './src/adapter';
import * as chalk from 'chalk';

export interface Logger {

    log(msg: string): void;

    error(msg: string): void;

}

export async function migrate(type: TaskType, migrationDir: string, db: string, migrations: string[], logger: Logger) {
    const head = await getHead();
    const adapter = DbAdapter.getFromUrl(db);
    await adapter.init();
    for (const name of migrations) {
        const task = new Task({
            type: 'up',
            migration: new Migration({ name })
        });
        logger.log(`Executing ${task.toString()}...`);
        await task.execute(migrationDir, adapter, head);
        logger.log(' Success\n');
    }
    logger.log('\n' + chalk.green.bold('Migration successful') + '\n');
}
