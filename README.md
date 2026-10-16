# SEÑA-TRACK

Aplicación web para registrar señas estáticas y con movimiento, reconocerlas con la cámara y construir una frase con salida de voz.

## Funciones

- Detección sincronizada de ambas manos y rostro con MediaPipe Tasks Vision 0.10.14. Los coeficientes faciales, las relaciones geométricas y la orientación de la cabeza intervienen en el reconocimiento, sin inferir emociones ni identidad personal.
- Registro de señas fijas y con movimiento, seleccionando explícitamente mano izquierda, derecha, ambas y/o rostro. Se reconocen únicamente ejemplos guardados en la biblioteca privada de Supabase.
- Filtros manuales de primer orden y segundo orden amortiguado para landmarks, con comparación en vivo frente a la salida directa de MediaPipe y ecuaciones MathML explicadas en la interfaz.
- Controles de tolerancia y duración, frase acumulada y lectura automática o manual, controles de espacio, borrar y limpiar. No hay gestos preprogramados ni señas de demostración.
- Importación explícita y exportación de señas en JSON; las bibliotecas antiguas de `localStorage` no se cargan automáticamente.
- Registro, inicio, restauración y cierre de sesión con Supabase Auth; recuperación de contraseña por correo.
- Biblioteca de señas privada sincronizada por cuenta. El reconocimiento trabaja con los ejemplos ya cargados en memoria.
- Importación confirmada de la biblioteca local o de archivos JSON; exportación JSON conservada.

La comparación muestra distancias a ejemplos guardados y la reducción relativa de distancia para una misma etiqueta. No es una exactitud validada ni una probabilidad de acierto. En uso libre, la referencia es la candidata de la rama principal; se puede seleccionar una seña explícita para una evaluación controlada. Una biblioteca vacía no produce palabras ni voz.

La primera vista distribuye enseñanza y biblioteca a la izquierda, cámara y voz al centro, y comparación EDO con métricas de estabilidad a la derecha. La zona inferior contiene los ajustes generales y la explicación completa de la EDO con los parámetros activos y el cálculo numérico desplegable. Durante el registro de ejemplos, la comparación se desactiva y se aclara que no es una evaluación independiente.

El filtro de primer orden usa `dy/dt = (u - y) / tau`; el de segundo orden usa `y'' + 2*zeta*omegaN*y' + omegaN²*y = omegaN²*u`. Ambos emplean el tiempo real entre cuadros, estados independientes por mano y rostro y pasos internos acotados. El filtro no altera el video. La rama sin filtro sigue siendo la salida de MediaPipe y puede incluir su propio procesamiento interno.

La interfaz también informa una reducción de vibración calculada solo durante segmentos de baja velocidad raw y un retraso añadido estimado mediante correlación temporal de la trayectoria de la muñeca. Son mediciones observacionales de la sesión, no resultados garantizados ni el tiempo de cómputo o de confirmación de seña; cuando los datos no permiten calcularlas, se indica así.

Los ejemplos nuevos guardan coordenadas originales, componentes requeridos, lateralidad, presencia, tiempos relativos, características faciales y manuales utilizadas, y metadatos del filtro EDO. La comparación holística pondera explícitamente forma manual, posición relativa y rostro; el rostro pesa 0,5 cuando se combina con manos, su vector tiene escala 2,5 y el peso de la forma manual y la posición se reparte en 0,35/0,15. Estas ponderaciones son parámetros de comparación, no probabilidades. Los ejemplos antiguos permanecen compatibles como muestras de manos sin información facial inventada y se pueden volver a capturar con otros componentes.

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
  training.js     # Captura estática y registro de movimientos
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

Ejecuta las pruebas numéricas de los filtros y de la comparación con `npm test` (requiere Node.js; la app en navegador no requiere compilación).

## Probar la cámara

1. Abre la aplicación en `http://localhost:8000` o en un sitio HTTPS y permite el acceso a la cámara.
2. Comprueba que desaparezca el mensaje de carga y que se dibujen los puntos al mostrar una mano.
3. En **Enseñar una seña**, selecciona las manos y/o el rostro que requiere la seña. Registra ejemplos fijos y con movimiento y comprueba que los ejemplos sincronizados aparezcan en **Mis señas** y se reconozcan.
4. Prueba los controles de frase, los ajustes, la importación/exportación y la lectura por voz.
5. Cierra sesión y vuelve a entrar para comprobar que los ejemplos siguen guardados.

Si el navegador deniega la cámara, revisa los permisos del sitio y recarga. La aplicación también informa si no encuentra una cámara, si otra aplicación la está usando o si MediaPipe no puede cargarse.

## Datos y privacidad

La autenticación y la biblioteca en la nube requieren un proyecto Supabase configurado. Sin él, el formulario no permite iniciar sesión y no existe un modo de acceso de demostración. Google y Apple permanecen deshabilitados: sus flujos OAuth no están implementados.

Al iniciar sesión, se carga la biblioteca una vez. Reconocimiento, filtros EDO, coordenadas filtradas y buffers de captura/comparación se mantienen en RAM; no se consulta Supabase por cuadro de cámara. Al finalizar una captura se guardan coordenadas y características raw/filtradas, tiempos relativos y metadatos. No se suben videos ni fotografías. Las capturas pendientes se identifican como pendientes y no intervienen en el reconocimiento hasta sincronizarse.

El formato de muestra versión 2 se valida en `js/sampleFormat.js`: conserva cuadros sincronizados de las ramas raw y EDO, coordenadas originales de manos/rostro, características faciales usadas, presencia, lateralidad, tiempos relativos y secuencias holísticas. Se validan dimensiones, valores finitos, orden temporal, duración máxima de 30 segundos y tamaño máximo de 12 MiB. Las muestras versión 1 se conservan y reconocen con su alcance original de manos, sin inventar datos faciales.

Los ejemplos antiguos se importan como heredados. Si solo conservan características, se marcan sin coordenadas originales reprocesables; si no tienen metadatos del filtro anterior, su procesamiento se identifica como desconocido. Los ejemplos capturados con el suavizado anterior conservan la etiqueta de origen existente.

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

## Verificación

`npm test` ejecuta pruebas unitarias locales de filtros, reconocimiento y validación/serialización de muestras. No requiere conexión a Supabase. No se verificaron cuentas, correo, aislamiento remoto, cargas a Storage ni cámara física porque no se proporcionaron credenciales/proyecto.

## Tecnologías y alcance

- HTML, CSS y JavaScript nativo con módulos ES.
- MediaPipe Tasks Vision para puntos de referencia de manos y rostro; las características faciales compactas intervienen únicamente en las señas que requieren rostro.
- KNN para señas estáticas y DTW para secuencias de movimiento.
- Integración seleccionable de filtros EDO, con referencia de entrenamiento pareada para comparar ambas ramas.
- Web Speech API para la síntesis de voz, si está disponible en el navegador.

La aplicación solo reconoce señas guardadas y sincronizadas en la biblioteca privada de la cuenta; no incluye gestos por reglas ni señas de demostración. Es un prototipo, no un traductor completo de LSC. No se incluyen archivos en `assets/sounds/` porque la app no usa audio pregrabado.

## Integrantes

- [Caleb Bermúdez](https://github.com/calebYBV)
- [José Sarmiento](https://github.com/jose-alt-oss)

## Licencia

Pendiente de definición por el equipo.