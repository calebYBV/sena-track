# SEÑA-TRACK — ACTUALIZACIÓN PROFESIONAL DEL README Y LICENCIA MIT

Actúa como ingeniero de software senior especializado en documentación técnica, proyectos open source, GitHub, JavaScript, visión por computadora y licencias de software.

**Repositorio:** `calebYBV/sena-track`

**Rama principal:** `main`

## OBJETIVO

Quiero modernizar y profesionalizar el README de Seña-Track y añadir una licencia MIT de libre uso.

Seña-Track es un proyecto académico y tecnológico de reconocimiento de señas mediante MediaPipe y filtros basados en ecuaciones diferenciales ordinarias (EDO).

El objetivo es que cualquier visitante del repositorio pueda entender qué hace, utilizarlo, estudiar su funcionamiento, contribuir y reutilizar legalmente el software.

### REGLA FUNDAMENTAL

Antes de editar, inspecciona el README y el código ACTUAL del repositorio.

No uses versiones antiguas de la documentación.

No elimines información técnica, matemática o experimental válida para simplificar el README.

No inventes funcionalidades, resultados experimentales ni características del sistema.

## 1. PRESENTACIÓN DEL PROYECTO

Mejora el encabezado del README con:

- Nombre: **Seña-Track**.
- Descripción breve, clara y atractiva en español.
- Propósito educativo y tecnológico.
- Enlace a la aplicación publicada:
  https://calebybv.github.io/sena-track/
- Enlace al repositorio:
  https://github.com/calebYBV/sena-track
- Badge de licencia MIT, cuando el archivo LICENSE exista.
- Badge o enlace al estado de GitHub Pages, si corresponde y puede verificarse.

Puedes utilizar el logo existente si su uso está autorizado y la ruta es correcta.

No inventes capturas de pantalla ni imágenes.

## 2. RESUMEN DE CARACTERÍSTICAS

Presenta las funciones principales de Seña-Track:

- Reconocimiento de señas mediante MediaPipe y EDO.
- Detección de ambas manos y rostro.
- Reconocimiento de posturas estáticas y movimientos.
- Captura unificada de nuevas señas.
- Biblioteca privada sincronizada mediante Supabase.
- Construcción de frases.
- Lectura de texto mediante síntesis de voz.
- Ajuste de la constante de tiempo τ del filtro EDO de primer orden.
- Comparación experimental entre MediaPipe original y MediaPipe + EDO.
- Gráfica de seguimiento general de manos y rostro.
- Estimaciones de estabilidad, vibración y retardo.
- Evaluación mediante capturas etiquetadas.
- Interfaz con las vistas Traductor y Ajustes.

Comprueba cada función contra el código actual.

Aclara que el sistema reconoce las señas guardadas por el usuario; no es un traductor completo de la lengua de señas colombiana ni ofrece reconocimiento universal preentrenado.

## 3. EXPLICAR MEDIAPIPE Y LAS EDO

Conserva la documentación matemática y técnica existente.

Explica:

- Cómo MediaPipe identifica landmarks.
- Cómo se procesan manos y rostro.
- Cómo los filtros EDO reciben las coordenadas.
- Modelo de primer orden y su ecuación.
- Integración mediante Euler explícito con subpasos de hasta τ/4.
- Diferencias entre señales originales y filtradas.
- Actualización temporal y reinicio de filtros.
- Influencia de τ.

El reconocimiento activo utiliza siempre MediaPipe + EDO.

MediaPipe sin filtro se utiliza solamente como referencia experimental.

No introduzcas un selector para desactivar EDO durante el reconocimiento.

No afirmes que las EDO aumentan la exactitud de reconocimiento si no existen resultados experimentales que lo demuestren.

## 4. DOCUMENTAR LA GRÁFICA GENERAL

Actualiza la información para reflejar la implementación más reciente.

La gráfica:

- No tiene selector de coordenadas individuales.
- Representa un seguimiento agregado de ambas manos y rostro detectados.
- Utiliza desplazamiento RMS bidimensional por cuadro.
- Asigna igual peso a cada región detectada.
- Presenta MediaPipe original y MediaPipe + EDO.
- Reinicia o separa el historial cuando corresponde.

