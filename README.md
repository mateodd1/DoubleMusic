# DoubleMusic

API de música local para clientes móviles DuoMusic que permiten indicar la URL de su servidor. Indexa una carpeta de audio y sirve el catálogo, las cuentas y la reproducción desde un único servicio. El audio se prepara en el servidor.

Incluye usuarios con sesiones revocables, favoritos, playlists personales, álbumes guardados, artistas seguidos, playlists M3U, portadas y letras locales, streaming con saltos por rangos de bytes y control entre dispositivos mediante Connect.

El servidor funciona sin acceso a Internet una vez instalado. Sus componentes son Node.js 22.13 o posterior, SQLite integrado en Node.js, FFmpeg/FFprobe y el paquete `ws` para WebSocket. Todos los datos se guardan en el servidor.

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

`GET /api/v1/audio/{id}` sirve el archivo original. Con `layout=2` entrega fMP4 con índice `sidx`, adecuado para clientes móviles que usan ese formato. Las calidades `320`, `192` y `128` convierten el audio a AAC en el servidor; `format=mp3` permite solicitar MP3. Las conversiones se reutilizan desde la caché.

En fMP4, la calidad `original` conserva AAC, ALAC, FLAC y Opus. Los demás códecs se convierten a AAC a 320 kbps. Para obtener siempre los bytes originales se usa `quality=original&format=original`. La compatibilidad final del códec depende del reproductor del móvil.

Este servidor implementa el contrato v1 de DuoMusic; el cliente debe permitir configurar el origen del servicio y utilizar ids `local:`. La documentación de integración está en [docs/API.md](docs/API.md). Las pruebas HTTP validan el contrato y los archivos de audio; no sustituyen la comprobación en cada versión de las apps móviles.

## Configuración

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
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

Las cuentas son independientes: sus favoritos, playlists y sesiones se guardan por usuario. Cambiar la contraseña revoca sus sesiones. Los administradores pueden gestionar cuentas y forzar escaneos por API. Para hacer una copia coherente, detén el contenedor y copia el volumen `library-data`; la carpeta de música se respalda por separado.

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
