# API v1 de DoubleMusic

El cliente configura el origen del servidor, por ejemplo `https://musica.tudominio.es`, y añade `/api/v1` a las rutas. Utiliza ese mismo origen para JSON, portadas, letras, audio y Connect. El despliegue debe estar en la raíz del dominio.

## Sesión

`POST /api/v1/auth/login`, con `Content-Type: application/json`:

```json
{"username":"usuario","password":"contraseña","transport":"bearer"}
```

Respuesta:

```json
{
  "user": {"id":"uuid","username":"usuario","role":"user"},
  "session": {"token":"TOKEN","tokenType":"Bearer","expiresAt":1790000000000}
}
```

Envía `Authorization: Bearer TOKEN` en las siguientes peticiones, también en HEAD y Range del audio. Las sesiones duran 30 días y son revocables. `transport: "cookie"` crea una cookie HttpOnly para clientes que la soporten; el token no aparece en ese JSON.

| Método | Ruta bajo `/api/v1` | Resultado |
| --- | --- | --- |
| GET | `/` | Versión, capacidades y límites; público. |
| POST | `/auth/login` | Iniciar sesión. |
| GET | `/auth/me` | Usuario y expiración de la sesión. |
| POST | `/auth/logout` | Revocar la sesión actual. |
| PUT | `/auth/password` | `{currentPassword,newPassword}`; revoca todas las sesiones de la cuenta. |

`GET /health` es público y devuelve estado e información del último escaneo. Las portadas también son públicas, porque los clientes las cargan como imágenes sin credenciales. Las demás rutas requieren sesión. Los tokens no se aceptan en parámetros de URL.

## Modelos y catálogo

Los ids son cadenas opacas completas: `local:t_…` para pistas, `local:a_…` para álbumes, `local:r_…` para artistas y `local:p_…` para playlists de archivos. Codifica el id como un único segmento al construir URLs; no lo recortes ni lo sustituyas.

Una pista:

```json
{
  "id":"local:t_0123456789abcdef0123456789abcdef",
  "provider":"local",
  "title":"Canción",
  "artist":"Artista",
  "artistId":"local:r_0123456789abcdef0123456789abcdef",
  "artists":[{"id":"local:r_0123456789abcdef0123456789abcdef","name":"Artista"}],
  "album":"Álbum",
  "albumId":"local:a_0123456789abcdef0123456789abcdef",
  "track":1,
  "disc":1,
  "duration":180.5,
  "coverUrl":"https://musica.tudominio.es/api/v1/catalog/artwork/local%3At_0123456789abcdef0123456789abcdef",
  "codec":"flac",
  "bitrate":850,
  "sampleRate":44100
}
```

La duración se expresa en segundos, el bitrate en kbps y la frecuencia en Hz. Las fechas de biblioteca y sesión son milisegundos Unix. Las rutas reales de los archivos quedan dentro del servidor.

| GET bajo `/api/v1` | Respuesta |
| --- | --- |
| `/catalog/featured` | Estantes `albums`, `artists`, `playlists`, `pools`, `followed`, cada uno con `title` e `items`. |
| `/catalog/search?q=texto` | `{tracks,albums,artists,playlists}`, hasta 200 por tipo; ignora mayúsculas y tildes. |
| `/catalog/albums` | `{albums,items,total,limit,offset}`. |
| `/catalog/artists` | `{artists,items,total,limit,offset}`. |
| `/catalog/tracks` | `{tracks,items,total,limit,offset}`. |
| `/catalog/albums/{id}` | Álbum con `id,title,artist,artistId,year,coverUrl,trackCount,tracks`. |
| `/catalog/artists/{id}` | `{artist,albums,singles,tracks,playlists,playlistsStatus}`. |
| `/catalog/artists/{id}/tracks` | `{artist,tracks,items,total,limit,offset}`. |
| `/catalog/artists/{id}/playlists` | `{artistId,status:"empty",playlists:[]}`. |
| `/catalog/tracks/{id}` | Pista. |
| `/catalog/tracks/{id}/motion` | `{id}`; el cliente utiliza la portada estática. |
| `/catalog/playlists` | `{playlists:[{id,title,coverUrl,trackCount}]}` a partir de M3U/M3U8. |
| `/catalog/playlists/{id}` | Playlist con sus `tracks`. |
| `/catalog/daily`, `/catalog/discovery` | `{generatedAt,shelves:[{title,items}]}` con las playlists locales. |
| `/catalog/artwork/{idDePista}` | Imagen local; acepta HEAD. |
| `/providers` | `{items:{local:{available:true}}}`. |

