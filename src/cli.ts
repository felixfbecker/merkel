
import * as yargs from 'yargs';
import {prepareCommitMessage} from './prepare-commit-message';
import {getAdapterFromUrl} from './db';
import * as fs from 'mz/fs';
import * as chalk from 'chalk';
import {getNewCommits, Commit} from './git';
import * as uuid from 'node-uuid';
import mkdirp = require('mkdirp');
import * as path from 'path';
const pkg = require('../package.json');
require('update-notifier')({ pkg }).notify();

interface Argv extends yargs.Argv {
    migrationDir?: string;
}

interface GenerateArgv extends Argv {
    name?: string;
    template?: string;
}

interface MigrateArgv extends Argv {
    db: string;
}

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
    .version(pkg.version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .epilogue('All options can also be passed through env vars, like MERKEL_DB for --db')
    .completion('completion')
    .command('add-git-hook', false, {}, async (argv) => {
        const hookPath = process.cwd() + '/.git/hooks/prepare-commit-message';
        const hook = '\n\nmerkel prepare-commit-message $1 $2 $3\n';
        try {
            await fs.access(hookPath);
        } catch (err) {
            await fs.writeFile(hookPath, '#!/usr/bin/env node\n');
        }
        await fs.appendFile(hookPath, hook);
    })
    .command('prepare-commit-msg <msgfile> <source> <sha1>', false, {}, async (argv) => {
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
    })
    .command('migrate', [
        'Runs all migration files that have been added since the last migration, in the order they were added to the ',
        'repository. It will query the database to get the last-run migration. Then it will ask git which migration ',
        'files were added since the last migration, and in what order. For every commit, it also gets the commit ',
        'message. By default, it will run all added up migrations. If the commit message contains merkel commands in ',
        'angled brackets, it will parse and execute those instead.'
    ].join(''), {
        confirm: {
            type: 'boolean',
            description: 'Ask for confirmation before beginning the actual migration'
        },
        db: {
            description: 'The connection URL for the database',
            nargs: 1,
            require: true
        }
    }, async (argv: MigrateArgv) => {
        const adapter = getAdapterFromUrl(argv.db);
        await adapter.connect();
        const lastMigration = await adapter.getLastMigration();
        const commits = await getNewCommits(argv.migrationDir, lastMigration.head);
        const relevantCommits = commits.filter(commit => commit.migrations.length > 0);
        const migrationCount = relevantCommits.reduce((prev: number, curr: Commit) => prev + curr.migrations.length, relevantCommits[0].migrations.length);
        process.stdout.write(chalk.white.bold.underline(`${migrationCount} new migrations:\n`));
        for (const {sha1, message, migrations} of relevantCommits) {
            process.stdout.write(`${chalk.yellow(sha1.substring(0, 6))} ${message.split('\n', 1)[0]}\n`);
            for (const migration of migrations) {
                if (migration.type === 'up') {
                    process.stdout.write(`${chalk.bgGreen('▲')} ${migration.name}\n`);
                } else if (migration.type === 'down') {
                    process.stdout.write(`${chalk.bgRed('▼')} ${migration.name}\n`);
                } else {
                    process.stderr.write(`Unknown command ${migration.name}`);
                }
            }
            process.stdout.write(`\n`);
        }
        process.stdout.write('\n\n');
    })
    .command('generate', 'Generates a new migration file', {
        name: {
            alias: 'n',
            nargs: 1
        },
        template: {
            alias: 't',
            nargs: 1
        }
    }, async (argv: GenerateArgv) => {
        const name = argv.name || uuid.v4();
        const migrationDir = path.resolve(argv.migrationDir);
        let migrationFilePath = migrationDir + '/' + name;
        let template: string = argv.template;
        if (!template) {

            // detect tsconfig.json
            try {
                const tsconfig = JSON.parse(await fs.readFile('tsconfig.json', 'utf8'));
                const targetLessThanEs6 = tsconfig.compilerOptions && /^es[35]$/i.test(tsconfig.compilerOptions.target);
                migrationFilePath += '.ts';
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
                migrationFilePath += '.js';
                template = [
                    '',
                    'export.up = function up() {',
                    '',
                    '}',
                    '',
                    'exports.down = function down() {',
                    '',
                    '}',
                    ''
                ].join('\n');
            }
        }
        await new Promise((resolve, reject) => mkdirp(migrationDir, err => err ? reject(err) : resolve()));
        await fs.writeFile(migrationFilePath, template);
        process.stdout.write(`\nCreated ${migrationDir}${chalk.white(name)}`);
    })
    .parse(process.argv);
