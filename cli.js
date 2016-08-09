
const program = require('commander')
const pkg = require('./package.json')
const childProcess = require('mz/child_process')
const fs = require('mz/fs')
const path = require('path')
const uuid = require('node-uuid')
const url = require('url')
const mkdirp = require('mkdirp')
require('update-notifier')({pkg}).notify()

function getMigrationDir() {
  return program['migration-dir'] || process.cwd() + '/migrations'
}

program
  .version(pkg.version)
  .option('--db [url]', 'The connection URL for the database. Can also be passed as env var DB')
  .option('--migration-dir [path]', 'The directory for the migration files. Default: ./migrations')

program
  .command('create')
  .description('Creates a new migration file')
  .action(() => {
    const migrationDir = getMigrationDir()
    new Promise((resolve, reject) => mkdirp(migrationDir, err => err ? reject(err) : resolve())).then(() => {
      const fileBase = path.resolve(migrationDir + '/' + uuid.v4())
      const files = [fileBase + '_up.sql', fileBase + '_down.sql']
      const template = [
        '/*',
        ' * Description of change',
        ' */'
      ].join('\n')
      Promise.all(files.map(file => fs.writeFile(file, template)))
        .then(() => {
          process.stdout.write('Created\n' + files.map(file => path.relative(process.cwd(), file)).join('\n'))
          process.exit(0)
        })
        .catch(err => {
          process.stderr.write(err.message)
          process.exit(1)
        })
    })
  })

program
  .command('migrate')
  .description('Executes all migrations that have been added or removed since the last')
  .action(() => {
    let migrationsRun = 0
    Promise.resolve()
      .then(() => {
        const migrationDir = getMigrationDir()
        const dialect = url.parse(program.db || process.env.DB).protocol
        if (dialect === 'postgres') {
          const pg = require(process.cwd() + '/node_modules/pg')
          const client = new pg.Client()
          return new Promise((resolve, reject) => client.connect(err => err ? reject(err) : resolve()))
            .then(() => {
              // find out the current database state
              return client.query(`
                CREATE TABLE IF NOT EXISTS merkel_meta (
                  migration TEXT NOT NULL,
                  applied TIMESTAMP WITH TIME ZONE NOT NULL
                );
                SELECT migration FROM merkel_meta ORDER BY applied DESC LIMIT 1;
              `)
            })
            .then(result => {
              if (result.rows.length > 0) {
                const migration = migrationDir + '/' + result.rows[0].migration
                // find out when that migration was added to the repository
                return childProcess.exec(`git log --format=%H --diff-filter=A -- ${migration}.*`).then(output => {
                  const commit = output[0].toString().trim()
                  // get all added / changed / removed migration files since that commit, in the order of the commits
                  return childProcess.exec(`git log --reverse --format="commit %H" --name-status ${commit} -- ${migrationDir}`)
                })
              } else {
                // get all added / changed / removed migration files since the initial commit, in the order of the commits
                return childProcess.exec(`git log --reverse --format="commit %H" --name-status -- ${migrationDir}`)
              }
            })
            .then(output => {
              const lines = output[0].toString().split(/[\n\r]+/)
              let commit
              let promise = Promise.resolve()
              for (const line of lines) {
                if (/^commit/.test(line)) {
                  commit = line.substr('commit'.length).trim()
                }
                const status = line.charAt(0)
                const file = line.substr(1).trim()
                const migration = path.basename(file, '.sql')
                if (status !== 'A' && status !== 'D') {
                  throw new Error(`Bad Commit ${commit}: Migration files should only be added or removed.\n${line}`)
                }
                // run removed down scripts and added up scripts
                if ((status === 'A' && file.substr(-'_up.sql'.length) === '_up.sql') || (status === 'D' && file.substr(-'_down.sql'.length) === '_down.sql')) {
                  promise = promise.then(() => {
                    process.stdout.write(`Running ${file}, ${{A: 'added', D: 'deleted'}[status]} at commit ${commit}\n`)
                    // get the script content
                    return childProcess.exec(`git show ${commit}:${file}`)
                  }).then(output => {
                    const script = output[0].toString()
                    // get description
                    const match = script.match(/^\s*\/\*((?:.|\n|\r)*)\*\//)
                    if (match) {
                      const description = match[1].split(/[\n\r]/).map(line => line.replace(/^\s*\/?\*\/?\s*/, '').trim())
                      process.stdout.write(description.find(line => line.length > 0))
                    }
                    // run it
                    return client.query(script)
                  }).then(() => {
                    migrationsRun++
                    return client.query('INSERT INTO merkel_meta (migration, applied) VALUES ($1, $2)', [migration, new Date()])
                  })
                }
              }
              return promise
            })
        } else {
          throw new Error('Unssupported dialect ' + dialect)
        }
      })
      .then(() => {
        process.stdout.write(`Finished, ${migrationsRun} migrations run`)
        process.exit(0)
      })
      .catch(err => {
        process.stderr.write(err.message)
        process.exit(1)
      })
  })

program.parse(process.argv)
