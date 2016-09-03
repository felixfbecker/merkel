
import * as pg from 'pg';

export async function up(): Promise<void> {
    const client = new pg.Client(process.env.MERKEL_DB);
    await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
    await client.query('CREATE TABLE new_table (test VARCHAR)');
}

export async function down(): Promise<void> {
    const client = new pg.Client(process.env.MERKEL_DB);
    await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
    await client.query('DROP TABLE new_table');
}
