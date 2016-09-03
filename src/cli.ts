
import * as yargs from 'yargs';
import * as fs from 'mz/fs';
import * as chalk from 'chalk';
import {getNewCommits, Commit, getHead, getTasksForNewCommit, isRevertCommit} from './git';
import {TaskType} from './migration';
import {migrate, generate} from '../index';
import * as uuid from 'node-uuid';
import mkdirp = require('mkdirp');
import * as path from 'path';
import * as tty from 'tty';
import * as inquirer from 'inquirer';
import {DbAdapter} from './adapter';
import {addGitHook, HookAlreadyFoundError} from './git';
const pkg = require('../package.json');
require('update-notifier')({ pkg }).notify();

interface Config {
    migrationDir?: string;
    migrationOutDir?: string;
}

interface Argv extends yargs.Argv, Config { }

const dbOption = {
    description: 'The connection URL for the database',
    nargs: 1,
    require: true
};

yargs
    .env('MERKEL')
    .option('config', { config: true, default: '.merkelrc.json' })
    .demand(1)
    .usage('\nUsage: merkel [options] <command>')
    .wrap(90)
    .option('migration-dir', {
        description: 'The directory for migration files',
        nargs: 1,
        global: true,
        default: './migrations'
    })
    .option('migration-out-dir', {
        description: 'The output directory for migration files (when using a transpiler)',
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

interface InitArgv extends Argv {
    db?: string;
}

yargs.command(
    'init',
    'Initializes merkel configuration interactively',
    { db: Object.assign(dbOption, { required: false }) },
    async (argv: InitArgv) => {
        try {
            process.stdout.write('\n');
            try {
                await fs.access('.merkelrc.json');
                process.stderr.write('.merkelrc.json already exists\n');
                process.exit(1);
            } catch (err) {
                // continue
            }
            const config: Config = {};
            // try to read tsconfig
            let tsconfig: any;
            try {
                tsconfig = JSON.parse(await fs.readFile('tsconfig.json', 'utf8'));
            } catch (err) {
                // ignore
            }
            const {migrationDir, migrationOutDir, shouldAddGitHook, initMetaNow} = await inquirer.prompt([
                {
                    name: 'migrationDir',
                    message: tsconfig ? 'Directory for new migration files:' : 'Directory for migration files:',
                    default: (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.rootDir + path.sep + 'migrations') || './migrations'
                },
                {
                    name: 'migrationOutDir',
                    message: 'Directory for compiled migration files:',
                    default: (tsconfig && tsconfig.compilerOptions && tsconfig.compilerOptions.outDir + path.sep + 'migrations') || './migrations',
                    when: () => !!tsconfig
                },
                {
                    name: 'shouldAddGitHook',
                    type: 'confirm',
                    message: 'Add a git hook that adds commands to your commit messages (you can still edit them)?'
                },
                {
                    name: 'initMetaNow',
                    type: 'confirm',
                    message: 'Initialize merkel metadata table now (otherwise done automatically later)?',
                    when: () => !!argv.db
                }
            ]);
            // create migration dir
            const made = await new Promise((resolve, reject) => mkdirp(<string>migrationDir, (err, made) => err ? reject(err) : resolve(made)));
            if (made) {
                process.stdout.write(`Created ${chalk.cyan(<string>migrationDir)}\n`);
            }
            // create config file
            config.migrationDir = <string>migrationDir;
            config.migrationOutDir = <string>migrationOutDir;
            await fs.writeFile('.merkelrc.json', JSON.stringify(config, null, 2) + '\n');
            process.stdout.write(`Created ${chalk.cyan(path.join('.', '.merkelrc.json'))}\n`);
            // init database
            if (initMetaNow) {
                await DbAdapter.getFromUrl(argv.db).init();
            }
            // add git hook
            if (shouldAddGitHook) {
                try {
                    const [type, hookPath] = await addGitHook();
                    switch (type) {
                        case 'appended':
                            process.stdout.write(`Appended hook to ${chalk.cyan(hookPath)}\n`);
                            break;
                        case 'created':
                            process.stdout.write(`Created ${chalk.cyan(hookPath)}\n`);
                    }
                } catch (err) {
                    if (err instanceof HookAlreadyFoundError) {
                        process.stdout.write('Hook already found\n');
                        process.exit(0);
                    } else {
                        throw err;
                    }
                }
            }
            process.exit(0);
        } catch (err) {
            process.stdout.write(chalk.red(err.stack));
            process.exit(1);
        }
    }
);

yargs.command(
    'add-git-hook',
    'Adds a prepare-commit-msg hook to git that automatically adds merkel commands to your commit messages',
    {},
    async () => {
        try {
            process.stdout.write('\n');
            const [type, hookPath] = await addGitHook();
            switch (type) {
                case 'appended':
                    process.stdout.write(`Appended hook to ${chalk.cyan(hookPath)}\n`);
                    break;
                case 'created':
                    process.stdout.write(`Created ${chalk.cyan(hookPath)}\n`);
            }
            process.exit(0);
        } catch (err) {
            if (err instanceof HookAlreadyFoundError) {
                process.stdout.write(chalk.red('Hook already found\n'));
                process.exit(0);
                return;
            }
            process.stderr.write(chalk.red(err.stack));
            process.exit(1);
        }
    }
);

type CommitSource = 'template' | 'message' | 'merge' | 'squash' | 'commit';
interface PrepareCommitMsgArgv extends Argv {
    msgfile: string;
    /**
     * source of the commit message, and can be:
     *  - message (if a -m or -F option was given)
     *  - template (if a -t option was given or the configuration option commit.template is set)
     *  - merge (if the commit is a merge or a .git/MERGE_MSG file exists)
     *  - squash (if a .git/SQUASH_MSG file exists)
     *  - commit, followed by a commit SHA-1 (if a -c, -C or --amend option was given).
     */
    source?: CommitSource;
    sha1?: string;
}

yargs.command(
    'prepare-commit-msg <msgfile> [source] [sha1]',
    false,
    {
        migrationDir: {
            required: true
        }
    },
    async (argv: PrepareCommitMsgArgv) => {
        try {
            let msg = await fs.readFile(argv.msgfile, 'utf8');
            // check that migrations have not been deleted by a revert
            if (isRevertCommit(msg)) {
                process.stderr.write(chalk.bgYellow('WARNING: mirations have been removed by a git revert'));
            }
            // add commands
            const taskList = await getTasksForNewCommit(argv.migrationDir);
            msg += taskList.toString(true);
            process.exit(0);
        } catch (err) {
            process.stderr.write(chalk.red(err.stack));
            process.exit(1);
        }
    }
);

interface StatusArgv extends Argv {
    db: string;
}

async function getAndShowStatus(adapter: DbAdapter, head: Commit, migrationDir: string): Promise<Commit[]> {
    const lastTask = await adapter.getLastMigrationTask();
    const commits = await getNewCommits(lastTask.head);
    process.stdout.write('\n');
    if (lastTask) {
        await Promise.all([lastTask.commit, lastTask.head].map(async (commit) => {
            try {
                await commit.loadSubject();
            } catch (err) {
                if (err.code !== 128) {
                    throw err;
                }
            }
        }));
        process.stdout.write(`Last migration:      ${lastTask.toString()}\n`);
        process.stdout.write(`Applied at:          ${lastTask.appliedAt}\n`);
        process.stdout.write(`Triggered by commit: ${lastTask.commit.toString()}\n`);
        process.stdout.write(`HEAD at execution:   ${lastTask.commit.toString()}\n`);
    } else {
        process.stdout.write(`Last migration:      No migration run yet\n`);
    }
    if (head) {
        await head.loadSubject();
        process.stdout.write(chalk.grey(`                        ${commits.length === 1 ? '‖' : `${commits.isReversed ? '↑' : '↓'} ${commits.length - 1} commit${commits.length > 2 ? 's' : ''}\n`}`));
        process.stdout.write(`Current HEAD:        ${head.toString()}\n`);
    }
    process.stdout.write('\n');
    const relevantCommits = commits.filter(commit => commit.tasks.length > 0);
    if (relevantCommits.length === 0) {
        process.stdout.write('No pending migrations\n');
        process.exit(0);
    }
    const migrationCount = relevantCommits.reduce((prev: number, curr: Commit) => prev + curr.tasks.length, 0);
    process.stdout.write(chalk.underline(`${migrationCount} pending migration${migrationCount > 1 ? 's' : ''}:\n\n`));
    for (const commit of relevantCommits) {
        process.stdout.write(commit.toString() + '\n');
        for (const task of commit.tasks) {
            process.stdout.write((commits.isReversed ? task.invert() : task).toString() + '\n');
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
            const adapter = DbAdapter.getFromUrl(argv.db);
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
            const adapter = DbAdapter.getFromUrl(argv.db);
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
                    await task.execute(argv.migrationOutDir, adapter, head, commit);
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

function migrationCommand(type: TaskType) {
    return async (argv: MigrationCommandArgv) => {
        try {
            migrate(type, argv.migrationOutDir, argv.db, argv.migrations, {
                log: process.stdout.write,
                error: process.stderr.write
            });
        } catch (err) {
            process.stderr.write(chalk.red('\nError: ' + err.stack));
            process.exit(1);
        }
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
        const name = argv.name || uuid.v1();
        const migrationDir = path.resolve(argv.migrationDir);
        generate({name: name, migrationDir: migrationDir, template: argv.template},
        {log: process.stdout.write, error: process.stderr.write});
        process.exit(0);
    } catch (err) {
        process.stderr.write(chalk.red(err.stack));
        process.exit(1);
    }
});

yargs.completion('completion');

export default yargs;