Las listas paginadas aceptan `limit` entre 1 y 500, por defecto 200, y `offset` no negativo, por defecto 0. `featured` incluye hasta 200 álbumes y artistas; para enumerar bibliotecas grandes se usan las rutas paginadas.

Los álbumes se agrupan por artista del álbum y título; los artistas de las pistas se conservan por separado. Los álbumes con el mismo artista del álbum y título comparten ficha. Las pistas se ordenan por disco y número de pista.

## Audio desde el servidor

`GET` o `HEAD /api/v1/audio/{id}`. La respuesta contiene bytes de audio y admite un rango `Range: bytes=inicio-fin`, rangos abiertos y sufijos. Devuelve `206` con `Content-Range`, o `416` si el rango no es válido. `Content-Length`, `Accept-Ranges`, `ETag` e `If-Range` permiten precarga y saltos sin recorrer toda la pista.

| Parámetro | Valores | Comportamiento |
| --- | --- | --- |
| `quality` | `original`, `320`, `192`, `128` | Por defecto `original`. Los valores numéricos convierten en el servidor a ese bitrate. |
| `layout` | `1`, `2` | `2` selecciona salida fMP4 con índice `sidx`, salvo que se indique `format` explícitamente. |
| `format` | `original`, `mp4`, `mp3` | Sin especificar: original para calidad original y layout distinto de 2; MP4 en los demás casos. |

`format=original` exige `quality=original` y entrega el archivo sin modificar. MP4 con calidad original conserva AAC, ALAC, FLAC y Opus; convierte los demás a AAC a 320 kbps. Las calidades numéricas en MP4 siempre producen AAC estéreo a 48 kHz. MP3 se convierte a la calidad pedida o a 320 kbps si se solicita `original`.

Las opciones adicionales de presentación que envíe el cliente no cambian la selección del archivo local. El formato y códec reales se informan en `Content-Type`, `X-Audio-Codec`, `X-Audio-Bitrate`, `X-Audio-Sample-Rate` y `X-Audio-Duration`. El cliente puede necesitar leer estas cabeceras para mostrar la calidad.

Ejemplo de cliente móvil:

```http
GET /api/v1/audio/local%3At_0123456789abcdef0123456789abcdef?quality=192&layout=2
Authorization: Bearer TOKEN
Range: bytes=0-65535
```

La conversión se completa en disco antes de responder; una petición HEAD también puede preparar la variante. El proxy debe permitir tiempo suficiente para la primera conversión. Las siguientes peticiones reutilizan la caché. El códec elegido debe estar soportado por el reproductor nativo del cliente.

Opcionalmente, `POST /playback` con `{trackId,quality?,format?,layout?}` devuelve `{trackId,audioUrl,format,info}`. La URL usa la misma sesión; no contiene credenciales. Los clientes que usan `/audio/{id}` directamente no necesitan esta llamada.

## Letras

`GET` o `HEAD /lyrics/{id}` devuelve TTML con `Content-Type: application/ttml+xml` y `X-Lyrics-Source: local`. Si no hay letra devuelve `204`. La prioridad es `.ttml`, después `.lrc` y finalmente `.txt`, siempre al lado de la pista y con el mismo nombre base. LRC conserva sus tiempos y su desplazamiento `offset`; los textos simples no llevan tiempos.

## Biblioteca por cuenta

| Método | Ruta bajo `/api/v1` | Cuerpo / resultado |
| --- | --- | --- |
| GET | `/library` | `{rev,favorites,playlists,savedAlbums,savedPlaylists,following,catalogRev}`. |
| PUT | `/library/favorites/{id}` | `{track:{id}}`. |
| DELETE | `/library/favorites/{id}` | Quitar favorito. |
| POST | `/library/playlists` | `{name,tracks:[{id}]}`; devuelve `{rev,playlist}`. |
| GET | `/library/playlists/{id}` | `{rev,playlist:{id,name,createdAt,updatedAt,tracks}}`. |
| PATCH | `/library/playlists/{id}` | `{name}`. |
| DELETE | `/library/playlists/{id}` | Borrar playlist. |
| POST | `/library/playlists/{id}/tracks` | `{tracks:[{id}]}`; devuelve `{rev,added}`. |
| DELETE | `/library/playlists/{id}/tracks/{trackId}` | Quitar pista. |
| PUT | `/library/playlists/{id}/order` | `{trackIds:[...],expectedRev?}`; permutación completa. |
| PUT / DELETE | `/library/saved-albums/{id}` | Guardar o retirar álbum. |
| PUT / DELETE | `/library/saved-playlists/{id}` | Guardar o retirar una playlist M3U. |
| GET | `/following` | `{rev,items}`. |
| PUT | `/following/{artistId}` | `{}`; el servidor toma los datos del artista local. |
| DELETE | `/following/{artistId}` | Dejar de seguir. |
| POST | `/library/import` | `{source,deviceId,favorites:[{id}],playlists:[{id,name,tracks:[{id}]}]}`. |

