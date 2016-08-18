
import * as pg from 'pg';
import {DbAdapter, MigrationData} from '../adapter';
import {Migration} from '../migration';

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
            CREATE TABLE IF NOT EXISTS "merkel_meta" (
                "id" SERIAL NOT NULL,
                "commit" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "applied" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
        `);
    }

    async getLastMigration(): Promise<MigrationData> {
        // find out the current database state
        const result = await this.client.query(`
            SELECT "id", "name", "applied", "head" FROM "merkel_meta" ORDER BY "id" DESC;
        `);
        return <MigrationData>result.rows[0];
    }

    async logMigration(migration: Migration, head: string): Promise<void> {
        await this.client.query('INSERT INTO merkel_meta (name, applied, head) VALUES ($1, $2, $3)', [migration.name, new Date(), head]);
    }
}
