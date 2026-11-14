# SEÑA-TRACK

Aplicación web para enseñar y reconocer señas con la cámara, construir frases y comparar filtros de seguimiento.

## Funciones

- Detección sincronizada de ambas manos y rostro con MediaPipe Tasks Vision 0.10.14. Los coeficientes faciales, las relaciones geométricas y la orientación de la cabeza intervienen en el reconocimiento, sin inferir emociones ni identidad personal.
- Un único formulario **Enseñar una seña** y botón **Capturar seña**. El usuario elige las manos y/o el rostro requeridos, pero no el tipo de seña: el sistema analiza la secuencia temporal para guardar automáticamente una postura o un movimiento completo.
- Biblioteca visual unificada por nombre, con conteo de capturas; las categorías internas estática/dinámica se conservan para reconocimiento y compatibilidad con ejemplos anteriores.
- Filtros manuales de primer orden y segundo orden amortiguado para landmarks y rasgos holísticos. La comparación incluye distancias diagnósticas, una gráfica temporal seleccionable de señales raw/EDO, estimaciones de vibración/retardo y una superposición opcional de coordenadas en cámara.
- Controles de tolerancia y duración, frase acumulada y lectura automática o manual, controles de espacio, borrar y limpiar. No hay gestos preprogramados ni señas de demostración.
- Importación explícita y exportación de señas en JSON; las bibliotecas antiguas de `localStorage` no se cargan automáticamente.
- Registro, inicio, restauración y cierre de sesión con Supabase Auth; recuperación de contraseña por correo.
- Biblioteca de señas privada sincronizada por cuenta. El reconocimiento trabaja con los ejemplos ya cargados en memoria.
- Importación confirmada de la biblioteca local o de archivos JSON; exportación JSON conservada.

La comparación muestra distancias a ejemplos guardados y su diferencia con la misma referencia; no es exactitud validada ni probabilidad de acierto. La gráfica permite seleccionar coordenadas de manos, dedos, rostro y orientación de cabeza. La vibración se mide como RMS del desplazamiento de los 21 landmarks entre cuadros consecutivos, normalizado por el tamaño de palma raw, durante segmentos quietos; el retardo se estima por correlación de velocidades x/y de muñeca durante movimiento y no es latencia de cómputo. La interfaz indica si la vibración observada mejora, empeora o no cambia. Estas mediciones no afirman mayor exactitud.

La interfaz tiene dos vistas SPA: **Traductor** reúne enseñanza, biblioteca, cámara, frase y comparación en vivo; **Ajustes** contiene sensibilidad, selección entre filtros EDO de primer y segundo orden, parámetros, fórmulas, biblioteca, voz y evaluación experimental desplegable. Durante el reconocimiento, MediaPipe alimenta siempre el filtro EDO seleccionado y solo sus descriptores procesados pueden controlar la traducción. El resultado sin filtro se muestra exclusivamente para comparación experimental y nunca escribe palabras. Las preferencias antiguas con el modelo desactivado se normalizan al filtro de primer orden sin tocar las capturas ni sus coordenadas originales. Los enlaces históricos `#edo` se redirigen a Ajustes. Se puede navegar con los enlaces superiores y el historial del navegador. La cámara y el reconocimiento se detienen al salir del Traductor; una captura en curso se cancela sin guardarse. Durante una captura, el sistema conserva cuadros raw/filtrados sincronizados, landmarks y datos faciales requeridos, y solo guarda el ejemplo si detecta una postura estable o una trayectoria completa con final estable. La detección usa umbrales heurísticos provisionales y todavía necesita validación con capturas representativas; las pruebas sintéticas no establecen precisión real.

