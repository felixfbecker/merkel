
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
import {DbAdapter} from './adapter';
import {inflect} from 'inflection';
const pkg = require('../package.json');
require('update-notifier')({ pkg }).notify();

export function getAdapterFromUrl(url: string): DbAdapter {
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
    .wrap(90)
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
    .epilogue('All options can also be passed through env vars, like MERKEL_DB for --db');

yargs.command('add-git-hook', false, {}, async (argv) => {
    const hookPath = path.normalize('.git/hooks/prepare-commit-message');
    const hook = '\n\nmerkel prepare-commit-message $1 $2 $3\n';
    try {
        await fs.access(hookPath);
        await fs.appendFile(hookPath, hook);
        process.stdout.write('\nAppended to ' + chalk.cyan(hookPath));
    } catch (err) {
        await fs.writeFile(hookPath, '#!/usr/bin/env node\n' + hook);
        process.stdout.write('\nCreated ' + chalk.cyan(hookPath));
    }
});

interface PrepareCommitMsgArgv extends Argv {
    msgfile: string;
    source: string;
    sha1: string;
}

yargs.command('prepare-commit-msg <msgfile> <source> <sha1>', false, {}, async (argv: PrepareCommitMsgArgv) => {
    try {
        type CommitSource = 'template' | 'message' | 'commit';
        let msg = await fs.readFile(argv.msgfile, 'utf8');
        msg = await prepareCommitMessage(msg);
        process.exit(0);
    } catch (err) {
        process.stderr.write(chalk.red(err + ''));
        process.exit(1);
    }
});

interface StatusArgv extends Argv {
    db: string;
}

async function getAndShowStatus(adapter: DbAdapter, head: Commit, migrationDir: string): Promise<Commit[]> {
    const lastTask = await adapter.getLastMigrationTask();
    const commits = await getNewCommits(lastTask.head);
    process.stdout.write('\n');
    if (lastTask) {
        await Promise.all([
            lastTask.commit.loadSubject(),
            lastTask.head.loadSubject()
        ]);
        process.stdout.write(`Last migration:      ${lastTask.toString()}\n`);
        process.stdout.write(`Applied at:          ${lastTask.appliedAt}\n`);
        process.stdout.write(`Triggered by commit: ${lastTask.commit.toString()}\n`);
        process.stdout.write(`HEAD at execution:   ${lastTask.commit.toString()}\n`);
    } else {
        process.stdout.write(`Last migration:      No migration run yet\n`);
    }
    if (head) {
        await head.loadSubject();
        process.stdout.write(chalk.grey(`                        ${commits.length === 1 ? '‖' : `↕ ${commits.length - 1} ${inflect('commit', commits.length - 1)}\n`}`));
        process.stdout.write(`Current HEAD:        ${head.toString()}\n`);
    }
    process.stdout.write('\n');
    const relevantCommits = commits.filter(commit => commit.tasks.length > 0);
    if (relevantCommits.length === 0) {
        process.stdout.write('No pending migrations\n');
        process.exit(0);
    }
    const migrationCount = relevantCommits.reduce((prev: number, curr: Commit) => prev + curr.tasks.length, 0);
    process.stdout.write(chalk.underline(`${migrationCount} pending ${inflect('migration', migrationCount)}:\n\n`));
    for (const commit of relevantCommits) {
        process.stdout.write(commit.toString() + '\n');
        for (const task of commit.tasks) {
            if (task.type === 'up') {
                process.stdout.write(task.toString() + '\n');
            } else if (task.type === 'down') {
                process.stdout.write(task.toString() + '\n');
            }
        }
        process.stdout.write(`\n`);
    }
    return relevantCommits;
}

yargs.command(
    'status',
    'Shows the last migration task and new migrations tasks to execute',
    { db: dbOption },
    async (argv: StatusArgv) => {
        try {
            const adapter = getAdapterFromUrl(argv.db);
            await adapter.init();
            const head = await getHead();
            await getAndShowStatus(adapter, head, argv.migrationDir);
            process.stdout.write(`Run ${chalk.white.bold('merkel migrate')} to execute\n`);
            process.exit(0);
        } catch (err) {
            process.stderr.write(chalk.red(err.stack));
            process.exit(1);
        }
    }
);

interface MigrateArgv extends Argv {
    db: string;
    confirm: boolean;
}

yargs.command(
    'migrate',
    'Runs all migration tasks that were embedded in commit messages since the commit of the last migration',
    {
        confirm: {
            type: 'boolean',
            description: 'Ask for confirmation before beginning the actual migration',
            default: (<tty.ReadStream>process.stdin).isTTY,
            defaultDescription: 'true if run in TTY context'
        },
        db: dbOption
    },
    async (argv: MigrateArgv) => {
        try {
            const adapter = getAdapterFromUrl(argv.db);
            await adapter.init();
            const head = await getHead();
            const relevantCommits = await getAndShowStatus(adapter, head, argv.migrationDir);
            if (argv.confirm) {
                const answer = await inquirer.prompt({ type: 'confirm', name: 'continue', message: 'Continue?' });
                if (!answer['continue']) {
                    process.exit(0);
                }
                process.stdout.write('\n');
            }
            process.stdout.write('Starting migration\n\n');
            for (const commit of relevantCommits) {
                process.stdout.write(`${chalk.yellow(commit.shortSha1)} ${commit.subject}\n`);
                for (const task of commit.tasks) {
                    process.stdout.write(task.toString() + '...');
                    const interval = setInterval(() => process.stdout.write('.'), 100);
                    await task.execute(argv.migrationDir, adapter, head, commit);
                    clearInterval(interval);
                    process.stdout.write(' Success\n');
                }
            }
            process.stdout.write(chalk.green('\nAll migrations successful\n'));
            process.exit(0);
        } catch (err) {
            process.stderr.write('\n' + chalk.red(err + ''));
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
            const task = new Task({
                type: 'up',
                migration: new Migration({ name })
            });
            process.stdout.write('Executing' + task.toString() + '...');
            try {
                await task.execute(argv.migrationDir, adapter, head);
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

yargs.command('up <migrations..>', 'Migrates specific migrations up', { db: dbOption }, migrationCommand('up'));

yargs.command('down <migrations..>', 'Migrates specific migrations down', { db: dbOption }, migrationCommand('down'));

interface GenerateArgv extends Argv {
    name?: string;
    template?: string;
}

yargs.command('generate', 'Generates a new migration file', {
    name: {
        alias: 'n',
        nargs: 1,
        description: 'The name of the migration file',
        defaultDescription: 'UUID'
    },
    template: {
        alias: 't',
        nargs: 1,
        description: 'The path to a custom template file that should be used'
    }
}, async (argv: GenerateArgv) => {
    try {
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
        process.stdout.write('\nCreated ' + chalk.cyan(relativePath + path.sep + name + ext) + '\n');
        process.exit(0);
    } catch (err) {
        process.stderr.write(chalk.red(err + ''));
        process.exit(1);
    }
});

yargs.completion('completion');

export default yargs;
