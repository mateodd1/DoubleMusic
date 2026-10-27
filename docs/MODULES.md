# Crear un módulo para DoubleMusic

DoubleMusic está centrado en tu biblioteca de archivos locales. Un módulo es una extensión opcional: un servidor HTTP que aporta un catálogo y entrega audio cuando el cliente lo consulta expresamente. Puede estar escrito en cualquier lenguaje y guardar sus propias credenciales, archivos o cachés. DoubleMusic gestiona las cuentas, sesiones, favoritos, playlists personales, permisos de reproducción y conexiones de los clientes móviles.

La instalación normal incluye únicamente la fuente `local`. No incluye ni activa conexiones con plataformas. El administrador puede conectar sus propios módulos con un archivo de configuración. Las fuentes configuradas están disponibles para las cuentas de esa instancia; cada cuenta conserva su biblioteca personal.

## Dos contratos separados

| Contrato | Quién lo implementa | Base HTTP | OpenAPI |
| --- | --- | --- | --- |
| API de clientes | DoubleMusic | `/api/v1` | [openapi.json](openapi.json), servido también en `/api/v1/openapi.json`. |
| API de módulos | El módulo del usuario | `/module/v1` | [module-openapi.json](module-openapi.json), servido por el core en `/api/v1/modules/openapi.json`. |

El móvil habla con DoubleMusic. DoubleMusic llama al módulo. El móvil recibe URLs de audio, imágenes y letras del mismo servidor DoubleMusic, sin conocer la URL privada ni el token del módulo. Un módulo no necesita implementar login, cuentas, biblioteca personal ni WebSocket.

## Probar el módulo de referencia

El repositorio contiene [examples/module/server.js](../examples/module/server.js). Genera cuatro segundos de audio de muestra y publica una pista, un álbum, un artista, una playlist, una portada y una letra. No utiliza ninguna plataforma. Sirve como ejemplo ejecutable del contrato y participa en las pruebas de integración.

Desde la raíz del repositorio:

```bash
mkdir -p music secrets
chmod 700 secrets
openssl rand -hex 32 > secrets/module-token
chmod 444 secrets/module-token
docker compose -f docker-compose.yml -f compose.modules.example.yml up -d --build
```

El directorio `secrets` protege el archivo en el host. Dentro de los contenedores se monta únicamente ese archivo en modo lectura para que el usuario sin privilegios pueda leerlo. `secrets/` está excluido de Git y del contexto de construcción de Docker.

El overlay es optativo: configura la biblioteca local y la fuente `example`, y arranca el módulo de referencia sin publicar su puerto en el host. Con una cuenta del core, consulta `GET /api/v1/sources` y busca `ejemplo` en `/api/v1/catalog/search?q=ejemplo&source=example`.

Para terminar el ejemplo y volver al servicio local:

```bash
docker compose -f docker-compose.yml -f compose.modules.example.yml stop example-module
docker compose -f docker-compose.yml up -d --build --remove-orphans
```

## Conectar tu módulo

Configura `SOURCES_FILE` con la ruta de un JSON que montes en el contenedor del core:

```json
{
  "version": 1,
  "defaultSource": "local",
  "sources": [
    {"id":"local","type":"local"},
    {
      "id":"personal",
      "name":"Mi módulo",
      "type":"http",
      "origin":"http://mi-modulo:4000",
      "tokenFile":"/run/secrets/module-token"
    }
  ]
}
```

Reinicia el core al cambiar la configuración. `origin` debe ser un origen HTTP o HTTPS sin ruta, query, fragmento ni credenciales. HTTP sirve para una red Docker privada; el módulo puede publicarse por HTTPS si está en otra máquina. No se siguen redirecciones.

`tokenFile` contiene un token de entre 16 y 512 caracteres `A-Za-z0-9._~-`. Puede ser una ruta absoluta o relativa al archivo JSON. DoubleMusic lo lee al arrancar y envía `Authorization: Bearer TOKEN_DEL_MODULO` en sus llamadas al módulo, incluidas imágenes y audio. El módulo debe validar ese token en todas sus rutas.