El filtro de primer orden integra `dy/dt = (u - y) / tau` con Euler explícito y subpasos `h <= tau/4`. El de segundo orden integra `a = omegaN²*(u-y) - 2*zeta*omegaN*v` mediante Euler semiimplícito, actualizando primero `v` y luego `y`, con `h <= min(0.1/omegaN, 0.1/(2*zeta*omegaN))`. Ambos usan el tiempo monotónico real entre cuadros, conservan estado independiente por mano, rostro, punto y eje, se inicializan desde la primera medición válida y reinician tras una pérdida o pausa superior a 500 ms. El filtro no altera el video. La rama sin filtro sigue siendo la salida de MediaPipe y puede incluir su propio procesamiento interno; en vivo solo se usa para la comparación. Cada captura conserva sus coordenadas sincronizadas, parámetros y metadatos del método/versionado del filtro.

Al cambiar el modelo o sus parámetros, las referencias holísticas v2 se reprocesan en memoria desde sus cuadros raw para que coincidan con la configuración activa; no se actualizan registros remotos. La misma EDO se aplica a los 32 rasgos faciales extraídos por cuadro, además de suavizar landmarks. El yaw y el roll se filtran por el camino angular más corto y sus distancias usan diferencias circulares para evitar saltos artificiales entre −π y +π. Ejemplos heredados que no incluyen suficientes cuadros raw mantienen compatibilidad con sus descriptores guardados, pero la comparación se declara no disponible si no existen referencias raw pareadas. No se inventan coordenadas ni se reemplazan los originales.

La comparación de distancias selecciona un mismo ejemplo guardado por etiqueta y cuadro raw/EDO sincronizados; la comparación y las métricas costosas de seguimiento se actualizan como máximo cinco veces por segundo durante el reconocimiento para limitar trabajo repetido. La diferencia se muestra en unidades de distancia y solo indica cercanía a la referencia, no un acierto ni una mejora validada. En modo automático la etiqueta se presenta como candidata y no confirma la intención del usuario. La interfaz también informa el cambio relativo de vibración calculado solo durante segmentos de baja velocidad raw y un retraso añadido estimado mediante correlación temporal de la trayectoria de la muñeca. La correlación centra por separado cada trayectoria antes de compararlas y usa las marcas de tiempo observadas para convertir el desfase a milisegundos. Son mediciones observacionales de la sesión, no resultados garantizados ni el tiempo de cómputo o de confirmación de seña; cuando los datos no permiten calcularlas, se indica así.

La clasificación compara las dos clases distintas más cercanas. Si su diferencia absoluta y relativa son simultáneamente inferiores a los márgenes de rechazo, informa **Reconocimiento ambiguo** y no añade una etiqueta a la frase. Los márgenes iniciales (0.04 unidades de distancia y 0.08 relativas) son provisionales y ajustables en los controles avanzados; no son umbrales estadísticamente calibrados. Una sola clase puede aceptarse si pasa la tolerancia configurada. La puntuación mostrada no es una probabilidad.

### Procesamiento temporal de MediaPipe verificado

La app fija `@mediapipe/tasks-vision` y sus archivos WASM en **0.10.14**; los modelos descargados son `hand_landmarker_float16_v1` y `face_landmarker_float16_v1` (el bundle facial también aporta blendshapes). En ambas tareas se usa `runningMode: "VIDEO"` y la misma instancia del detector para los dos modos de reconocimiento. La implementación web de esa versión convierte `VIDEO` en `use_stream_mode`. En las gráficas Tasks v0.10.14, manos y rostro conservan regiones de interés entre cuadros y vuelven a ejecutar detección de palma/cara cuando el seguimiento no alcanza la cantidad configurada. El grafo de manos no añade un filtro temporal explícito a los landmarks.

El caso facial sí está confirmado en el código de esa versión: con una sola cara en modo de flujo, `FaceLandmarkerGraph` activa `smooth_landmarks`; `FaceLandmarksDetectorGraph` aplica `LandmarksSmoothingCalculator` con One Euro (`min_cutoff=0.05`, `beta=80`, `derivate_cutoff=1`). El cálculo de blendshapes consume también la lista facial ya suavizada. Por tanto, las salidas faciales que recibe la app tienen suavizado temporal interno; el código del grafo de manos confirma seguimiento temporal, no suavizado One Euro de sus landmarks. One Euro deriva su cutoff de la velocidad estimada y filtra con paso bajo; es un filtro temporal de primer orden adaptativo, no las EDO de Seña-Track. No extrapolamos estos parámetros faciales a manos, ni a las matrices faciales, cuya ruta exacta no se ha medido por separado.

