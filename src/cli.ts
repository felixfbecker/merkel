import chalk from 'chalk'
import * as inquirer from 'inquirer'
import * as fs from 'mz/fs'
import * as path from 'path'
import * as tty from 'tty'
import * as yargs from 'yargs'
import { createAdapterFromUrl } from './adapter'
import { getHead } from './git'
import { addGitHook, HookAlreadyFoundError } from './git'
import {
    CLI_LOGGER,
    createConfig,
    createMigrationDir,
    generate,
    getConfigurationForCommit,
    getStatus,
    isMerkelRepository,
    PendingMigrationFoundError,
    prepareCommitMsg,
} from './index'
import { Migration, Task, TaskType } from './migration'

const pkg = require('../package.json')
require('update-notifier')({ pkg }).notify()

export class MigrationDirNotSpecifiedError extends Error {
    public name = 'MigrationDirNotSpecifiedError'
}

interface Config {
    migrationDir?: string
    migrationOutDir?: string
}

interface Argv extends yargs.Arguments, Config {}

const dbOption: yargs.Options = {
    description: 'The connection URL for the database',
    nargs: 1,
    require: true,
}

yargs
    .env('MERKEL')
    .option('config', {
        alias: 'c',
        global: true,
        config: true,
        default: '.merkelrc.json',
    })
    .demand(1)
    .usage('\nUsage: merkel [options] <command>')
    .wrap(90)
    .option('migration-dir', {
        description: 'The directory for migration files',
        nargs: 1,
        global: true,
        default: './migrations',
    })
    .option('migration-out-dir', {
        description: 'The output directory for migration files (when using a transpiler)',
        nargs: 1,
        global: true,
        default: './migrations',
    })
    .option('no-color', { desc: 'Disable colored output', global: true })
    .option('color', {
        desc: 'Force colored output even if color support was not detected',
        global: true,
    })
    .version(pkg.version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .epilogue('All options can also be passed through env vars, like MERKEL_DB for --db')

interface InitArgv extends Argv {
    db?: string
}

yargs.command(
    'init',
    'Initializes merkel configuration interactively',
    { db: Object.assign({}, dbOption, { require: false }) },
    async (argv: InitArgv) => {
        try {
            process.stdout.write('\n')
            if (await isMerkelRepository()) {
                process.stderr.write('.merkelrc.json already exists\n')
                process.exit(1)
            }
            // try to read tsconfig
            let tsconfig: any
            try {
                tsconfig = JSON.parse(await fs.readFile('tsconfig.json', 'utf8'))
            } catch (err) {
                // ignore
            }
            const { migrationDir, migrationOutDir, shouldAddGitHook, initMetaNow } = await inquirer.prompt<{
                migrationDir: string
                migrationOutDir: string
                shouldAddGitHook: boolean
                initMetaNow: boolean
            }>([
                {
                    name: 'migrationDir',
                    message: tsconfig ? 'Directory for new migration files:' : 'Directory for migration files:',
                    default:
                        (tsconfig &&
                            tsconfig.compilerOptions &&
                            tsconfig.compilerOptions.rootDir &&
                            tsconfig.compilerOptions.rootDir + path.sep + 'migrations') ||
                        './migrations',
                },
                {
                    name: 'migrationOutDir',
                    message: 'Directory for compiled migration files:',
                    default:
                        (tsconfig &&
                            tsconfig.compilerOptions &&
                            tsconfig.compilerOptions.outDir &&
                            tsconfig.compilerOptions.outDir + path.sep + 'migrations') ||
                        './migrations',
                    when: () => !!tsconfig,
                },
                {
                    name: 'shouldAddGitHook',
                    type: 'confirm',
                    message: 'Add a git hook that adds commands to your commit messages (you can still edit them)?',
                },
                {
                    name: 'initMetaNow',
                    type: 'confirm',
                    message: 'Initialize merkel metadata table now (otherwise done automatically later)?',
                    when: () => !!argv.db,
                },
            ])
            if (await createMigrationDir(migrationDir)) {
                process.stdout.write(`Created ${chalk.cyan(migrationDir)}\n`)
            }
            await createConfig({
                migrationDir,
                migrationOutDir: migrationOutDir || './migrations',
            })
            process.stdout.write(`Created ${chalk.cyan(path.join('.', '.merkelrc.json'))}\n`)
            if (initMetaNow) {
                await createAdapterFromUrl(argv.db!).init()
            }
            // add git hook
            if (shouldAddGitHook) {
                try {
                    const [type, hookPath] = await addGitHook()
                    switch (type) {
                        case 'appended':
                            process.stdout.write(`Appended hook to ${chalk.cyan(hookPath)}\n`)
                            break
                        case 'created':
                            process.stdout.write(`Created ${chalk.cyan(hookPath)}\n`)
                    }
                } catch (err) {
                    if (err instanceof HookAlreadyFoundError) {
                        process.stdout.write('Hook already found\n')
                        process.exit(0)
                    } else {
                        throw err
                    }
                }
            }
            process.exit(0)
        } catch (err) {
            process.stdout.write(chalk.red(err.stack))
            process.exit(1)
        }
    }
)

yargs.command(
    'add-git-hook',
    'Adds a prepare-commit-msg hook to git that automatically adds merkel commands to your commit messages',
    {},
    async () => {
        try {
            process.stdout.write('\n')
            const [type, hookPath] = await addGitHook()
            switch (type) {
                case 'appended':
                    process.stdout.write(`Appended hook to ${chalk.cyan(hookPath)}\n`)
                    break
                case 'created':
                    process.stdout.write(`Created ${chalk.cyan(hookPath)}\n`)
            }
            process.exit(0)
        } catch (err) {
            if (err instanceof HookAlreadyFoundError) {
                process.stdout.write(chalk.red('Hook already found\n'))
                process.exit(0)
                return
            }
            process.stderr.write(chalk.red(err.stack))
            process.exit(1)
        }
    }
)

type CommitSource = 'template' | 'message' | 'merge' | 'squash' | 'commit'
interface PrepareCommitMsgArgv extends Argv {
    msgfile?: string
    /**
     * source of the commit message, and can be:
     *  - message (if a -m or -F option was given)
     *  - template (if a -t option was given or the configuration option commit.template is set)
     *  - merge (if the commit is a merge or a .git/MERGE_MSG file exists)
     *  - squash (if a .git/SQUASH_MSG file exists)
     *  - commit, followed by a commit SHA-1 (if a -c, -C or --amend option was given).
     */
    source?: CommitSource
    sha1?: string
}

yargs.command(
    'prepare-commit-msg <msgfile> [source] [sha1]',
    false,
    {
        migrationDir: {
            demandOption: true,
        },
    },
    async (argv: PrepareCommitMsgArgv) => {
        try {
            if (argv.source !== 'message') {
                await prepareCommitMsg(argv.msgfile!, argv.migrationDir!)
            }
            process.exit(0)
        } catch (err) {
            process.stderr.write(chalk.red(err.stack))
            process.exit(1)
        }
    }
)

interface StatusArgv extends Argv {
    db?: string
}

yargs.command(
    'status',
    'Shows the last migration task and new migrations tasks to execute',
    { db: dbOption },
    async (argv: StatusArgv) => {
        try {
            const adapter = createAdapterFromUrl(argv.db!)
            await adapter.init()
            const head = await getHead()
            // wait for current migration to finish
            await adapter.waitForPending(CLI_LOGGER)
            const status = await getStatus(adapter, head)
            process.stdout.write('\n' + status.toString())
            if (status.newCommits.some(commit => commit.tasks.length > 0)) {
                process.stdout.write(`Run ${chalk.white.bold('merkel migrate')} to execute\n`)
            }
            process.exit(0)
        } catch (err) {
            process.stderr.write(chalk.red(err.stack))
            process.exit(1)
        }
    }
)

interface MigrateArgv extends Argv {
    db?: string
    confirm?: boolean
}

yargs.command(
    'migrate',
    'Runs all migration tasks that were embedded in commit messages since the commit of the last migration',
    {
        confirm: {
            type: 'boolean',
            description: 'Ask for confirmation before beginning the actual migration',
            default: (process.stdin as tty.ReadStream).isTTY,
            defaultDescription: 'true if run in TTY context',
        },
        db: dbOption,
    },
    async (argv: MigrateArgv) => {
        try {
            const adapter = createAdapterFromUrl(argv.db!)
            await adapter.init()
            while (true) {
                const head = await getHead()
                const status = await getStatus(adapter, head)
                process.stdout.write(status.toString())
                const tasks = status.newCommits.reduce<Task[]>((prev, next) => prev.concat(next.tasks), [])
                if (tasks.length > 0) {
                    if (argv.confirm) {
                        const answer = await inquirer.prompt<{ continue: boolean }>({
                            type: 'confirm',
                            name: 'continue',
                            message: 'Continue?',
                        })
                        if (!answer.continue) {
                            process.exit(0)
                        }
                        process.stdout.write('\n')
                    }

                    process.stdout.write('Starting migration\n\n')

                    const hasChanged = await adapter.waitForPending(CLI_LOGGER)

                    if (hasChanged) {
                        process.stdout.write('The migrations have changed, reloading..\n\n')
                        continue
                    }
                    // create pending tasks
                    for (const task of tasks) {
                        try {
                            task.head = head
                            await adapter.beginMigrationTask(task)
                        } catch (error) {
                            if (error instanceof PendingMigrationFoundError) {
                                continue
                            } else {
                                throw error
                            }
                        }
                    }

                    for (const commit of status.newCommits) {
                        process.stdout.write(`${chalk.yellow(commit.shortSha1)} ${commit.subject}\n`)
                        for (const task of commit.tasks) {
                            process.stdout.write(task.toString() + ' ...')
                            const interval = setInterval(() => process.stdout.write('.'), 100)
                            try {
                                await task.execute(argv.migrationOutDir!, adapter, head, commit)
                            } finally {
                                clearInterval(interval)
                            }
                            process.stdout.write(' Success\n')
                        }
                    }
                    process.stdout.write(chalk.green('\nAll migrations successful\n'))
                }
                break
            }
            process.exit(0)
        } catch (err) {
            process.stderr.write('\n' + chalk.red(err.stack))
            process.exit(1)
        }
    }
)

interface MigrationCommandArgv extends Argv {
    migrations?: string[]
    db?: string
}

const migrationCommand = (type: TaskType) => async (argv: MigrationCommandArgv) => {
    try {
        const adapter = createAdapterFromUrl(argv.db!)
        await adapter.init()
        const tasks = argv.migrations!.map(name => new Task({ type, migration: new Migration(name) }))
        while (true) {
            await adapter.waitForPending(CLI_LOGGER)
            const head = await getHead()
            for (const task of tasks) {
                try {
                    task.head = head
                    await adapter.beginMigrationTask(task)
                } catch (error) {
                    if (error instanceof PendingMigrationFoundError) {
                        continue
                    } else {
                        throw error
                    }
                }
            }
            break
        }
        for (const task of tasks) {
            process.stdout.write(`${task.toString()} ...`)
            const interval = setInterval(() => process.stdout.write('.'), 100)
            try {
                await task.execute(argv.migrationOutDir!, adapter)
            } finally {
                clearInterval(interval)
            }
            process.stdout.write(' Success\n')
        }
        process.stdout.write('\n' + chalk.green.bold('Migration successful') + '\n')
    } catch (err) {
        process.stderr.write('\n' + chalk.red(err.stack))
        process.exit(1)
    }
    process.exit(0)
}

yargs.command('up <migrations..>', 'Migrates specific migrations up', { db: dbOption }, migrationCommand('up'))

yargs.command('down <migrations..>', 'Migrates specific migrations down', { db: dbOption }, migrationCommand('down'))

interface GenerateArgv extends Argv {
    name?: string
    template?: string
}

yargs.command(
    'generate',
    'Generates a new migration file',
    {
        name: {
            alias: 'n',
            nargs: 1,
            description: 'The name of the migration file',
            defaultDescription: 'UUID',
        },
        template: {
            alias: 't',
            nargs: 1,
            description: 'The path to a custom template file that should be used',
        },
    },
    async (argv: GenerateArgv) => {
        try {
            let migrationDir: string | undefined
            if (argv.migrationDir) {
                migrationDir = path.resolve(argv.migrationDir)
            } else {
                const configuration = await getConfigurationForCommit(await getHead())
                if (configuration) {
                    migrationDir = configuration.migrationDir
                }
            }
            if (!migrationDir) {
                throw new MigrationDirNotSpecifiedError()
            }
            await generate({
                name: argv.name,
                migrationDir,
                template: argv.template,
            })
            process.exit(0)
        } catch (err) {
            process.stderr.write(chalk.red(err.stack))
            process.exit(1)
        }
    }
)

yargs.completion('completion')

export default yargs
