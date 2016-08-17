
export interface MigrationData {
    /** The git HEAD commit sha1 at the time the migration was run */
    head: string;
    /** The time the migration was run */
    applied: Date;
    /** The name of the migration that was run */
    migration: string;
}

export abstract class DbAdapter {
    abstract connect(): Promise<void>;
    abstract getLastMigration(): Promise<MigrationData>;
    abstract logMigration(name: string): Promise<void>;
}
