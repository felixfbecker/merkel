import chalk from 'chalk'
import mkdirp = require('mkdirp')
import * as fs from 'mz/fs'
import * as path from 'path'
import uuidv1 = require('uuid/v1')
import { DbAdapter } from './adapter'
import { Commit, CommitSequence, getNewCommits } from './git'
import { getHead, getTasksForNewCommit, isRevertCommit } from './git'
import { Task } from './migration'

export * from './git'
export * from './migration'
export * from './adapter'
export * from './adapters/postgres'

/* istanbul ignore next */
export const CLI_LOGGER: Logger = {
    log: (log: string) => process.stdout.write(log),
    error: (log: string) => process.stderr.write(log),
    warn: (log: string) => process.stderr.write(log),
}

/* istanbul ignore next */
export const SILENT_LOGGER: Logger = {
    log: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
}

export class TemplateNotFoundError extends Error {
    constructor(templateDir: string) {
        super('Could not find template ' + templateDir)
    }
}

export class Status {
    /** The current HEAD commit of the repository */
    public head: Commit
    /** New commits since the last migration */
    public newCommits: CommitSequence
    /** The last migration task that was executed, according to the merkel metadata table */
    public lastTask: Task | null = null

    constructor(options: { head: Commit; newCommits: CommitSequence; lastTask: Task | null }) {
        this.head = options.head
        this.newCommits = options.newCommits
        this.lastTask = options.lastTask
    }

    /** Executes all tasks for newCommits */
    public async executePendingTasks(
        migrationDir: string,
        adapter: DbAdapter,
        logger: Logger = CLI_LOGGER
    ): Promise<void> {
        while (true) {
            logger.log(this.toString())
            const tasks = this.newCommits.reduce<Task[]>((prev, next) => prev.concat(next.tasks), [])
            if (tasks.length > 0) {
                logger.log('Starting migration\n\n')

                const hasChanged = await adapter.waitForPending(logger)

                if (hasChanged) {
                    logger.log('The pending migrations have changed, reloading..\n\n')
                    continue
                }
                // create pending tasks
                for (const task of tasks) {
                    task.head = this.head
                    await adapter.beginMigrationTask(task)
                }

                for (const commit of this.newCommits) {
                    logger.log(`${chalk.yellow.bold(commit.shortSha1)} ${commit.subject}\n`)
                    for (const task of commit.tasks) {
                        logger.log(task.toString() + ' ...')
                        const interval = setInterval(() => logger.log('.'), 100)
                        try {
                            await task.execute(migrationDir, adapter, this.head, commit)
                        } finally {
                            clearInterval(interval)
                        }
                        logger.log(' Success\n')
                    }
                }
                logger.log(chalk.green('\nAll migrations successful\n'))
            }
            break
        }
    }

    /** Returns a string that can be printed to a CLI */
    public toString(): string {
        let str = ''
        if (this.lastTask) {
            str += `Last migration:      ${this.lastTask.toString()}\n`
            str += `Applied at:          ${this.lastTask.appliedAt}\n`
            if (this.lastTask.commit) {
                str += `Triggered by commit: ${this.lastTask.commit.toString()}\n`
            }
            if (this.lastTask.head) {
                str += `HEAD at execution:   ${this.lastTask.head.toString()}\n`
            }
        } else {
            str += `Last migration:      No migration run yet\n`
        }
        if (this.head) {
            str += chalk.grey(
                `                        ${
                    this.newCommits.length === 0
                        ? '‖'
                        : `${this.newCommits.isReversed ? '↑' : '↓'} ${this.newCommits.length} commit${
                              this.newCommits.length > 1 ? 's' : ''
                          }`
                }\n`
            )
            str += `Current HEAD:        ${this.head.toString()}\n`
        }
        str += '\n'
        const relevantCommits = this.newCommits.filter(commit => commit.tasks.length > 0)
        if (relevantCommits.length === 0) {
            str += 'No pending migrations\n'
            return str
        }
        const migrationCount = relevantCommits.reduce((prev: number, curr: Commit) => prev + curr.tasks.length, 0)
        str += chalk.underline(`${migrationCount} pending migration${migrationCount > 1 ? 's' : ''}:\n\n`)
        for (const commit of relevantCommits) {
            str += commit.toString() + '\n'
            for (const task of commit.tasks) {
                str += (this.newCommits.isReversed ? task.invert() : task).toString() + '\n'
            }
            str += `\n`
        }
        return str
    }
}

/**
 * Returns an object with information about the current status of the repository
 * @param adapter the database adapter to use. Create one with [[createAdapterFromUrl]]
 * @param head The current HEAD commit. If not given, will ask git
 */