Este token es independiente de las sesiones del core. DoubleMusic no reenvía al módulo el Bearer de un móvil, cookies, contraseñas ni cabeceras arbitrarias. Tampoco expone el secreto ni la dirección privada en la API de clientes. Para rotarlo, actualiza el archivo de ambos servicios y reinícialos.

Se admiten hasta 16 fuentes con ids únicos de 1–32 caracteres `a-z`, `0-9` y `-`, empezando por una letra. El id `local` se reserva para `type: local`; admite `musicDir` si quieres especificar la carpeta dentro del contenedor. `all` está reservado para consultas agregadas. Los demás ids utilizan `type: http`. `defaultSource` debe señalar a una fuente configurada; si se omite, se usa `local` cuando exista, con independencia del orden de las entradas. Si no hay fuente local se usa la primera.

Como configuración avanzada, para usar solo módulos omite la entrada `local`: el servidor no necesita abrir ni escanear una carpeta de música. Las cuentas y bibliotecas siguen guardándose en `DATA_DIR`. El archivo de configuración es del operador; los clientes no pueden registrar URLs de módulos mediante la API.

## Identidad y modelos

Dentro del módulo, cada id es una cadena estable de entre 1 y 120 caracteres `A-Za-z0-9_-`, sin `:` ni rutas. Por ejemplo `track-123`. Debe ser único dentro de cada tipo de recurso y mantenerse estable entre reinicios. No pongas credenciales ni URLs temporales en los ids.

El core añade el namespace de la fuente: `personal:track-123`. Dos fuentes pueden tener una pista `track-123` sin colisión. Los clientes deben conservar y reenviar el id completo. DoubleMusic retira el namespace antes de llamar al módulo.

El campo `provider` de la API de clientes contiene el id de fuente por compatibilidad con el contrato v1. No es el nombre de una plataforma predefinida.

Ejemplo de pista que devuelve el módulo:

```json
{
  "id":"track-123",
  "title":"Mi canción",
  "duration":180.5,
  "artist":"Mi artista",
  "artistId":"artist-7",
  "artists":[{"id":"artist-7","name":"Mi artista"}],
  "album":"Mi álbum",
  "albumId":"album-4",
  "track":1,
  "disc":1,
  "coverId":"cover-4",
  "codec":"flac",
  "bitrate":850,
  "sampleRate":44100
}
```

Los campos mínimos de una pista son `id`, `title` y `duration`. La duración se expresa en segundos, el bitrate en kbps y la frecuencia en Hz. Omite `artistId`, `albumId`, `coverId` o `imageId` si no existen; cuando los incluyas deben ser ids válidos.

Los modelos completos y campos obligatorios están definidos en OpenAPI. Un álbum utiliza `{id,title,artist?,artistId?,year?,trackCount?,coverId?}`; una playlist, `{id,title,trackCount?,coverId?}`; un artista, `{id,name,imageId?}`.

`coverId` e `imageId` identifican el recurso binario de `/artwork/{id}`. DoubleMusic genera las URLs públicas del core. El contrato no utiliza `coverUrl`, `streamUrl` ni redirecciones hacia proveedores: las referencias a cualquier plataforma permanecen dentro del módulo.

## Rutas que implementa el módulo

Todas las rutas de esta tabla se añaden a `/module/v1` y requieren el token del módulo. Los cuerpos JSON utilizan UTF-8 y `Content-Type: application/json`.