Los filtros EDO de Seña-Track son una etapa adicional posterior a MediaPipe: primer orden `dy/dt=(u-y)/tau` o segundo orden amortiguado, ambos independientes por identidad de mano/rostro y coordenada; también se filtran los 32 rasgos faciales derivados. En consecuencia hay doble suavizado facial cuando se activa EDO, pero no se ha demostrado con capturas etiquetadas que sea perjudicial o beneficioso. No se han ajustado parámetros ni se afirma una mejora de precisión sin un corpus real y una validación independiente. Fuentes fijadas: [modo VIDEO en la implementación web v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/tasks/web/vision/core/vision_task_runner.ts), [grafo HandLandmarker v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarker_graph.cc), [grafo FaceLandmarker v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/tasks/cc/vision/face_landmarker/face_landmarker_graph.cc), [grafo detector facial v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/tasks/cc/vision/face_landmarker/face_landmarks_detector_graph.cc), [opciones del suavizador v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/calculators/util/landmarks_smoothing_calculator.proto) y [implementación One Euro v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/util/filtering/one_euro_filter.cc).

El contador de **Mis señas** cuenta registros de captura únicos por seña, deduplicados por su identificador de captura o de sincronización; no usa la fecha como identificador, porque distintas capturas pueden compartirla. En muestras heredadas sin esos identificadores, cuenta cada registro como un ejemplo. No infiere capturas a partir de la cantidad de cuadros de una muestra.

El botón **Iniciar reconocimiento** activa el reconocimiento global de señas guardadas estáticas, dinámicas y faciales; vuelve a pulsarlo para detenerlo. Para enseñar una seña, escribe su nombre, elige los componentes requeridos y pulsa **Capturar seña**. Mantén una postura o realiza el movimiento completo; no hay que indicar el tipo.

Las capturas nuevas guardan coordenadas originales, componentes requeridos, lateralidad, presencia, marcas de tiempo, características faciales y manuales, y metadatos del filtro EDO en el formato v2 existente. Las secuencias dinámicas incluyen trayectorias de muñecas y cabeza relativas al inicio y normalizadas por la escala correspondiente, además de expresiones faciales cuando se requieren. La clasificación interna mantiene las representaciones estática y dinámica existentes; la biblioteca las agrupa visualmente sin convertir ni sobrescribir datos. Las capturas antiguas de ambos tipos siguen siendo importables y reconocibles, y no se modifican muestras remotas al cambiar este flujo. La comparación holística pondera explícitamente forma manual, posición relativa y rostro; el rostro pesa 0,5 cuando se combina con manos, su vector tiene escala 2,5 y el peso de la forma manual y la posición se reparte en 0,35/0,15. Estas ponderaciones son parámetros de comparación, no probabilidades.

## Estructura

```text
index.html
css/styles.css
js/
  app.js          # Composición e inicialización
  auth.js         # Supabase Auth y cambios de sesión
  supabaseClient.js # Cliente compartido y carga del SDK de navegador
  supabaseConfig.js # URL y clave pública del proyecto (rellenar)
  sampleFormat.js # Validación y formato versionado de muestras
  camera.js       # Permisos, modelos, detección, dibujo y ciclo de cámara
  holistic.js     # Características faciales, normalización y ponderaciones
  recognition.js  # Comparación de componentes guardados y DTW sincronizado
  training.js     # Captura unificada y análisis temporal
  unifiedCapture.js # Clasificación automática de postura/movimiento
  navigation.js   # Enrutamiento SPA de Traductor y Ajustes; conserva #edo legado
  sampleCount.js  # Conteo único de capturas guardadas
  storage.js      # Persistencia, migración, importación y exportación
  ui.js           # Eventos y actualización de interfaz
  filters.js      # Filtros EDO de primer y segundo orden
supabase/
  migrations/     # Esquema, RLS y bucket privado versionados
assets/images/    # Logo e imágenes de acceso
```

