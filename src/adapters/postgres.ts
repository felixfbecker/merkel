
import * as pg from 'pg';
import {SQL} from 'sql-template-strings';
import {DbAdapter} from '../adapter';
import {Migration, Task} from '../migration';
import {Commit} from '../git';

export class PostgresAdapter extends DbAdapter {

    private client: pg.Client;

    constructor(url: string, private lib: typeof pg) {
        super();
        this.lib = lib;
        this.client = new this.lib.Client(url);
    }

    async init(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.client.connect(err => err ? reject(err) : resolve()));
        await this.client.query(`
            CREATE TYPE IF NOT EXISTS "merkel_migration_type" AS ENUM ('up', 'down');
            CREATE TABLE IF NOT EXISTS "merkel_meta" (
                "id" SERIAL NOT NULL,
                "name" TEXT NOT NULL,
                "type" merkel_migration_type,
                "commit" TEXT,
                "head" TEXT NOT NULL,
                "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL
            );
        `);
    }

    async getLastMigrationTask(): Promise<Task> {
        // find out the current database state
        const {rows} = await this.client.query(`
            SELECT "id", "name", "applied_at", "type", "commit", "head"
            FROM "merkel_meta"
            ORDER BY "id" DESC
            LIMIT 1
        `);
        const data = rows[0];
        if (!data) {
            return null;
        }
        const task = new Task({
            id: data['id'],
            type: data['type'],
            appliedAt: data['applied_at'],
            commit: new Commit({
                sha1: data['commit']
            }),
            head: new Commit({
                sha1: data['head']
            }),
            migration: new Migration({
                name: data['name']
            })
        });
        return task;
    }

    async logMigrationTask(task: Task): Promise<void> {
        await this.client.query(SQL`
            INSERT INTO merkel_meta
                        ("name", "type", "commit", "head", "applied_at")
            VALUES      (${task.migration.name}, ${task.type}, ${task.commit ? task.commit.sha1 : null}, ${task.head}, ${task.appliedAt})
        `);
    }

    async wasMigrationExecuted(migration: Migration): Promise<boolean> {
        await this.client.query('SE')
    }
}
