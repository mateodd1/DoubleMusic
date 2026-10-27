#!/usr/bin/env node
'use strict';
const { Store } = require('./src/database');
const { hashPassword } = require('./src/auth');

async function main(args) {
  process.umask(0o077);
  const [command, username] = args;
  const store = new Store();
  try {
    if (command === 'list') {
      console.log(JSON.stringify(store.all('SELECT id,username,role FROM users ORDER BY username'), null, 2)); return;
    }
    if (!['add', 'passwd', 'del', 'revoke'].includes(command) || !username) throw new Error('Usage: node cli.js add|passwd|del|revoke username [--admin] [--password-stdin]; node cli.js list');
    const user = store.get('SELECT * FROM users WHERE username=?', username);
    if (command !== 'add' && !user) throw new Error('User not found.');
    if (command === 'del') { store.run('DELETE FROM users WHERE id=?', user.id); console.log('Account deleted and sessions revoked.'); return; }
    if (command === 'revoke') { store.run('DELETE FROM sessions WHERE user_id=?', user.id); console.log('Sessions revoked.'); return; }
    if (!args.includes('--password-stdin')) throw new Error('Provide the password on stdin using --password-stdin.');
    let password = '';
    for await (const chunk of process.stdin) { password += chunk; if (password.length > 2048) throw new Error('Password is too long.'); }
    const hash = await hashPassword(password.replace(/\r?\n$/, ''));
    if (command === 'add') console.log(JSON.stringify(store.createUser(username, hash, args.includes('--admin') ? 'admin' : 'user')));
    else {
      store.transaction(() => { store.run('UPDATE users SET hash=? WHERE id=?', hash, user.id); store.run('DELETE FROM sessions WHERE user_id=?', user.id); });
      console.log('Password changed and sessions revoked.');
    }
  } finally { store.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