La app usa módulos ES sin proceso de compilación. MediaPipe se descarga desde jsDelivr con la versión fijada `0.10.14`; los modelos se cargan desde Google Cloud Storage. La cámara necesita un contexto seguro: `localhost` o HTTPS.

Supabase JS se carga en el navegador desde esm.sh cuando se completa la configuración. No se lee `.env` ni se expone ninguna clave secreta. La clave `publishable` es pública por diseño; los permisos dependen de Auth, RLS y las políticas del bucket.

## Ejecutar localmente

Desde la carpeta del proyecto, inicia un servidor estático:

```bash
python3 -m http.server 8000
```

Abre <http://localhost:8000>. No abras `index.html` directamente desde el sistema de archivos, porque los módulos y el acceso a la cámara pueden quedar bloqueados.

En GitHub Pages se puede publicar la carpeta raíz del proyecto; las referencias a CSS, JavaScript e imágenes son relativas y funcionan dentro de una subcarpeta.

Ejecuta las pruebas numéricas de los filtros y de la comparación con `npm test` (requiere Node.js; la app en navegador no requiere compilación). Incluyen una comparación reproducible de los tres modos EDO con las mismas trazas sintéticas quieta y dinámica. Esa medición caracteriza estabilidad/seguimiento en el fixture, no precisión de reconocimiento real.

### Evaluación reproducible con capturas independientes

El panel del Traductor permite grabar capturas etiquetadas por verdad de terreno, tipo (estático/dinámico), partición, sesión y participante seudónimos. Guarda coordenadas en memoria de la sesión, sin enviar los clips a Supabase ni almacenar video. Cada partición se exporta como JSON; usa el botón tres veces con entrenamiento, validación y prueba seleccionados. Las capturas dinámicas solo se aceptan si la trayectoria finaliza de forma estable. Las referencias de entrenamiento se reprocesan para comparar, sobre las mismas capturas de validación y prueba, raw, EDO de primer orden y EDO de segundo orden.

El evaluador compara exactitud, precisión/recall/F1 por clase, macro-F1, matriz de confusión, falsos positivos, rechazos, ambigüedad y latencia usando tres archivos separados: entrenamiento, validación y prueba final. También separa métricas por tipo y componentes requeridos (incluido rostro), para facilitar el análisis de posturas estáticas, movimientos y características faciales.

```bash
npm run evaluate -- entrenamiento.json validacion.json prueba.json --session-split
```

`entrenamiento.json` es la partición de entrenamiento exportada por la herramienta y contiene referencias holísticas v2 con `captureId` y cuadros raw. Los otros dos archivos contienen `{"samples":[...]}`. Cada registro requiere `captureId`, `truth`, `kind` (`static` o `motion`), `components`, `source:"paired-raw-and-filtered-v2"` y `rawFrames` válidos. Los identificadores de participante y sesión son seudónimos; no incluyas nombres, correos ni otros datos identificables.

El evaluador exige IDs de captura distintos en los tres conjuntos y detecta sesiones compartidas siempre que todos los registros tengan `participantId` y `sessionId`. `--session-split` exige ambos IDs; `--participant-split` exige que tampoco se comparta participante entre los tres conjuntos. Si no se solicita separación estricta y falta metadata, la salida marca que no pudo verificarse. Las referencias de entrenamiento capturadas por la aplicación todavía no incorporan esos IDs; añádelos como metadata seudónima al archivo experimental si el protocolo lo requiere.

