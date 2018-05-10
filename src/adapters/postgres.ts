import * as pg from 'pg'
import { SQL } from 'sql-template-strings'
import { DbAdapter, PendingMigrationFoundError } from '../adapter'
import { FirstDownMigrationError, MigrationRunTwiceError, Task } from '../migration'

export class PostgresAdapter extends DbAdapter {
    private client: pg.Client
    private lib: typeof pg

    /**
     * @param url The connection url
     * @param lib The pg library
     */
    constructor(url: string, lib: typeof pg) {
        super()
        this.lib = lib
        this.client = new this.lib.Client({ connectionString: url })
    }

    /**
     * Connects to the database and sets up the schema if required
     */
    public async init(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.client.connect(err => (err ? reject(err) : resolve())))
        await this.client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'merkel_migration_type') THEN
                    CREATE TYPE "merkel_migration_type" AS ENUM ('up', 'down');
                END IF;
            END$$
        `)
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS "merkel_meta" (
                "id" SERIAL NOT NULL PRIMARY KEY,
                "name" TEXT NOT NULL,
                "type" merkel_migration_type,
                "commit" TEXT,
                "head" TEXT NOT NULL,
                "applied_at" TIMESTAMP WITH TIME ZONE
            );
        `)
        // migrate schema from merkel <= 0.19
        await this.client.query(`ALTER TABLE "merkel_meta" ALTER COLUMN "applied_at" DROP NOT NULL`)
    }

    public close(): Promise<void> {
        return new Promise<void>(resolve => {
            this.client.on('end', resolve)
            // tslint:disable-next-line:no-floating-promises
            this.client.end()
        })
    }

    /**
     * Gets the last migration task that was executed
     */
    public async getLastMigrationTask(): Promise<Task | null> {
        // find out the current database state
        const { rows } = await this.client.query(`
            SELECT "id", "name", "applied_at", "type", "commit", "head"
            FROM "merkel_meta"
            WHERE "applied_at" IS NOT NULL
            ORDER BY "id" DESC
            LIMIT 1
        `)
        return rows.length === 0 ? null : this.rowToTask(rows[0])
    }

    /**
     * Logs a task to the database. Sets the task ID
     */
    public async beginMigrationTask(task: Task): Promise<void> {
        if (!task.head) {
            throw new Error('Task has no HEAD')
        }
        await this.client.query(`BEGIN TRANSACTION`)
        try {
            await this.client.query(`LOCK TABLE "merkel_meta"`)
            if (await this.hasPendingMigration()) {
                throw new PendingMigrationFoundError()
            }
            const { rows } = await this.client.query(SQL`
                INSERT INTO merkel_meta ("name", "type", "commit", "head")
                VALUES (
                    ${task.migration.name},
                    ${task.type},
                    ${task.commit ? task.commit.sha1 : null},
                    ${task.head.sha1}
                )
                RETURNING id
            `)
            await this.client.query(`COMMIT`)
            task.id = rows[0].id
        } finally {
            await this.client.query(`ROLLBACK`)
        }
    }

    /**
     * Marks the task as finished
     */
    public async finishMigrationTask(task: Task): Promise<void> {
        const head = task.head ? task.head.sha1 : null
        const commit = task.commit ? task.commit.sha1 : null
        await this.client.query(SQL`
            UPDATE merkel_meta
            SET
                "applied_at" = ${task.appliedAt},
                "head" = ${head},
                "commit" = ${commit}
            WHERE "id" = ${task.id}
        `)
    }

    /**
     * Checks that the same task cannot be executed two times in a row and the first task cannot be
     * a down task
     */
    public async checkIfTaskCanExecute(task: Task): Promise<void> {
        const { rows } = await this.client.query(SQL`
            SELECT "type"
            FROM "merkel_meta"
            WHERE "name" = ${task.migration.name}
            AND "applied_at" IS NOT NULL
            ORDER BY "id" DESC
            LIMIT 1
        `)
        if (task.type === 'up') {
            if (rows.length > 0 && rows[0].type === 'up') {
                throw new MigrationRunTwiceError(task.migration, 'up')
            }
        } else if (task.type === 'down') {
            if (rows.length === 0) {
                throw new FirstDownMigrationError(task.migration)
            } else if (rows[0].type === 'down') {
                throw new MigrationRunTwiceError(task.migration, 'down')
            }
        }
    }

    protected async hasPendingMigration(): Promise<boolean> {
        const { rows } = await this.client.query(SQL`
            SELECT "type"
            FROM "merkel_meta"
            WHERE "applied_at" IS NULL
            LIMIT 1
        `)
        return rows.length !== 0
    }
}
