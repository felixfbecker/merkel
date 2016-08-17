
# `merkel`
_Handles your database migration crisis_

[![Build Status](https://travis-ci.org/felixfbecker/merkel.svg?branch=master)](https://travis-ci.org/felixfbecker/merkel)

## Features
 - **Uses UUIDs to name migration files**  
   In opposite to sequential IDs and timestamps this means developerd can add migration files at the same time without
   any merge conflicts. You can even cherry-pick commits across repositories.
 - **Uses git to find out which migrations to run**  
   When you run `merkel migrate`, merkel queries the last run migration from the database.
   It then uses git to find out all migration files which have been added since then, and executes the `up` migrations
   in the correct order. If you reverted a commit with `git revert` (which means the migration files got removed again),
   merkel will execute the removed `down` migrations.
 - ~~**Supports fixing bugs in migration files**  
   Let's say you made a mistake in your migration file and it doesn't execute. Your database will remain at the migration
   state executed before it. You can correct the migration file and commit the result, and merkel will run the updated migration.~~
 - **Framework-agnostic**  
   Use whatever database driver you like in your migration files.

## Usage

### Installation
Install globally or locally with `npm install -g merkel` or `npm install --save-dev merkel`.

### Creating Migration Files
For every commit that requires a database migration, run

```sh
$ merkel create
Created                                                                                                                                       
migrations\3a851ced-0666-47ae-a56e-1a027591a2af_up.sql                                                                                        
migrations\3a851ced-0666-47ae-a56e-1a027591a2af_down.sql
```

Open both files in your editor. Make sure to provide at least a one-line summary in the comment on the top (merkel will
show these when running migrations). The `up` file should contain all SQL statements needed to perform the migration.
The `down` file on the other hand should contain all SQL statements needed to revert the change as best as possible.
Commit the migration files together with the rest of your code changes.

### Running migrations
```sh
$ merkel migrate