El CLI toma las tolerancias, `ambiguityConfig` y candidatos EDO opcionales solo del archivo de validación; nunca lee esos parámetros del archivo de prueba ni los ajusta automáticamente. Para investigar otros parámetros, añade al archivo de validación, por ejemplo, `"filterCandidates":[{"id":"tau-0.12","model":"first","tau":0.12},{"id":"zeta-1.1-w18","model":"second","zeta":1.1,"omegaN":18}]`. `tau` debe estar entre 0,01 y 0,3 s; `zeta`, entre 0,2 y 2; `omegaN`, entre 2 y 30 rad/s. El informe devuelve los parámetros y métricas por candidato en validación y prueba; el CLI no elige un ganador. El `aspectRatio` común se toma de validación, luego de entrenamiento, o usa 4:3 por defecto.

Los modelos procesan las mismas coordenadas raw y regeneran en memoria las referencias para cada configuración. Para señas estáticas, el replay aplica el requisito de producción de 15 predicciones consecutivas y reporta el tiempo desde el primer cuadro hasta esa confirmación; no incluye inferencia MediaPipe ni sabe cuándo comenzó realmente el gesto. Para señas dinámicas, las métricas siguen siendo evaluación offline del clip completo; su latencia es tiempo local de filtrado y clasificación, no el tiempo de respuesta de la ventana deslizante/rearme en vivo. La latencia por componente está sujeta a esas mismas definiciones. No se implementa suavizado adaptativo: primero se necesitan resultados reproducibles con datos etiquetados. La prueba final no se debe usar para escoger parámetros. No escribe a Supabase ni altera exportaciones.

Protocolo recomendado: (1) asigna cada grabación a un único split antes de analizarla; (2) mantén entrenamiento, validación y prueba en sesiones distintas; (3) si se busca generalización a personas nuevas, usa participantes distintos y `--participant-split`; (4) calibra con validación y ejecuta la prueba una sola vez con parámetros congelados; (5) reporta la cantidad de capturas, participantes, sesiones y ejemplos por clase junto con las métricas. El repositorio no incluye un corpus humano, así que las pruebas sintéticas no son evidencia de precisión real.

## Probar la cámara

1. Abre la aplicación en `http://localhost:8000` o en un sitio HTTPS y permite el acceso a la cámara.
2. Comprueba que desaparezca el mensaje de carga y que se dibujen los puntos al mostrar una mano.
3. En **Enseñar una seña**, escribe el nombre, selecciona las manos y/o el rostro requeridos y pulsa **Capturar seña**. Mantén una postura o realiza el movimiento completo y comprueba que se guarde con el tipo detectado automáticamente.
4. Comprueba la biblioteca unificada, inicia/detén el reconocimiento global, navega por **Ajustes** y prueba ambos órdenes EDO, parámetros, frase, importación/exportación y lectura por voz.
5. Cierra sesión y vuelve a entrar para comprobar que los ejemplos siguen guardados.
6. Para validar lateralidad, con la cámara frontal muestra primero solo tu mano derecha y luego solo tu izquierda, manteniendo el rostro y la otra mano fuera de cuadro. Comprueba que **Mano derecha: detectada** y **Mano izquierda: detectada** correspondan a la mano física, en ese orden; repite varias veces y en otra cámara si está disponible. El video y el canvas se espejan con CSS, pero la inferencia recibe el elemento de video. No inviertas etiquetas automáticamente si esta prueba no confirma un error.

Si el navegador deniega la cámara, revisa los permisos del sitio y recarga. La aplicación también informa si no encuentra una cámara, si otra aplicación la está usando o si MediaPipe no puede cargarse.

## Datos y privacidad

La autenticación y la biblioteca en la nube requieren un proyecto Supabase configurado. Sin él, el formulario no permite iniciar sesión y no existe un modo de acceso de demostración. Google y Apple permanecen deshabilitados: sus flujos OAuth no están implementados.

