
import * as pg from 'pg';
import {DbAdapter, MigrationData} from './abstract';

export class PostgresAdapter extends DbAdapter {

    private client: pg.Client;

    constructor(url: string, private lib: typeof pg) {
        super();
        this.lib = lib;
        this.client = new this.lib.Client(url);
    }

    async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.client.connect(err => err ? reject(err) : resolve()));
        await this.client.query(`
            CREATE TABLE IF NOT EXISTS "merkel_meta" (
                "id" SERIAL,
                "head" TEXT,
                "migration" TEXT NOT NULL,
                "applied" TIMESTAMP WITH TIME ZONE NOT NULL
            );
        `);
    }

    async getLastMigration(): Promise<MigrationData> {
        // find out the current database state
        const result = await this.client.query(`
            SELECT "id", "migration" FROM "merkel_meta" ORDER BY "applied" DESC;
        `);
        return <MigrationData>result.rows[0];
    }

    async logMigration(name: string): Promise<void> {
        await this.client.query('INSERT INTO merkel_meta (migration, applied) VALUES ($1, $2)', [name, new Date()]);
    }
}
