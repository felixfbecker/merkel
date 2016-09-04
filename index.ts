import {TaskType, Task, Migration} from './src/migration';
import {getHead, isRevertCommit, getTasksForNewCommit} from './src/git';
import {DbAdapter} from './src/adapter';
import * as chalk from 'chalk';
import * as fs from 'mz/fs';
import * as path from 'path';
import mkdirp = require('mkdirp');

export interface Logger {
    log(msg: string): void;
    error(msg: string): void;
    warn(msg: string): void;
}

export interface GenerateOptions {
    migrationDir: string;
    name: string;
    template?: string;
}

export interface MerkelConfiguration {
    migrationDir: string;
    migrationOutDir: string;
}

export async function isMerkelRepository(): Promise<boolean> {
    try {
        await fs.access('.merkelrc.json');
        return true;
    } catch (err) {
        return false;
    }
}

export async function createMigrationDir(migrationDir: string) {
    await new Promise((resolve, reject) => mkdirp(migrationDir, (err, made) => err ? reject(err) : resolve(made)));
}

export async function createConfig(config: MerkelConfiguration) {
    await fs.writeFile('.merkelrc.json', JSON.stringify(config, null, 2) + '\n');
}

export async function migrate(type: TaskType, migrationDir: string, adapter: DbAdapter, migrations: string[], logger: Logger) {
    const head = await getHead();
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

export async function prepareCommitMsg(msgfile: string, migrationDir: string, logger: Logger) {
    let msg = await fs.readFile(msgfile, 'utf8');
    // check that migrations have not been deleted by a revert
    if (isRevertCommit(msg)) {
        logger.warn(chalk.bgYellow('WARNING: mirations have been removed by a git revert'));
    }
    // add commands
    const taskList = await getTasksForNewCommit(migrationDir);
    await fs.appendFile(msgfile, taskList.toString(true));
}

export async function generate(options: GenerateOptions, logger: Logger) {
    let template: string;
    let ext: string = '';
    if (options.template) {
        try {
            template = await fs.readFile(options.template, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
            logger.error(chalk.red('\nCould not find template ' + options.template + '\n'));
        }
    } else {
        // detect tsconfig.json
        try {
            const tsconfig = JSON.parse(await fs.readFile('tsconfig.json', 'utf8'));
            const targetLessThanEs6 = tsconfig.compilerOptions && /^es[35]$/i.test(tsconfig.compilerOptions.target);
            ext = '.ts';
            template = [
                '',
                `export ${targetLessThanEs6 ? '' : 'async '}function up(): Promise<void> {`,
                '',
                '}',
                '',
                `export ${targetLessThanEs6 ? '' : 'async '}function down(): Promise<void> {`,
                '',
                '}',
                ''
            ].join('\n');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
            ext = '.js';
            template = [
                '',
                'exports.up = function up() {',
                '',
                '};',
                '',
                'exports.down = function down() {',
                '',
                '};',
                ''
            ].join('\n');
        }
    }
    const file = `${options.migrationDir}/${name}${ext}`;
    const relativePath = path.relative(process.cwd(), options.migrationDir);
    // check if already exists
    try {
        await fs.access(file);
        logger.error(chalk.red('\nError: Migration file ' + relativePath + path.sep + chalk.bold(name) + ext + ' already exists\n'));
        throw new Error('Migration file already existed');
    } catch (err) {
        // continue
    }
    await new Promise((resolve, reject) => mkdirp(options.migrationDir, err => err ? reject(err) : resolve()));
    await fs.writeFile(file, template);
    logger.log('\nCreated ' + chalk.cyan(relativePath + path.sep + name + ext) + '\n');
}
