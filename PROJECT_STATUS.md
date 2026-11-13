# PROJECT_STATUS

## Arquitectura actual
Monorepo npm workspaces. `server/` (Node, Express 5, TypeScript, SQLite con better-sqlite3) expone `/api/*`. `client/` (React, TypeScript, Vite) con proxy `/api` -> `localhost:4000`. Todo local: FFmpeg (corte, render, audio), Faster-Whisper (proceso Python externo, `python/transcribe.py`). Cola de trabajos en memoria con límite `MAX_CONCURRENT_JOBS`, reintento y registro en tabla `jobs`.

Flujo: subir un vídeo o descargarlo desde un enlace autorizado de YouTube -> ffprobe -> `POST /projects/:id/analyze` (transcribe una vez y cachea en `storage/transcripts/<id>.json`, busca clips con reglas locales, guarda en `clips`) -> configurar cada clip -> `POST /clips/:id/render` (corte + composición 9:16 + subtítulos ASS opcionales + loudnorm) -> descarga MP4/SRT/ZIP. Los lives se capturan hasta detenerlos desde la página del proyecto, donde se muestra tiempo transcurrido, tamaño guardado y una barra animada.

## Estructura de carpetas
```
server/src/  config.ts db.ts system.ts queue.ts media.ts analyze.ts subs.ts pipeline.ts routes.ts index.ts
client/src/  App.tsx api.ts styles.css pages/{Dashboard,Create,Projects,ProjectDetail,Settings,Placeholder}.tsx
python/      transcribe.py capture_youtube.py requirements.txt
storage/{uploads,transcripts,work,exports}  data/clipforge.db   (generados, fuera de git)
```

## Funcionalidades terminadas
- Fase 1: estructura, config, SQLite, comprobación de entorno, UI base.
- Fase 2: subida (MP4, MOV, MKV, WEBM, AVI, M4V), validación, ffprobe (duración, resolución, audio), proyectos listados y detalle, borrar proyecto.
- Fase 3: transcripción local con palabras y tiempos, caché (no se repite al cambiar duraciones o estilo), progreso.
- Fase 4: finalistas sin solapes y puntuación 0-100 desglosada en gancho, interacción, valor y posibilidad de compartir. Ollama puede reordenar y titular hasta 40 finalistas, y dar una razón corta; ante fallo o falta de Ollama se usa el análisis local.
- Fase 5: subtítulos palabra por palabra opcionales con palabra activa resaltada y 7 plantillas. El modo de edición tipo Ibai es una opción independiente: gameplay a pantalla completa con recorte vertical centrado, sin facecam ni bandas borrosas, más subtítulos grandes con resaltado amarillo.
- Entrada de YouTube y Kick: descarga de videos/VODs y captura de lives; requiere confirmar autorización de uso y `yt-dlp` instalado. El importador usa yt-dlp con selección de mejor video/audio, merge a MP4, fragmentos concurrentes e impersonation Chrome (requiere `curl_cffi`).
- Composición dividida: cámara arriba y contenido abajo, 50/50 por defecto (1080x960 cada sección); la altura de la cámara se puede personalizar entre 30% y 70%. FFmpeg genera la composición final y conserva el audio sincronizado.
- Detección local de facecam con MediaPipe/BlazeFace muestreando el clip; sigue los cambios de ubicación detectados. La detección estima el recuadro alrededor del rostro, no garantiza hallar los bordes exactos de una ventana. Si falla, se puede seleccionar manualmente el área en el video original.
- Modo de edición "Seguimiento de cara": analiza el clip completo, interpola el centro del rostro y aplica un zoom vertical suave para mantener a la persona encuadrada.
- Análisis de voz mejorado: divide transcripciones por pausas y frases, limita ventanas demasiado largas y recorta muletillas en los bordes antes de puntuar candidatos; Faster-Whisper usa CUDA automáticamente cuando está disponible, con VAD y beam search para afinar palabras y tiempos.
- Higgsfield API opcional: desde Configuración se conecta, reemplaza o elimina la clave completa (no se expone ni se devuelve al cliente); se guarda como `HF_API_KEY` en el `.env` local. La interfaz indica que guardar la clave no verifica su validez.
- Desde un clip renderizado se puede solicitar una intro motion graphics vertical de 5 s con sonido, consultar el progreso con backoff, cancelar la solicitud remota y añadir 1,35 s al inicio del siguiente render. Guarda `request_id` y `cancel_url` solo en SQLite del servidor. Generar requiere saldo y confirmación explícita.
- Vista previa reproducible del encuadre y configuración individual por clip; se puede cambiar y volver a renderizar sin volver a cargar la fuente.
- Sección Editor habilitada: muestra los proyectos con clips y enlaza al espacio de personalización de cada uno. Los análisis y renders muestran la etapa actual y el progreso agregado.
- Potencial viral: nivel bajo/medio/alto mostrado junto a la puntuación heurística 0-100; es una orientación, no una predicción garantizada.
- Fase 8 (parcial): MP4 H.264 vertical Full HD 1080×1920, escalado Lanczos, libx264 slow CRF 16 y AAC 320 kb/s a 48 kHz; conserva la frecuencia de la fuente hasta 60 fps, aplica loudnorm y permite descargar MP4/SRT/ZIP.

## Funcionalidades pendientes
- Análisis con Ollama (hoy solo reglas locales; Ollama es opcional).
- Mejora futura: separar con mayor precisión el recuadro de webcam del contenido cuando hay superposición o varios rostros; la detección actual se basa en rostro y ofrece selección manual como respaldo.
- Fase 7: editor (ajustar inicio/fin, editar texto de subtítulos), eliminación de silencios, música, efectos, emojis y corrección de color. El seguimiento de cara y la intro de Higgsfield están disponibles como opciones de edición.
- Plantillas: vistas previas. Dashboard: tarjetas de proyecto recientes.
- Fase 9: pruebas automáticas y optimización.

## Dependencias instaladas
server: express, cors, dotenv, better-sqlite3 ^12, multer, archiver ^8; dev: typescript, tsx, @types/*.
client: react, react-dom, react-router-dom, lucide-react; dev: vite, @vitejs/plugin-react.
Python: `python -m pip install -r python/requirements.txt` instala faster-whisper, MediaPipe, yt-dlp y curl_cffi. Sistema: FFmpeg/FFprobe (necesarios para leer, remuxear y renderizar medios); Whisper descarga el modelo de transcripción al primer uso y MediaPipe descarga BlazeFace en `storage/models/` al detectar la cámara.

## Uso de enlaces de YouTube
- Solo procesar contenido propio o para el que se tenga autorización.
- El live se graba hasta pulsar “Detener captura y preparar proyecto”; vigilar el espacio libre en disco.
- En modo dividido, la cámara queda arriba y el contenido abajo. La detección automática puede requerir selección manual, especialmente si el rostro es pequeño, hay varias personas o el recuadro cambia mucho.

## Errores conocidos
- Verificado en Windows: `npm run build`, composición split 1080x1920 con audio sincronizado, render con y sin subtítulos/SRT, y detección sobre una muestra local. No verificado: transcripción con voz real ni aspecto de la UI en navegador.
- Proxy de Vite fijo a `127.0.0.1:4000`.

## Última fase completada
Fases 1 a 5, composición/captions configurables, seguimiento de cara, análisis de transcripción mejorado, integración opcional Higgsfield y parte de la 8.

## Próxima tarea
Mejorar el seguimiento del recuadro de cámara y continuar el editor de clips (Fase 7).
