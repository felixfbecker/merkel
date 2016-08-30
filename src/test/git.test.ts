
// import {parseGitLog} from '../git';
// import {readFile} from 'mz/fs';
// import * as assert from 'assert';

// describe('git', () => {
//     describe('parseGitLog', async () => {
//         it('should parse git commit log', async () => {
//             const output = await readFile(__dirname + '/../../src/test/git_log_output.txt');
//             const commits = parseGitLog(output.toString(), 'migrations');
//             assert.deepEqual(commits, [
//                 {
//                     sha1: 'c3555604ddfc24022508c5e1f9398c81f3b9b6fa',
//                     message: 'Revert changes to user model\n\nThis reverts commit b9fb8f15176d958d42dba4f14e35f1bf71ec0be9\nand 900931208ae7dabfd9ede49a78d4a961aa8043ba.\n\n\n\n',
//                     migration: undefined,
//                     commands: [
//                         ['down', 'd9271b98-1a2e-445f-8363-783b2bee0ef0'],
//                         ['down', '694b8b6c-3aaa-4e4d-8d54-76515ba90617']
//                     ]
//                 },
//                 {
//                     sha1: 'b9fb8f15176d958d42dba4f14e35f1bf71ec0be9',
//                     message: 'Change the User model\n\nAdd column username to User model\n',
//                     migration: 'c:\\Users\\felix\\git\\OpenSource\\merkel\\migrations\\d9271b98-1a2e-445f-8363-783b2bee0ef0.ts',
//                     commands: []
//                 },
//                 {
//                     sha1: '900931208ae7dabfd9ede49a78d4a961aa8043ba',
//                     message: 'Change the User model\n\nAdd email column to User model\n\nAdds column username to User model\n',
//                     migration: 'c:\\Users\\felix\\git\\OpenSource\\merkel\\migrations\\694b8b6c-3aaa-4e4d-8d54-76515ba90617.ts',
//                     commands: []
//                 }
//             ]);
//         });
//     });
// });