Los metadatos recibidos en escrituras se sustituyen por los del catálogo local. Los clientes pueden enviar sus snapshots completos. Las pistas de favoritos y playlists se devuelven como `{track,addedAt}`. Las playlists personales tienen ids `u…` y pertenecen exclusivamente a su cuenta. La importación admite `source` igual a `ios`, `android` o `web` y es idempotente por cuenta, origen y dispositivo; todos los ids deben existir en este catálogo.

Las escrituras devuelven `rev`; las operaciones idempotentes no lo incrementan. `GET /library?rev=N&catalogRev=HASH` devuelve `304` si no hay cambios. `catalogRev` permite detectar cambios en las playlists M3U guardadas. Los límites se publican en la raíz de la API. Los favoritos y playlists personales conservan su snapshot si después desaparece una pista; reproducirla devuelve `404` hasta que vuelva a estar disponible con ese id.

## Administración

Solo para `role: admin`:

| Método | Ruta bajo `/api/v1` | Uso |
| --- | --- | --- |
| GET | `/admin/users` | Lista de cuentas y cantidades. |
| POST | `/admin/users` | `{username,password,role?}`. |
| POST | `/admin/users/{username}/password` | `{password}`; revoca las sesiones. |
| POST | `/admin/users/{username}/revoke` | Revocar todas las sesiones. |
| DELETE | `/admin/users/{username}` | `{confirm:username}`; no permite borrar la propia cuenta. |
| POST | `/admin/scan` | Iniciar un escaneo; devuelve `202` sin esperar a que termine. |
| GET | `/admin/scan` | `{scanning,lastScan,error}`. |

Los nombres de cuenta tienen entre 4 y 64 caracteres `A-Za-z0-9_.-`; las contraseñas, entre 8 y 1024 caracteres. Las bibliotecas se actualizan de forma atómica en SQLite. Los escaneos publican una nueva instantánea completa del catálogo.

## Connect

WebSocket en `/api/v1/connect`, con el mismo Bearer y origen. El cliente envía primero `{type:"hello",version:1,role:"player",platform:"ios"|"android",deviceKey:"id-estable-del-dispositivo",name:"Mi móvil",capabilities:["playQueue"]}`. La clave del dispositivo debe tener entre 8 y 128 caracteres `A-Za-z0-9_-`.

El servidor devuelve `ready`. El reproductor publica `{type:"state",state:{track,position,duration,playing,buffering,canNext}}`. Aquí `track` incluye `{id,title,artist,album,artistId,albumId,coverUrl,duration}`. Los tiempos están en segundos.

Un controlador inicia con `{type:"hello",version:1,role:"controller"}` y recibe `devices`. Envía `{type:"command",id:"id-orden",deviceId,action,trackId?,position?}`. Las acciones son `play`, `pause`, `next`, `previous`, `seek`, `transfer` y `playQueue`. Esta última incluye `{queue:[track],index,shuffle}`. El reproductor ejecuta la orden y confirma con `{type:"ack",id,ok}`; en una transferencia añade `snapshot:{queue,index,position,repeat}` después de pausar. El controlador recibe `result`.

El servidor mantiene la presencia solo en memoria y separada por cuenta. Los controladores web que envíen `Origin` deben estar en `ALLOWED_ORIGINS`; los clientes nativos usan Bearer. Las pruebas de Connect documentan reconexión, caducidad, confirmaciones y transferencia de colas.

## Errores

```json
{"error":"NOT_FOUND","message":"No existe ese recurso.","requestId":"uuid"}
```

Estados principales: `400` petición inválida, `401` sesión inválida, `403` permisos, `404` recurso inexistente, `409` conflicto de orden o revisión, `413` límite excedido, `416` rango inválido, `422` archivo no procesable, `429` límite de acceso y `503` cola de conversiones llena.