| Método | Ruta | Respuesta |
| --- | --- | --- |
| GET | `/` | `{apiVersion:1,name,capabilities:{browse,search,audio,artwork,lyrics}}`. |
| GET | `/catalog/featured` | `{albums:[Album],artists:[Artist],playlists:[Playlist]}`, hasta 200 elementos por tipo. |
| GET | `/catalog/search?q=texto` | `{tracks:[Track],albums:[Album],artists:[Artist],playlists:[Playlist]}`, hasta 200 por tipo. |
| GET | `/catalog/albums` | Página `{items:[Album],total,limit,offset}`. |
| GET | `/catalog/artists` | Página `{items:[Artist],total,limit,offset}`. |
| GET | `/catalog/tracks` | Página `{items:[Track],total,limit,offset}`. |
| GET | `/catalog/playlists` | Página `{items:[Playlist],total,limit,offset}`. |
| GET | `/catalog/tracks/{id}` | Pista canónica con ese id. |
| GET | `/catalog/albums/{id}` | Álbum con `tracks:[Track]`. |
| GET | `/catalog/artists/{id}` | `{artist:Artist,albums:[Album],tracks:[Track]}`. |
| GET | `/catalog/artists/{id}/tracks` | Página `{items:[Track],total,limit,offset}`. |
| GET | `/catalog/playlists/{id}` | Playlist con `tracks:[Track]`. |
| GET / HEAD | `/audio/{id}` | Bytes de audio preparado por el módulo. |
| GET / HEAD | `/artwork/{id}` | Imagen binaria, con `Content-Type` correcto. |
| GET | `/lyrics/{id}` | TTML UTF-8 o `204` si no hay letra. |

`limit` está entre 1 y 500 y su valor por defecto es 200. `offset` es un entero no negativo, por defecto 0. Una página fuera de rango devuelve `items: []` y conserva el total real. Las fichas pueden contener hasta 5000 pistas. Si no tienes contenido destacado o playlists, devuelve arrays vacíos.

Las capacidades son booleanos que describen lo que ofrece el módulo. Un recurso no disponible devuelve `404`; una letra ausente devuelve `204`. El core no exige animaciones ni playlists automáticas de artista: conserva la compatibilidad mediante la portada estática y una colección de playlists de artista vacía.

Antes de usar un módulo, DoubleMusic comprueba su manifiesto y `apiVersion: 1`. Reutiliza esa comprobación durante 30 segundos; `/api/v1/sources` fuerza su actualización. Un módulo puede estar temporalmente caído sin impedir el arranque del core ni el uso de la biblioteca local.

## Audio, precarga y saltos

El módulo devuelve audio que el reproductor nativo pueda consumir directamente. La obtención, preparación y caché del archivo son responsabilidad del módulo. Puede reutilizar código propio o emplear FFmpeg; DoubleMusic transmite los bytes con backpressure y cancela la petición al desconectarse el cliente.

| Parámetro | Significado |
| --- | --- |
| `quality=original` | Calidad original; valor por defecto. |
| `quality=320`, `192`, `128` | Bitrate solicitado en kbps. |
| `layout=2` | fMP4 con índice `sidx` para los clientes móviles que lo usan. |
| `format=original` | Bytes del archivo original; solo con calidad original. |
| `format=mp4` | Audio en contenedor MP4. |
| `format=mp3` | Audio MP3. |
| `spatial` | Opción del cliente que el módulo puede interpretar; si no la ofrece, usa la variante normal. |

Sin `format`, el contrato selecciona `original` para calidad original y layout distinto de 2, y `mp4` en los demás casos. La referencia produce AAC en MP4 para las calidades numéricas. Si tu módulo no admite una combinación, devuelve `422`; no envíes silenciosamente JSON o una URL en una respuesta de audio.

Se recomienda admitir todos los formatos y opciones que necesiten tus clientes. El core valida los nombres de las opciones, pero no convierte el audio que recibe de un módulo ni garantiza que el dispositivo soporte su códec.

DoubleMusic reenvía `Range`, `If-Range`, `If-None-Match` e `If-Modified-Since`, además del método GET o HEAD. Envía `Accept-Encoding: identity`. El módulo debe responder con tamaño y rangos correspondientes a una representación estable del audio:

```http
GET /module/v1/audio/track-123?quality=192&layout=2
Authorization: Bearer TOKEN_DEL_MODULO
Range: bytes=0-65535
```