Al iniciar sesión, se carga la biblioteca. Reconocimiento, filtros EDO, coordenadas filtradas y buffers de captura/comparación se mantienen en RAM; no se consulta Supabase por cuadro de cámara. Al finalizar una captura se guardan coordenadas y características raw/filtradas, tiempos relativos y metadatos. No se suben videos ni fotografías. Las capturas pendientes se identifican como pendientes y no intervienen en el reconocimiento hasta sincronizarse. El flujo unificado reutiliza las categorías y el formato de muestras existentes; por sí mismo no elimina ni sobrescribe registros remotos. La acción explícita **Borrar** elimina la seña elegida de ambas categorías.

El formato de muestra versión 2 se valida en `js/sampleFormat.js`: conserva cuadros sincronizados de las ramas raw y EDO, coordenadas originales de manos/rostro, características faciales usadas, presencia, lateralidad, tiempos relativos y secuencias holísticas. Se validan dimensiones, valores finitos, orden temporal, duración máxima de 30 segundos y tamaño máximo de 12 MiB. Las muestras versión 1 se conservan y reconocen con su alcance original de manos, sin inventar datos faciales.

Los ejemplos antiguos se importan como heredados. Si solo conservan características, se marcan sin coordenadas originales reprocesables; si no tienen metadatos del filtro anterior, su procesamiento se identifica como desconocido. Los ejemplos capturados con el suavizado anterior conservan la etiqueta de origen existente.

Por compatibilidad, las señas heredadas que carecen de coordenadas raw pueden seguir utilizando sus descriptores históricos en la clasificación EDO, pero se desconoce el procesamiento con el que se generaron. Se marcan como no regenerables y no permiten una comparación raw/EDO verificable ni una evaluación experimental justa. Para generar referencias coherentes con el filtro activo y habilitar la comparación, vuelve a capturarlas en el formato v2 con cuadros raw pareados. El evaluador offline conserva sus tres modelos para experimentos; esto no activa una rama sin EDO en el Traductor.

Las muestras, señas y perfiles son privados por defecto. RLS comprueba el usuario autenticado y que cada muestra pertenezca a una seña de ese usuario; el bucket valida que la primera carpeta sea su UUID. La interfaz no puede saltarse las políticas enviando otro `owner_id`. No hay publicación pública implementada. La caché y la cola pendiente se guardan en IndexedDB con el UUID de usuario como clave; cerrar sesión limpia la biblioteca, frase, filtros y buffers de la RAM, pero conserva la copia de cuenta para recuperación/reintento.

El botón **Importar señas locales…** lee las claves antiguas solo tras una acción explícita, muestra la procedencia y solicita confirmación. La transferencia es idempotente y no borra `localStorage`. El JSON importado también se incorpora a la cuenta autenticada. El estado solo pasa a **Guardado en Supabase** después de respuesta satisfactoria del servidor.

## Preparar Supabase

1. Crea un proyecto Supabase y copia la **Project URL** y la **publishable key** (antes llamada `anon` key) desde la configuración de API del proyecto.
2. Copia el contenido de `js/supabaseConfig.example.js` a `js/supabaseConfig.js` y completa únicamente:
   - `projectUrl`: URL del proyecto, por ejemplo `https://<project-ref>.supabase.co`.
   - `publishableKey`: clave `sb_publishable_...` del proyecto (se acepta la antigua clave pública `anon`).

   El archivo es código público descargable por los navegadores. Nunca pongas una clave `service_role`, secret key, contraseña de base de datos ni token de administración allí.
3. Para una instalación nueva, ejecuta, en orden, los archivos `.sql` de `supabase/migrations/`; para un proyecto ya instalado, ejecuta solo la nueva migración `20261016000100_holistic_samples.sql` (no vuelvas a ejecutar la inicial). También puedes usar Supabase CLI (`supabase link --project-ref <project-ref>` y `supabase db push`). La migración nueva amplía el formato y el límite del bucket privado, y elimina la preferencia de gestos básicos sin borrar las muestras existentes ni cambiar las políticas RLS.
4. En **Authentication → URL Configuration**, configura:
   - **Site URL**: URL principal de producción (HTTPS).
   - **Redirect URLs** de desarrollo: `http://localhost:8000/**` (o el puerto/ruta real de tu servidor).
   - **Redirect URLs** de producción: agrega la URL exacta de la app y rutas de acceso usadas por el hosting, por ejemplo `https://tu-dominio.example/**`. Si se publica en GitHub Pages, incluye el path del repositorio: `https://<usuario>.github.io/<repositorio>/**`.

   El alta y recuperación redirigen a la página actual (`origin + pathname`); Supabase solo aceptará el retorno si coincide con la lista permitida.
