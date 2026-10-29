#!/bin/sh
set -eu
node=/usr/lib/doublemusic/runtime/node
service_pid=
stop_service() {
    if [ -n "$service_pid" ]; then
        kill -TERM "$service_pid" 2>/dev/null || true
        wait "$service_pid" || true
        service_pid=
    fi
}
cleanup() {
    status=$?
    stop_service
    if [ "$status" != 0 ] && [ -f /tmp/doublemusic-package-service.log ]; then cat /tmp/doublemusic-package-service.log >&2; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemd-analyze verify /usr/lib/systemd/system/doublemusic.service
# The package should create a system account, not start the server automatically.
test "$(id -u doublemusic)" -ne 0
test -r /etc/doublemusic/settings.json
sed -i 's/CACHE_MAX_MB=2048/CACHE_MAX_MB=64/' /etc/doublemusic/doublemusic.env
printf '%s\n' '{"version":1,"library":{"enabled":true},"external":{"enabled":false},"preservedSetting":true}' > /etc/doublemusic/settings.json
ffmpeg -nostdin -loglevel error -f lavfi -i sine=frequency=440:duration=2 -c:a flac -metadata title=PackageTest -metadata artist=DoubleMusic -metadata album=Installation /srv/doublemusic/music/test.flac
printf '%s\n' package-test-password-only | runuser -u doublemusic -- doublemusic-user add packagetest --admin --password-stdin > /tmp/created-user.json
start_service() {
    runuser -u doublemusic -- doublemusic-server > /tmp/doublemusic-package-service.log 2>&1 &
    service_pid=$!
    "$node" -e '(async()=>{for(let i=0;i<100;i++){try{const r=await fetch("http://127.0.0.1:3000/health");if(r.ok)return;}catch{} await new Promise(r=>setTimeout(r,100));}throw Error("Package service did not become ready");})().catch(e=>{console.error(e);process.exitCode=1});'
}
start_service
"$node" - <<'JS'
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const base='http://127.0.0.1:3000';
 const root=await(await fetch(base+'/api/v1')).json();
 assert.deepEqual(root.runtime,{core:'rust',catalog:'node'});
 assert.deepEqual(root.configuration,{library:{enabled:true},external:{enabled:false}});
 const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'packagetest',password:'package-test-password-only',transport:'bearer'})});
 assert.equal(login.status,200);const session=(await login.json()).session;
 fs.writeFileSync('/tmp/package-session.json',JSON.stringify(session),{mode:0o600});
 const headers={Authorization:'Bearer '+session.token};
 const catalog=await(await fetch(base+'/api/v1/catalog/tracks',{headers})).json();
 assert.equal(catalog.total,1);assert.equal(catalog.items[0].title,'PackageTest');
 const track=catalog.items[0];
 const audio=await fetch(base+'/api/v1/audio/'+encodeURIComponent(track.id),{headers:{...headers,Range:'bytes=0-99'}});
 assert.equal(audio.status,206);assert.equal((await audio.arrayBuffer()).byteLength,100);
 const aac=await fetch(base+'/api/v1/audio/'+encodeURIComponent(track.id)+'?quality=128&layout=2',{headers});
 assert.equal(aac.status,200);assert.ok(Buffer.from(await aac.arrayBuffer()).includes(Buffer.from('sidx')));
 const fav=await fetch(base+'/api/v1/library/favorites/'+encodeURIComponent(track.id),{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({track})});
 assert.equal(fav.status,200);
})().catch(e=>{console.error(e);process.exitCode=1});
JS
stop_service
cp /etc/doublemusic/doublemusic.env /tmp/package.env.expected
cp /etc/doublemusic/settings.json /tmp/package.settings.expected
if [ "$PACKAGE_MANAGER" = deb ]; then
    dpkg --force-confold -i /tmp/packages/*.deb
else
    rpm -U --replacepkgs /tmp/packages/*.rpm
fi
cmp /etc/doublemusic/doublemusic.env /tmp/package.env.expected
cmp /etc/doublemusic/settings.json /tmp/package.settings.expected
start_service
"$node" - <<'JS'
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const session=JSON.parse(fs.readFileSync('/tmp/package-session.json'));
 const headers={Authorization:'Bearer '+session.token};
 const me=await fetch('http://127.0.0.1:3000/api/v1/auth/me',{headers});assert.equal(me.status,200);
 const library=await(await fetch('http://127.0.0.1:3000/api/v1/library',{headers})).json();assert.equal(library.favorites.length,1);
})().catch(e=>{console.error(e);process.exitCode=1});
JS
stop_service
test -s /var/lib/doublemusic/core.sqlite
if [ "$PACKAGE_MANAGER" = deb ]; then
    dpkg --remove doublemusic
    test -s /etc/doublemusic/settings.json
    dpkg --purge doublemusic
else
    rpm -e doublemusic
    test -s /etc/doublemusic/settings.json.rpmsave
fi
test -s /var/lib/doublemusic/core.sqlite
test -s /srv/doublemusic/music/test.flac
getent passwd doublemusic >/dev/null
printf 'Package %s: install, account, unprivileged startup, local scan/audio, conversion, upgrade/config/session/library persistence and removal passed.\n' "$PACKAGE_MANAGER"