Distingue claramente el desplazamiento general del movimiento voluntario, la vibración, la precisión y la latencia de reconocimiento.

No presentes la gráfica como prueba de una mejora de exactitud.

## 5. DOCUMENTAR LA ARQUITECTURA ACTUAL

Actualiza el árbol de archivos.

Comprueba la existencia y función de los módulos, especialmente:

- `authBootstrap.js`
- `appAuth.js`
- `auth.js`
- `cameraLoader.js`
- `camera.js`
- `ui.js`
- `globalTrace.js`
- `filters.js`
- `recognition.js`
- `training.js`
- `storage.js`
- `evaluationCapture.js`
- `navigation.js`

Explica brevemente cómo la autenticación se inicializa independientemente de la carga de cámara y MediaPipe.

Incluye el mecanismo actual de versionado de módulos ES mediante import map.

Aclara que los cambios futuros en recursos requieren actualizar correctamente el marcador de versión conforme a la implementación vigente.

## 6. INSTALACIÓN Y EJECUCIÓN

Crea una sección fácil de seguir para desarrolladores nuevos.

Incluye los comandos apropiados para:

1. Clonar el repositorio.
2. Entrar en la carpeta.
3. Ejecutar un servidor estático.
4. Abrir la aplicación mediante localhost.
5. Ejecutar pruebas mediante npm.

No agregues pasos de compilación ni instalación de dependencias de producción si el proyecto no los necesita.

Documenta que el acceso a la cámara requiere un contexto seguro.

Mantén la documentación de configuración de Supabase, migraciones SQL y URLs de redirección.

Nunca publiques contraseñas ni claves privadas.

## 7. PRIVACIDAD Y LIMITACIONES

Conserva y organiza la información sobre:

- Autenticación.
- Bibliotecas privadas.
- Row Level Security.
- Almacenamiento de capturas.
- Ausencia de grabación de videos como parte del reconocimiento.
- Importación y exportación de JSON.
- Limitaciones del prototipo.
- Validación experimental pendiente.
- Distinción entre pruebas sintéticas y exactitud real.

No afirmes que el reconocimiento funciona sin conexión cuando depende de recursos que necesitan descargarse.

## 8. AÑADIR LICENCIA MIT

Actualmente el repositorio no contiene un archivo LICENSE.

Crea un archivo llamado exactamente:

`LICENSE`

En la raíz del repositorio.

Utiliza el texto oficial completo, sin modificaciones, de la **MIT License**, con identificador SPDX `MIT`.

Referencia:
https://choosealicense.com/licenses/mit/

Año: 2026.

El README identifica como integrantes a:

- Caleb Bermúdez
- José Sarmiento

Si ambos son los titulares de los derechos del código y autorizan su publicación bajo MIT, utiliza:

`Copyright (c) 2026 Caleb Bermúdez and José Sarmiento`

No atribuyas derechos de autor sobre software, imágenes, modelos u otros recursos de terceros que no les pertenezcan.

Si encuentras recursos propios y externos mezclados o alguna duda sobre la titularidad, identifica explícitamente qué requiere confirmación antes de aplicar la licencia a esos recursos.

No sustituyas el texto MIT por un resumen en español.

## 9. SECCIÓN DE LICENCIA EN README

Sustituye el texto antiguo «Pendiente de definición por el equipo», una vez confirmada la autorización de los titulares, por una sección que indique que el código propio se distribuye bajo MIT y enlace al archivo LICENSE.

Explica brevemente que terceros pueden usar, copiar, modificar y distribuir el software, incluso comercialmente, conservando el aviso de derechos de autor y la licencia.

Aclara que los servicios externos, las dependencias y cualquier recurso de terceros siguen sujetos a sus propias licencias y términos.

No presentes la licencia MIT como autorización para acceder a cuentas, bibliotecas privadas, bases de datos o infraestructura del proyecto.

## 10. DOCUMENTAR CONTRIBUCIONES

Agrega una sección breve sobre cómo contribuir.

Explica el flujo general:

