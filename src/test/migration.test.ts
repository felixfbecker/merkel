import * as assert from 'assert';
import * as fs from 'mz/fs';
import * as path from 'path';
import {Migration, MigrationNotFoundError, Task, TaskList, TaskType} from '../migration';

describe('migration', () => {
    describe('Migration', () => {
        it('should calculate the right path', async () => {
            await fs.appendFile(path.join('migrations', 'test.js'), 'up');
            const migration = new Migration({name: 'test'});
            assert.equal(await migration.getPath('migrations'), path.resolve(path.join(process.cwd(), 'migrations/test.js')));
        });
        it('should throw MigrationNotFoundError for not found migrations', async () => {
            const migration = new Migration();
            try {
                await migration.getPath('migrations');
            } catch (err) {
                if (!(err instanceof MigrationNotFoundError)) {
                    throw err;
                }
            }
        });
    });
    describe('TaskList', () => {
        it('should create the merkel syntax for git commit messages', async () => {

        });
    });
});
