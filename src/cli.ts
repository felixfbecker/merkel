
import * as yargs from 'yargs';
import {prepareCommitMessage} from './prepare-commit-message';
import * as fs from 'mz/fs';
import * as chalk from 'chalk';
import {getNewCommits, Commit, getHead} from './git';
import {Migration, Task, MigrationType} from './migration';
import * as uuid from 'node-uuid';
import mkdirp = require('mkdirp');
import * as path from 'path';
import * as tty from 'tty';
import * as inquirer from 'inquirer';
import {parse} from 'url';
import {PostgresAdapter} from './adapters/postgres';
const pkg = require('../package.json');
require('update-notifier')({ pkg }).notify();


export function getAdapterFromUrl(url: string) {
    const dialect = parse(url).protocol;
    switch (dialect) {
        case 'postgres:': return new PostgresAdapter(url, require(process.cwd() + '/node_modules/pg'));
        case null: throw new Error('Invalid connection URL ' + url);
        default: throw new Error('Unssuported dialect ' + dialect);
    }
}

interface Argv extends yargs.Argv {
    migrationDir?: string;
}

const dbOption = {
    description: 'The connection URL for the database',
    nargs: 1,
    require: true
};

yargs
    .env('MERKEL')
    .demand(1)
    .usage('\nUsage: merkel [options] <command>')
    .option('migration-dir', {
        description: 'The directory for migration files',
        nargs: 1,
        global: true,
        default: './migrations'
    })
    .option('no-color', { desc: 'Disable colored output', global: true })
    .option('color', { desc: 'Force colored output even if color support was not detected', global: true })
    .version(pkg.version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .epilogue('All options can also be passed through env vars, like MERKEL_DB for --db')
    .completion('completion');

yargs.command('add-git-hook', false, {}, async (argv) => {
    const hookPath = process.cwd() + '/.git/hooks/prepare-commit-message';
    const hook = '\n\nmerkel prepare-commit-message $1 $2 $3\n';
    try {
        await fs.access(hookPath);
        await fs.appendFile(hookPath, hook);
    } catch (err) {
        await fs.writeFile(hookPath, '#!/usr/bin/env node\n' + hook);
    }
});

yargs.command('prepare-commit-msg <msgfile> <source> <sha1>', false, {}, async (argv) => {
    try {
        type CommitSource = 'template' | 'message' | 'commit';
        type PrepareCommitMsgParams = [string, CommitSource, string | void];
        if (!process.env.GIT_PARAMS) {
            throw new Error('Environment variable GIT_PARAMS was not set');
        }
        const [msgFile, source, sha1]: PrepareCommitMsgParams = process.env.GIT_PARAMS;
        let msg = await fs.readFile(msgFile, 'utf8');
        msg = await prepareCommitMessage(msg);
        process.exit(0);
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
});

interface MigrateArgv extends Argv {
    db: string;
    confirm?: boolean;
}

yargs.command('migrate', [
    'Runs all migration files that have been added since the last migration, in the order they were added to the ',
    'repository. It will query the database to get the last-run migration. Then it will ask git which migration ',
    'files were added since the last migration, and in what order. For every commit, it also gets the commit ',
    'message. By default, it will run all added up migrations. If the commit message contains merkel commands in ',
    'angled brackets, it will parse and execute those instead.'
].join(''), {
        confirm: {
            type: 'boolean',
            description: 'Ask for confirmation before beginning the actual migration',
            default: (<tty.ReadStream>process.stdin).isTTY,
            defaultDescription: 'true if run in TTY context'
        },
        db: dbOption
    }, async (argv: MigrateArgv) => {
        try {
            const adapter = getAdapterFromUrl(argv.db);
            await adapter.init();
            const head = await getHead();
            const lastTask = await adapter.getLastMigrationTask();
            process.stdout.write('\n');
            if (lastTask) {
                process.stdout.write(`Last migration:      ${lastTask.toString()}\n`);
                process.stdout.write(`Triggered by commit: ${lastTask.commit.sha1}\n`);
                process.stdout.write(`Applied at:          ${lastTask.appliedAt}\n`);
                process.stdout.write(`HEAD at execution:   ${lastTask.head.sha1}\n`);
            } else {
                process.stdout.write('No migrations run yet\n');
            }
            process.stdout.write(`\nCurrent HEAD is ${head}\n\n`);
            const commits = await getNewCommits(argv.migrationDir, lastTask && lastTask.head);
            const relevantCommits = commits.filter(commit => commit.tasks.length > 0);
            if (relevantCommits.length === 0) {
                process.stdout.write('No new migrations\n');
                process.exit(0);
            }
            const migrationCount = relevantCommits.reduce((prev: number, curr: Commit) => {
                return prev + curr.tasks.length;
            }, relevantCommits[0].tasks.length);
            process.stdout.write(chalk.white.bold.underline(`${migrationCount} new migrations:\n\n`));
            for (const {sha1, message, tasks} of relevantCommits) {
                process.stdout.write(`${chalk.yellow(sha1.substring(0, 6))} ${message.split('\n', 1)[0]}\n`);
                for (const task of tasks) {
                    if (task.type === 'up') {
                        process.stdout.write(`${task.toString()}\n`);
                    } else if (task.type === 'down') {
                        process.stdout.write(`${task.toString()}\n`);
                    }
                }
                process.stdout.write(`\n`);
            }
            if (argv.confirm) {
                const answer = await inquirer.prompt({ type: 'confirm', name: 'continue', message: 'Continue?' });
                if (!answer['continue']) {
                    process.exit(0);
                }
                process.stdout.write('\n');
            }
            process.stdout.write('Starting migration\n\n');
            for (const {tasks, sha1, message} of relevantCommits) {
                process.stdout.write(`${chalk.yellow(sha1.substring(0, 6))} ${message.split('\n', 1)[0]}\n`);
                for (const task of tasks) {
                    process.stdout.write(task.toString() + '...');
                    const interval = setInterval(() => process.stdout.write('.'), 100);
                    await task.execute(adapter, head);
                    clearInterval(interval);
                    process.stdout.write(' Success\n');
                }
            }
            process.stdout.write(chalk.green('\nAll migrations successful\n'));
            process.exit(0);
        } catch (err) {
            process.stderr.write('\n' + chalk.red(err.stack));
            process.exit(1);
        }
    });

interface MigrationCommandArgv extends Argv {
    migrations: string[];
    db: string;
}

function migrationCommand(type: MigrationType) {
    return async (argv: MigrationCommandArgv) => {
        const head = await getHead();
        const adapter = getAdapterFromUrl(argv.db);
        await adapter.init();
        for (const name of argv.migrations) {
            const task = new Task('up', new Migration(name, argv.migrationDir));
            process.stdout.write('Executing' + task.toString() + '...');
            try {
                await task.execute(adapter, head);
                process.stdout.write(' Success\n');
            } catch (err) {
                process.stderr.write(chalk.red('\nError: ' + err.stack));
                process.exit(1);
            }
        }
        process.stdout.write('\n' + chalk.green.bold('Migration successful') + '\n');
        process.exit(0);
    };
}

yargs
    .command('up <migrations..>', 'Migrates specific migrations up', { db: dbOption }, migrationCommand('up'))
    .example('up', 'merkel up 07fe5100-ee49-4a7e-a494-1f4b66d5c256 d1e9ced2-1485-4a32-95c6-a50785b0ae71');

yargs
    .command('down <migrations..>', 'Migrates specific migrations down', { db: dbOption }, migrationCommand('down'))
    .example('down', 'merkel down 07fe5100-ee49-4a7e-a494-1f4b66d5c256 d1e9ced2-1485-4a32-95c6-a50785b0ae71');

interface GenerateArgv extends Argv {
    name?: string;
    template?: string;
}

yargs.command('generate', 'Generates a new migration file', {
    name: {
        alias: 'n',
        nargs: 1,
        description: 'The name of the migration file'
    },
    template: {
        alias: 't',
        nargs: 1,
        description: 'The path to a custom template file that should be used'
    }
}, async (argv: GenerateArgv) => {
    const name = argv.name || uuid.v4();
    const migrationDir = path.resolve(argv.migrationDir);
    let template: string;
    let ext: string = '';
    if (argv.template) {
        try {
            template = await fs.readFile(argv.template, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
            process.stderr.write(chalk.red('\nCould not find template ' + argv.template + '\n'));
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
    const file = `${migrationDir}/${name}${ext}`;
    const relativePath = path.relative(process.cwd(), migrationDir);
    // check if already exists
    try {
        await fs.access(file);
        process.stderr.write(chalk.red('\nError: Migration file ' + relativePath + path.sep + chalk.bold(name) + ext + ' already exists\n'));
        process.exit(1);
    } catch (err) {
        // continue
    }
    await new Promise((resolve, reject) => mkdirp(migrationDir, err => err ? reject(err) : resolve()));
    await fs.writeFile(file, template);
    process.stdout.write('\nCreated ' + relativePath + path.sep + chalk.bold.cyan(name) + ext + '\n');
    process.exit(1);
});

export default yargs;
