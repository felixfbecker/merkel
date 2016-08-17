// let migrationsRun = 0
//     Promise.resolve()
//       .then(() => {
//         const migrationDir = getMigrationDir()
//         const dialect = url.parse(program.db || process.env.DB).protocol
//         if (dialect === 'postgres') {
//           const pg = require(process.cwd() + '/node_modules/pg')
//           const client = new pg.Client()
//           return Promise.all([
//             fs.readdir(migrationDir),
//             new Promise((resolve, reject) => client.connect(err => err ? reject(err) : resolve())).then(() => {
//               // find out the current database state
//               return client.query(`
//                 CREATE TABLE IF NOT EXISTS merkel_meta (
//                   migration TEXT NOT NULL,
//                   applied TIMESTAMP WITH TIME ZONE NOT NULL
//                 );
//                 SELECT migration FROM merkel_meta ORDER BY applied DESC;
//               `)
//             })
//           ]).then(result => {
//             const migrationFiles = result[0];
//             const runMigrations = result[1].map(result => ;
//           })
//             .then(result => {
//               if (result.rows.length > 0) {
//                 const migration = migrationDir + '/' + result.rows[0].migration
//                 // find out when that migration was added to the repository
//                 return childProcess.exec(`git log --format=%H --diff-filter=A -- ${migration}.*`).then(output => {
//                   const commit = output[0].toString().trim()
//                   // get all added migration files since that commit, in the order of the commits
//                   return childProcess.exec(`git log --reverse --format="commit %H" --name-status ${commit} -- ${migrationDir}`)
//                 })
//               } else {
//                 // get all added / changed / removed migration files since the initial commit, in the order of the commits
//                 return childProcess.exec(`git log --reverse --format="commit %H" --name-status -- ${migrationDir}`)
//               }
//             })
//             .then(output => {
//               const lines = output[0].toString().split(/[\n\r]+/)
//               let commit
//               let promise = Promise.resolve()
//               for (const line of lines) {
//                 if (/^commit/.test(line)) {
//                   commit = line.substr('commit'.length).trim()
//                 }
//                 const status = line.charAt(0)
//                 const file = line.substr(1).trim()
//                 const migration = path.basename(file, '.sql')
//                 if ((status === 'A') {
//                   promise = promise.then(() => {
//                     process.stdout.write(`Running migration ${file}: ${description} (commit ${commit})\n`)
//                     // get the script content
//                     return childProcess.exec(`git show ${commit}:${file}`)
//                   }).then(output => {
//                     const script = output[0].toString()
//                     // run it
//                     return client.query(script)
//                   }).then(() => {
//                     migrationsRun++
//                     return client.query('INSERT INTO merkel_meta (migration, applied) VALUES ($1, $2)', [migration, new Date()])
//                   })
//                 }
//               }
//               return promise
//             })
//         } else {
//           throw new Error('Unssupported dialect ' + dialect)
//         }