export async function getStatus(adapter: DbAdapter, head?: Commit): Promise<Status> {
    if (!head) {
        head = await getHead()
    }
    const lastTask = await adapter.getLastMigrationTask()
    let newCommits: CommitSequence
    if (lastTask) {
        newCommits = await getNewCommits(lastTask.head)
        // Load commit messages
        await Promise.all(
            [lastTask.commit, lastTask.head]
                .filter((commit): commit is NonNullable<typeof commit> => !!commit)
                .map(async commit => {
                    try {
                        await commit.loadSubject()
                    } catch (err) {
                        /* istanbul ignore next */
                        if (err.code !== 128) {
                            throw err
                        }
                    }
                })
        )
    } else {
        newCommits = await getNewCommits()
    }
    if (head) {
        await head.loadSubject()
    }
    return new Status({ head, newCommits, lastTask })
}

export interface Logger {
    log(msg: string): void
    error(msg: string): void
    warn(msg: string): void
}

/** Options for [[generate]] */
export interface GenerateOptions {
    /** The directory to generate the migration file in */
    migrationDir: string

    /** The name of the migration. By default a UUID */
    name?: string

    /** The path to a template file to use */
    template?: string
}

/** Options for [[createConfig]] */
export interface MerkelConfiguration {
    /** The directory where new migration files should be generated */
    migrationDir: string

    /**
     * The directory where the JavaScript migration files can be found.
     * Can differ from `migrationDir` when using a transpiler.
     */
    migrationOutDir: string
}

/**
 * Checks if a folder has a .merkelrc.json file
 */
export async function isMerkelRepository(): Promise<boolean> {
    try {
        await fs.access('.merkelrc.json')
        return true
    } catch (err) {
        return false
    }
}

/**
 * Creates the migration directory
 */
export function createMigrationDir(migrationDir: string): Promise<boolean> {
    return new Promise((resolve, reject) =>
        mkdirp(
            migrationDir,
            (err, made) =>
                /* istanbul ignore next */
                err ? reject(err) : resolve(!!made)
        )
    )
}

/**
 * Creates a new .merkelrc.json
 */
export async function createConfig(config: MerkelConfiguration): Promise<void> {
    await fs.writeFile('.merkelrc.json', JSON.stringify(config, null, 2) + '\n')
}

/**
 * Prepares a commit message for git by adding merkel commands to it.
 * @param msgfile The path to the file with the commit message
 */
export async function prepareCommitMsg(
    msgfile: string,
    migrationDir: string,
    logger: Logger = CLI_LOGGER
): Promise<void> {
    const msg = await fs.readFile(msgfile, 'utf8')
    // check that migrations have not been deleted by a revert
    if (isRevertCommit(msg)) {
        logger.warn(chalk.bgYellow('WARNING: migrations have been removed by a git revert'))
    }
    // add commands
    const taskList = await getTasksForNewCommit(migrationDir)
    await fs.appendFile(msgfile, '\n' + taskList.toString(true))
}

export class MigrationAlreadyExistsError extends Error {
    constructor(file: string) {
        super('Migration file already existed: ' + file)
    }
}

/**
 * Generates a new migration file
 */
export async function generate(options: GenerateOptions, logger: Logger = CLI_LOGGER): Promise<string> {
    options.name = options.name || uuidv1()
    let template: string
    let ext = ''
    if (options.template) {
        try {
            template = await fs.readFile(options.template, 'utf8')
        } catch (err) {
            /* istanbul ignore if */
            if (err.code !== 'ENOENT') {
                throw err
            }
            throw new TemplateNotFoundError(options.template)
        }
    } else {
        // detect tsconfig.json
        try {
            const tsconfig = JSON.parse(await fs.readFile('tsconfig.json', 'utf8'))
            const targetLessThanEs6 = tsconfig.compilerOptions && /^es[35]$/i.test(tsconfig.compilerOptions.target)
            ext = '.ts'
            template = [
                '',
                `export ${targetLessThanEs6 ? '' : 'async '}function up(): Promise<void> {`,
                '',
                '}',
                '',
                `export ${targetLessThanEs6 ? '' : 'async '}function down(): Promise<void> {`,
                '',
                '}',
                '',
            ].join('\n')
        } catch (err) {
            /* istanbul ignore if */
            if (err.code !== 'ENOENT') {
                throw err
            }
            ext = '.js'
            template = [
                '',
                'exports.up = function up() {',
                '',
                '};',
                '',
                'exports.down = function down() {',
                '',
                '};',
                '',
            ].join('\n')
        }
    }
    const file = `${options.migrationDir}/${options.name}${ext}`
    const relativePath = path.relative(process.cwd(), options.migrationDir)
    // check if already exists
    try {
        await fs.access(file)
        logger.error(
            chalk.red(
                '\nError: Migration file ' +
                    relativePath +
                    path.sep +
                    chalk.bold(options.name) +
                    ext +
                    ' already exists\n'
            )
        )
        throw new MigrationAlreadyExistsError(file)
    } catch (err) {
        if (err instanceof MigrationAlreadyExistsError) {
            throw err
        }
        // continue
    }
    await new Promise<void>((resolve, reject) => mkdirp(options.migrationDir, err => (err ? reject(err) : resolve())))
    await fs.writeFile(file, template)
    logger.log('\nCreated ' + chalk.cyan(relativePath + path.sep + options.name + ext) + '\n')
    return options.name
}