```http
HTTP/1.1 206 Partial Content
Content-Type: audio/mp4
Accept-Ranges: bytes
Content-Length: 65536
Content-Range: bytes 0-65535/6000000
ETag: "representacion-estable"
X-Audio-Codec: aac
X-Audio-Bitrate: 192
X-Audio-Sample-Rate: 48000
X-Audio-Duration: 180.5
```

HEAD conserva las cabeceras de GET y no envía cuerpo. Un rango imposible devuelve `416` con `Content-Range: bytes */TAMAÑO`. `If-Range` con el ETag de la representación permite saltar por el audio; no cambies ese ETag al actualizar únicamente la fecha de acceso de una caché.

El core conserva `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified` y las cuatro cabeceras `X-Audio-*` del ejemplo. No propaga cookies, ubicaciones de redirección ni otras cabeceras privadas del módulo. Para audio admite tipos `audio/*`, `application/ogg` y `video/mp4`; para imágenes, JPEG, PNG, WebP, GIF y AVIF.

## Selección de fuentes desde un cliente

`GET /api/v1/sources` devuelve la fuente predeterminada, disponibilidad y capacidades. Las listas paginadas utilizan `?source=personal` o `defaultSource` si no se especifica. Para enumerar todo, el cliente pagina cada fuente por separado.

La búsqueda, la portada y los estantes utilizan la fuente predeterminada: normalmente la biblioteca local. Conectar módulos no los incorpora automáticamente a esas consultas ni añade llamadas de red a la navegación local. Usa `source=personal` para consultar un módulo o `source=all` para combinar todas las fuentes en búsqueda y portada. Sus respuestas incluyen `sources:[{id,available,error?}]`, de modo que el cliente pueda mostrar resultados parciales si un módulo no responde. Los ids de fichas y audio ya identifican la fuente y no necesitan otro parámetro.

Favoritos, álbumes guardados y playlists personales admiten ids de cualquier fuente configurada. Una playlist puede mezclar pistas locales y de varios módulos. DoubleMusic resuelve los metadatos canónicos de la fuente antes de guardar: no confía en URLs ni títulos que envíe el móvil. Desconectar un módulo no borra los favoritos o snapshots personales existentes.

## Errores y límites

Un error del módulo utiliza su estado HTTP y un objeto como `{"error":"NOT_FOUND"}`. No incluyas credenciales ni enlaces privados en los mensajes. El core no reenvía el cuerpo de error del módulo: `404` se conserva como recurso ausente, `422` indica audio no soportado y los demás fallos se presentan como `503 SOURCE_UNAVAILABLE`. Un JSON, id o tipo de contenido que incumpla el contrato produce `502 SOURCE_INVALID_RESPONSE`.

Los documentos JSON del módulo están limitados a 8 MiB, el manifiesto a 16 KiB y las letras a 2 MiB. El tiempo de respuesta del manifiesto es de 5 segundos y el de JSON/letras de 15 segundos. El audio utiliza un timeout de inactividad de 5 minutos y se transmite sin cargar el archivo completo en memoria.

## Validar tu implementación

1. Comprueba el manifiesto con el token de módulo y valida tus respuestas contra [module-openapi.json](module-openapi.json).
2. Conecta el módulo mediante `SOURCES_FILE` y confirma su disponibilidad en `/api/v1/sources` usando una sesión del core.
3. Recorre una búsqueda, álbum, artista y pista; comprueba que todos los ids públicos incluyen tu namespace.
4. Guarda un favorito y una playlist y reproduce con GET, HEAD, Range e If-Range desde DoubleMusic.
5. Detén tu módulo: el core debe seguir autenticando y sirviendo las demás fuentes.

`npm test` ejecuta el módulo de referencia y comprueba esos recorridos, aislamiento de credenciales, errores, redirecciones, límites de acceso y compatibilidad con la biblioteca local. Puedes tomar [test/modules.test.js](../test/modules.test.js) como guía para probar tu propio servidor HTTP.
