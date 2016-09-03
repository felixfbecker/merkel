
import * as pg from 'pg';
import {SQL} from 'sql-template-strings';
import {DbAdapter} from '../adapter';
import {
    Task,
    MigrationRunTwiceError,
    FirstDownMigrationError
} from '../migration';

export class PostgresAdapter extends DbAdapter {

    private client: pg.Client;
    private lib: typeof pg;

    /**
     * @param url The connection url
     * @param lib The pg library
     */
    constructor(url: string, lib: typeof pg) {
        super();
        this.lib = lib;
        this.client = new this.lib.Client(url);
    }

    /**
     * Connects to the database and sets up the schema if required
     */
    async init(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.client.connect(err => err ? reject(err) : resolve()));
        try {
            await this.client.query(`CREATE TYPE "merkel_migration_type" AS ENUM ('up', 'down')`);
        } catch (err) {
            /* istanbul ignore next */
            if (~~err.code !== 42710) { // duplicate object
                throw err;
            }
            // else ignore
        }
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS "merkel_meta" (
                "id" SERIAL NOT NULL PRIMARY KEY,
                "name" TEXT NOT NULL,
                "type" merkel_migration_type,
                "commit" TEXT,
                "head" TEXT NOT NULL,
                "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL
            );
        `);
    }

    /**
     * Gets the last migration task that was executed
     */
    async getLastMigrationTask(): Promise<Task> {
        // find out the current database state
        const {rows} = await this.client.query(`
            SELECT "id", "name", "applied_at", "type", "commit", "head"
            FROM "merkel_meta"
            ORDER BY "id" DESC
            LIMIT 1
        `);
        return rows.length === 0 ? null : this.rowToTask(<any>rows[0]);
    }

    /**
     * Logs an executed task to the database. Sets the task ID
     */
    async logMigrationTask(task: Task): Promise<void> {
        const {rows} = await this.client.query(SQL`
            INSERT INTO merkel_meta ("name", "type", "commit", "head", "applied_at")
            VALUES (
                ${task.migration.name},
                ${task.type},
                ${task.commit ? task.commit.sha1 : null},
                ${task.head.sha1},
                ${task.appliedAt}
            )
            RETURNING id
        `);
        task.id = rows[0]['id'];
    }

    /**
     * Checks that the same task cannot be executed two times in a row and the first task cannot be
     * a down task
     */
    public async checkIfTaskCanExecute(task: Task): Promise<void> {
        const {rows} = await this.client.query(SQL`
            SELECT "type"
            FROM "merkel_meta"
            WHERE "name" = ${task.migration.name}
            ORDER BY "id" DESC
            LIMIT 1
        `);
        if (task.type === 'up') {
            if (rows.length > 0 && rows[0]['type'] === 'up') {
                throw new MigrationRunTwiceError(task.migration, 'up');
            }
        } else if (task.type === 'down') {
            if (rows.length === 0) {
                throw new FirstDownMigrationError(task.migration);
            } else if (rows[0]['type'] === 'down') {
                throw new MigrationRunTwiceError(task.migration, 'down');
            }
        }
    }
}