1. Crear un fork.
2. Crear una rama.
3. Realizar cambios.
4. Ejecutar pruebas.
5. Abrir un Pull Request.

No inventes un código de conducta ni reglas de contribución que todavía no existan.

## 11. CONSERVAR LOS AUTORES

Mantén los integrantes y sus enlaces:

- Caleb Bermúdez — https://github.com/calebYBV
- José Sarmiento — https://github.com/jose-alt-oss

No atribuyas autoría de dependencias externas a los integrantes.

## 12. FORMATO Y CALIDAD

Quiero un README profesional, completamente en español, con:

- Encabezados claros.
- Tabla de contenidos enlazada.
- Tablas cuando realmente faciliten la lectura.
- Bloques de código correctos.
- Enlaces funcionales.
- Información técnica completa.
- Redacción natural.
- Terminología matemática y de programación precisa.

No hagas un README superficial.

Conserva todas las explicaciones matemáticas, de privacidad y evaluación que sean relevantes, pero reordénalas para que el documento sea fácil de consultar.

El proyecto debe resultar comprensible tanto para un visitante nuevo como para un desarrollador interesado en el funcionamiento técnico.

## 13. PRUEBAS Y VALIDACIÓN

Antes de terminar:

- Ejecuta `npm test`.
- Ejecuta `git diff --check`.
- Verifica los enlaces internos.
- Comprueba que todos los archivos mencionados existan.
- Comprueba que el formato Markdown sea válido.
- Confirma que LICENSE contenga el texto MIT completo.
- Comprueba que no hayas incluido datos privados.
- Verifica que los apartados describan la versión actual.

No cambies los algoritmos ni componentes funcionales para realizar esta tarea.

Al tratarse de una actualización de documentación y licencia, no modifiques innecesariamente HTML, CSS, JavaScript ni la configuración del import map.

## 14. GIT

Trabaja en una rama nueva basada en `main`:

`docs/readme-mit-license`

No modifiques `main` directamente.

Al terminar:

1. Crea los commits correspondientes.
2. Publica la rama.
3. Abre un Pull Request hacia `main`.
4. No fusiones automáticamente.
5. No elimines ramas.
6. Entrega el enlace del PR.

## 15. INFORME FINAL

Indica:

1. Qué secciones del README actualizaste.
2. Qué información técnica reorganizaste.
3. Si existen aspectos pendientes de confirmar.
4. Qué archivo LICENSE creaste.
5. Qué titulares de copyright se incluyeron.
6. Qué recursos de terceros necesitan tratamiento separado.
7. Qué pruebas ejecutaste y sus resultados.
8. Cuál es el enlace del Pull Request.

**RESULTADO ESPERADO:** un README completo, profesional, actualizado y accesible, acompañado de una licencia MIT válida que permita el uso libre del código propio de Seña-Track, preservando el reconocimiento de sus autores.

## Recuperación de la sincronización de muestras

Las capturas pendientes se conservan en IndexedDB, por cuenta. La sincronización
confirma cada muestra por separado; las referencias previamente confirmadas y
compatibles con el filtro EDO de primer orden pueden seguir reconociéndose.
El estado indica la operación, la muestra y el número que continúa pendiente.
Una respuesta perdida se comprueba contra el contenido remoto antes de confirmar
la captura; una discrepancia se conserva para revisión, sin sobrescribir datos.

Si aparece un error, conserva los datos del navegador y reintenta desde la
interfaz con la misma cuenta. Revisa la operación y el mensaje de Supabase:
una denegación de permisos, una interrupción de red, una inserción y un error de
Storage requieren comprobaciones distintas. No borres IndexedDB ni localStorage
para resolverlo. Evita editar la biblioteca simultáneamente en varias pestañas;
la coordinación de escrituras de la caché es por instancia de la aplicación.

Si un objeto de Storage no se puede descargar, la biblioteca carga las demás
referencias y muestra cada registro afectado en los detalles de sincronización.
El informe compara metadatos y datos originales locales válidos por cuenta,
identificador, seña, tipo y ruta; una coincidencia es solo una posible copia,
no una prueba de que sea idéntica al archivo inaccesible. No se restaura ni
sobrescribe automáticamente ningún objeto. Conserva la caché y consulta los
detalles antes de solicitar una recuperación manual autorizada. Un fallo de
descarga también puede deberse a red o permisos, no necesariamente a ausencia.

