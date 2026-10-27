# DoubleMusic

Servidor para organizar y reproducir tu biblioteca de archivos de música desde tus clientes móviles. DoubleMusic indexa una carpeta local, lee sus metadatos y sirve el audio desde tu servidor. Puedes habilitar conexiones externas opcionales mediante una API HTTP documentada.

Incluye usuarios con sesiones revocables, favoritos, playlists personales, álbumes guardados, artistas seguidos, playlists M3U, portadas y letras locales, streaming con saltos por rangos de bytes y control entre dispositivos mediante Connect.

La biblioteca local es el centro del servidor: el catálogo, la portada y la búsqueda utilizan tus archivos por defecto y funcionan sin acceso a Internet una vez instalado. Las conexiones externas son optativas, están desactivadas por defecto y se consultan expresamente por API. El proyecto está orientado a música propia o autorizada y a servicios utilizados con los permisos correspondientes; consulta [el alcance de uso](docs/USAGE.md). El núcleo utiliza Node.js 22.13 o posterior, SQLite integrado, FFmpeg/FFprobe y `ws` para WebSocket.

## Inicio con Docker

```bash
git clone https://github.com/mateodd1/DoubleMusic.git
cd DoubleMusic
cp .env.example .env
mkdir -p music
```

Edita `.env`: `MUSIC_DIR` es la carpeta del host que contiene tu música y `PUBLIC_URL` es el origen accesible desde el móvil, por ejemplo `https://musica.tudominio.es`. Coloca archivos en esa carpeta y arranca:

```bash
docker compose up -d --build
```

Crea la primera cuenta con una contraseña que introduzcas por terminal:

```bash
read -r -s -p 'Contraseña: ' MUSIC_PASSWORD; printf '\n'
printf '%s\n' "$MUSIC_PASSWORD" | docker compose exec -T doublemusic node cli.js add admin --admin --password-stdin
unset MUSIC_PASSWORD
```

En el cliente móvil configura **la misma URL de `PUBLIC_URL`, sin añadir `/api/v1`**, e inicia sesión con esa cuenta. El proxy HTTPS debe reenviar todas las rutas a este servicio, incluidas las conexiones WebSocket. Para pruebas de red local puede usarse `http://IP_DEL_SERVIDOR:3000` si el cliente permite HTTP.

La música se monta en modo lectura. El volumen Docker `library-data` guarda cuentas, bibliotecas, índice y caché de audio. El primer escaneo termina antes de abrir el puerto; una biblioteca grande puede tardar. Después el índice se actualiza cada cinco minutos, reutilizando los metadatos de archivos que no cambian.

## Biblioteca

Se leen las etiquetas de título, artista, artista del álbum, álbum, año, disco y número de pista. Si faltan, se usa el nombre del archivo y la estructura `Artista/Álbum/archivo`.

- Audio: MP3, FLAC, M4A, AAC, OGG, Opus, WAV, AIFF, WMA, APE, ALAC, M4B y WavPack, si FFmpeg reconoce el archivo.
- Portadas: `cover.jpg`, `cover.jpeg`, `cover.png`, `folder.jpg`, `folder.png`, `front.jpg`, `front.png` o imagen incrustada en la pista.
- Letras: archivos `.ttml`, `.lrc` o `.txt` con el mismo nombre base que el audio. LRC y texto se entregan como TTML.
- Playlists: `.m3u` y `.m3u8` con rutas a archivos de la biblioteca, relativas a la ubicación de la lista. Las entradas deben señalar a pistas ya indexadas.

Se omiten carpetas ocultas, enlaces simbólicos y archivos que no puedan leerse. Los ids son opacos y llevan el prefijo `local:`. El id de una pista se conserva al cambiar sus etiquetas; moverla o renombrarla crea otro id.

## Reproducción y clientes

La API usa `/api/v1`. Los clientes deben conservar los ids completos y enviar `Authorization: Bearer TOKEN` también en las peticiones de audio, HEAD y Range. El catálogo, la sesión y el audio comparten origen.

En la fuente local, `GET /api/v1/audio/{id}` sirve el archivo original. Con `layout=2` entrega fMP4 con índice `sidx`, adecuado para clientes móviles que usan ese formato. Las calidades `320`, `192` y `128` convierten el audio a AAC en el servidor; `format=mp3` permite solicitar MP3. Las conversiones se reutilizan desde la caché. Para una fuente de módulo, el módulo prepara el audio solicitado y el core lo transmite.

En fMP4, la calidad `original` conserva AAC, ALAC, FLAC y Opus. Los demás códecs se convierten a AAC a 320 kbps. Para obtener siempre los bytes originales se usa `quality=original&format=original`. La compatibilidad final del códec depende del reproductor del móvil.

Este servidor implementa el contrato v1 de DuoMusic; el cliente debe permitir configurar el origen del servicio y conservar ids completos `fuente:id`; la biblioteca local utiliza `local:`. La documentación de integración está en [docs/API.md](docs/API.md). Las pruebas HTTP validan el contrato y los archivos de audio; no sustituyen la comprobación en cada versión de las apps móviles.

## Activar o desactivar funciones

En el JSON indicado por `SOURCES_FILE`:

```json
{
  "version": 1,
  "library": { "enabled": true },
  "external": { "enabled": false }
}
```

| `library.enabled` | `external.enabled` | Resultado |
| --- | --- | --- |
| `true` | `false` | Biblioteca local; configuración predeterminada. |
| `true` | `true` | Biblioteca local con conexiones externas opcionales. |
| `false` | `true` | Solo las conexiones externas que hayas configurado. |
| `false` | `false` | Cuentas y API disponibles con catálogo vacío. |

