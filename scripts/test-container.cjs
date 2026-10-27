'use strict';
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const image = process.env.DOUBLEMUSIC_TEST_IMAGE || 'doublemusic:test';
const name = 'doublemusic-runtime-test-' + crypto.randomBytes(5).toString('hex');
const volume = name + '-data';
const password = crypto.randomBytes(24).toString('base64url');
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 45000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const evaluate = (source, input) => docker(['exec', '-i', name, 'node', '-e', source], input);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { docker(['exec', name, 'doublemusic-core', '--healthcheck']); return; } catch {}
    await delay(100);
  }
  throw Error('Managed Rust/catalog container did not become ready.');
}
(async () => {
  try {
    docker(['volume', 'create', volume]);
    docker(['run', '-d', '--name', name, '--network', 'none', '--read-only', '--init', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=128m,mode=1777',
      '-v', volume + ':/data', '-e', 'PUBLIC_URL=http://localhost:3000', image]);
    await ready();
    evaluate(`(async()=>{
      const assert=require('node:assert/strict');
      const res=await fetch('http://127.0.0.1:3000/api/v1'), info=await res.json();
      assert.equal(res.headers.get('x-core-runtime'),'rust');
      assert.deepEqual(info.runtime,{core:'rust',catalog:'node'});
      assert.deepEqual(info.configuration,{library:{enabled:true},external:{enabled:false}});
      const sockets=require('node:fs').readFileSync('/proc/net/tcp','utf8');
      assert.ok(sockets.includes('0100007F:0BB9'),'Catalog must bind only to loopback');
      assert.ok(!sockets.includes('00000000:0BB9'),'Catalog must not bind to the container network');
    })().catch(e=>{console.error(e);process.exitCode=1});`);
    docker(['exec', '-i', name, 'node', 'cli.js', 'add', 'smoke', '--admin', '--password-stdin'], password + '\n');
    const session = JSON.parse(evaluate(`(async()=>{
      let password='';for await(const chunk of process.stdin) password+=chunk;
      const res=await fetch('http://127.0.0.1:3000/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'smoke',password:password.trim(),transport:'bearer'})});
      require('node:assert/strict').equal(res.status,200);console.log(JSON.stringify((await res.json()).session));
    })().catch(e=>{console.error(e);process.exitCode=1});`, password));
    docker(['stop', '-t', '35', name]);
    assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]), '0');
    docker(['start', name]);
    await ready();
    evaluate(`(async()=>{
      let token='';for await(const chunk of process.stdin) token+=chunk;
      for(const route of ['auth/me','library','catalog/tracks']) {
        const res=await fetch('http://127.0.0.1:3000/api/v1/'+route,{headers:{Authorization:'Bearer '+token}});
        require('node:assert/strict').equal(res.status,200);
      }
    })().catch(e=>{console.error(e);process.exitCode=1});`, session.token);
    // Losing the managed worker must terminate the container for its restart policy.
    evaluate(`const fs=require('node:fs');for(const pid of fs.readdirSync('/proc').filter(v=>/^\\d+$/.test(v))) {
      try { const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');if(cmd==='node\\0server.js\\0') process.kill(Number(pid),'SIGTERM'); } catch {}
    }`);
    const code = docker(['wait', name]);
    assert.notEqual(code, '0');
    console.log('Managed container: readiness, private worker, read-only runtime, accounts, restart persistence, graceful shutdown and worker failure passed.');
  } catch (error) {
    try { process.stderr.write(docker(['logs', '--tail', '40', name]) + '\n'); } catch {}
    throw error;
  } finally {
    try { docker(['rm', '-f', name]); } catch {}
    try { docker(['volume', 'rm', volume]); } catch {}
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