5. En **Authentication → Providers → Email**, habilita Email. Decide si exigir confirmación de correo. Si está habilitada, el usuario confirma el enlace antes de entrar; si no, Supabase crea sesión inmediatamente.
6. Prueba el registro, confirmación, recuperación, inicio y cierre. Si utilizas SMTP personalizado, configura el proveedor de correo en Supabase para una entrega fiable. Google y Apple se muestran como no disponibles hasta que se implemente su OAuth.

No se necesitan variables `.env` ni un paso de build para esta app estática. La integración real no puede probarse hasta rellenar la configuración y aplicar la migración.

### Comprobación manual del aislamiento RLS

Con dos cuentas de prueba distintas, crea una seña y captura una muestra con la cuenta A. Cierra sesión, entra con la cuenta B y comprueba que la seña de A no aparece ni en la interfaz ni en las consultas de `signs`/`sign_samples`; intenta también eliminar o consultar el UUID de la seña de A desde B. Debe retornar cero filas o un error de autorización. La política de Storage debe impedir que B descargue el objeto bajo la carpeta UUID de A. Vuelve a A y confirma que sus registros y objeto siguen disponibles. No se debe probar con datos personales reales.

La comprobación de aislamiento requiere un proyecto desplegado y dos sesiones autenticadas; no puede ejecutarse desde este repositorio sin credenciales. Las políticas SQL se incluyen versionadas, pero este trabajo no afirma una prueba remota real.

### Documentación oficial consultada

- [Supabase Auth: JavaScript](https://supabase.com/docs/reference/javascript/auth-signup), [confirmación y URL de retorno](https://supabase.com/docs/guides/auth/redirect-urls), [recuperación de contraseña](https://supabase.com/docs/guides/auth/passwords).
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) y [control de acceso de Storage](https://supabase.com/docs/guides/storage/security/access-control).
- [MediaPipe Hand Landmarker para Web](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker): la tarea entrega landmarks y categorías de lateralidad; la página consultada no especifica una inversión de etiquetas en función del espejo visual, por lo que la app debe comprobarlo con cámara real.

## Verificación

`npm test` ejecuta pruebas unitarias locales de filtros, reconocimiento y validación/serialización de muestras. No requiere conexión a Supabase. No se verificaron cuentas, correo, aislamiento remoto, cargas a Storage ni cámara física porque no se proporcionaron credenciales/proyecto.

## Tecnologías y alcance

- HTML, CSS y JavaScript nativo con módulos ES.
- MediaPipe Tasks Vision para puntos de referencia de manos y rostro; las características faciales compactas intervienen únicamente en las señas que requieren rostro.
- Vecino más cercano con rechazo de ambigüedad para señas estáticas y DTW para secuencias de movimiento.
- Integración seleccionable de filtros EDO, con referencia de entrenamiento pareada para comparar ambas ramas.
- Web Speech API para la síntesis de voz, si está disponible en el navegador.

La aplicación solo reconoce señas guardadas y sincronizadas en la biblioteca privada de la cuenta; no incluye gestos por reglas ni señas de demostración. Es un prototipo, no un traductor completo de LSC. No se incluyen archivos en `assets/sounds/` porque la app no usa audio pregrabado.

## Integrantes

- [Caleb Bermúdez](https://github.com/calebYBV)
- [José Sarmiento](https://github.com/jose-alt-oss)

## Licencia

Pendiente de definición por el equipo.