La configuración se aplica al reiniciar el servicio. Desactivar la biblioteca evita el escaneo; desactivar las conexiones externas impide cargar sus credenciales o consultarlas desde DoubleMusic. Los archivos, las cuentas y las bibliotecas personales se conservan. `GET /api/v1/sources` informa de la configuración efectiva y de las fuentes activas.

Para montar tu configuración con Compose, crea `compose.config.yml`:

```yaml
services:
  doublemusic:
    environment:
      SOURCES_FILE: /config/settings.json
    volumes:
      - ./settings.json:/config/settings.json:ro
```

Guarda el JSON en `settings.json` y aplica los cambios con `docker compose -f docker-compose.yml -f compose.config.yml up -d --force-recreate doublemusic`. Para una conexión externa, añade su definición en `sources` y habilita `external.enabled`; cada entrada admite también `enabled: false` para desactivarla individualmente. La [guía de extensiones](docs/MODULES.md) detalla ese contrato y la configuración.

## Conexiones externas por API

- [API para clientes móviles](docs/API.md) y [contrato OpenAPI](docs/openapi.json).
- [Guía para crear módulos](docs/MODULES.md) y [contrato OpenAPI de módulos](docs/module-openapi.json).
- [Módulo de referencia ejecutable](examples/module/server.js), con audio de muestra generado localmente.

Conectar un módulo mantiene la navegación habitual en tu biblioteca local. Para consultar una extensión se usa `source=ID`; `source=all` permite buscar o mostrar contenido de todas las fuentes. Los módulos no copian ni descargan automáticamente su catálogo a la carpeta local.

Cada módulo implementa `/module/v1`: catálogo, búsqueda, pistas, audio, imágenes y letras. DoubleMusic mantiene las cuentas, permisos, favoritos y playlists; los clientes siguen usando `/api/v1`. El operador configura las conexiones mediante `SOURCES_FILE` y las habilita con `external.enabled`. No hay que modificar el núcleo ni añadir dependencias de una plataforma al servidor.

Los contratos también se sirven en `/api/v1/openapi.json` y `/api/v1/modules/openapi.json`. El ejemplo y su configuración optativa están explicados en [MODULES.md](docs/MODULES.md).

## Configuración

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `SOURCES_FILE` | vacío | Configuración JSON de fuentes. Sin ella, solo se carga la biblioteca local. Ver [módulos](docs/MODULES.md). |
| `MUSIC_DIR` | `./music` | Carpeta de música del host en Compose. |
| `PORT` | `3000` | Puerto publicado en el host en Compose. |
| `BIND_ADDRESS` | `0.0.0.0` | Dirección del host donde publicar el puerto. |
| `PUBLIC_URL` | `http://localhost:3000` | Origen público, sin rutas; genera las URLs de portadas y audio. |
| `SCAN_INTERVAL_SECONDS` | `300` | Intervalo del escaneo; `0` desactiva el periódico. |
| `CACHE_MAX_MB` | `2048` | Límite aproximado de la caché; se retiran las variantes menos utilizadas. |
| `TRUST_PROXY` | `false` | Aceptar el protocolo reenviado por un proxy de confianza para cookies. |
| `SECURE_COOKIES` | `false` | Exigir HTTPS para la cookie de sesión. |
| `ALLOWED_ORIGINS` | `PUBLIC_URL` | Orígenes permitidos de controladores web Connect, separados por comas. |

Una conversión se completa antes de servirla, lo que permite conocer su tamaño y atender saltos exactos. La primera petición puede tardar; las siguientes usan el archivo preparado. Se ejecutan como máximo dos conversiones a la vez. El archivo recién generado puede superar por sí solo el límite de caché y se conserva hasta una limpieza posterior.

## Cuentas y mantenimiento

```bash
docker compose exec doublemusic node cli.js list
docker compose exec doublemusic node cli.js revoke usuario
# add y passwd reciben la contraseña por stdin, como en el ejemplo inicial.
docker compose exec -T doublemusic node cli.js passwd usuario --password-stdin
docker compose exec doublemusic node cli.js del usuario
docker compose logs --tail=100 doublemusic
```

Las fuentes se configuran para la instancia; las cuentas son independientes y sus favoritos, playlists y sesiones se guardan por usuario. Las playlists pueden mezclar pistas de varias fuentes. Cambiar la contraseña revoca sus sesiones. Los administradores pueden gestionar cuentas y forzar escaneos por API. Para hacer una copia coherente, detén el contenedor y copia el volumen `library-data`; la carpeta de música se respalda por separado.

## Ejecución directa y pruebas

Con Node.js 22.13+ y FFmpeg/FFprobe instalados:

```bash
npm ci --ignore-scripts
MUSIC_DIR=/ruta/musica DATA_DIR=/ruta/datos PUBLIC_URL=http://localhost:3000 npm start
npm test
```

`DATA_DIR` debe quedar fuera de la biblioteca. Para crear cuentas en ejecución directa utiliza el mismo `DATA_DIR` con `node cli.js`. Las pruebas generan su propio audio y sus cuentas temporales, y comprueban catálogo, sesiones, bibliotecas, Connect, rangos, fMP4, conversiones y límites de acceso al sistema de archivos.

También pueden ejecutarse sobre la imagen Docker, sin conectividad de red:

```bash
docker build -t doublemusic:test .
docker run --rm --network none -v "$PWD/test:/app/test:ro" doublemusic:test npm test
```