**Reintentar** sincroniza capturas y preferencias, pero nunca ejecuta las
eliminaciones pendientes. Para ellas existe **Revisar eliminaciones**, con un
resumen y una confirmación independiente. La operación solo elimina los
registros de muestra identificados y deja intactos las señas y los objetos de
Storage; estos últimos pueden quedar huérfanos y requieren revisión manual.
Si no se puede verificar un registro, o una operación se interrumpe, la cola
se conserva: algunos registros podrían haberse eliminado antes del error, por
lo que hay que revisar Supabase antes de confirmar de nuevo. No se debe ejecutar
esta acción para recuperar capturas pendientes.
El botón de borrado de la biblioteca retira las capturas locales al confirmarlo;
crea antes un respaldo privado si quieres conservarlas. El respaldo solo cubre
lo que todavía está presente en IndexedDB, no reconstruye capturas borradas
antes de crearlo.

### Respaldo privado de la cola

En Ajustes, **Crear respaldo local privado** descarga la copia IndexedDB de la cuenta
activa, incluidos estados originales, identificadores, ajustes y cola de
eliminaciones. Incluye las muestras pendientes, inválidas y sin verificar,
además de las confirmadas; el resumen indica cantidades por estado. Es distinto
de **Exportar señas**, que sirve para intercambio y excluye las pendientes.
No incluye capturas que existan únicamente en Supabase ni objetos remotos
inaccesibles; no sustituye un respaldo independiente de la base de datos y
Storage.
El respaldo contiene datos biométricos: guárdalo en un lugar privado y seguro,
no lo publiques ni lo adjuntes a incidencias o CI. No está cifrado. SHA-256
detecta alteraciones accidentales, pero no autentica el archivo.

Para recuperar capturas, inicia sesión con la misma cuenta y usa
**Restaurar respaldo privado**. Se comprueba la integridad y propiedad y se
solicita confirmación. Solo se añaden capturas ausentes; un conflicto de
identificador o una eliminación pendiente bloquea la restauración sin
sobrescribir la cola. Se conservan sus estados; las inválidas y sin verificar
no se importan como referencias utilizables. Al restaurar una captura
confirmada que ya no existe en la cola, se conserva su estado original en el
archivo, pero se incorpora como **unverified**: el checksum no demuestra que
Supabase la haya confirmado. Las pendientes conservan su estado y podrán
sincronizarse al reintentar o volver a cargar. Los ajustes y eliminaciones
quedan conservados en el archivo, pero esta operación no los restaura.

Antes de probar una reparación, usa el navegador, perfil, origen web y cuenta
originales; IndexedDB está aislada por origen. Una instalación en localhost o
Codespaces no puede leer la cola de la aplicación publicada. No borres datos
del sitio, cierres el perfil ni uses una pestaña privada. Esta función solo
estará disponible en ese origen cuando se publique una versión que la incluya.
Cierra las demás pestañas de la aplicación antes de exportar, restaurar o
sincronizar: la coordinación actual no cubre escrituras entre pestañas.
Al iniciar sesión con una cola pendiente no se reintenta automáticamente:
verifica el resumen del respaldo y guárdalo antes de pulsar **Reintentar**.
No captures señas ni cambies ajustes antes de respaldar, pues esas acciones
pueden iniciar la sincronización.

Si el error persiste, comparte únicamente la operación, el código HTTP o SQL y
las cantidades por estado, eliminando nombres, rutas e identificadores. No
compartas el JSON, coordenadas, tokens, contraseñas ni capturas de la consola
que los muestren. El administrador debe comprobar la sesión, migraciones,
restricciones, RLS de ambas tablas y permisos y límite del bucket privado; no
debe modificar políticas o datos sin revisar el diagnóstico. Un objeto
existente solo se reutiliza después de descargar y comparar su contenido; una
inserción no se considera confirmada hasta releer el registro y sus datos.
