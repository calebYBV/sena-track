# SEÑA-TRACK

Aplicación web para registrar señas estáticas y con movimiento, reconocerlas con la cámara y construir una frase con salida de voz.

## Funciones

- Detección de manos y dibujo opcional de puntos faciales con MediaPipe Tasks Vision 0.10.14.
- Registro de ejemplos de señas estáticas y movimientos; reconocimiento estático por KNN y de movimiento mediante DTW.
- Gestos básicos por reglas, controles de tolerancia y duración, y texto acumulado con controles para añadir espacio, borrar el último carácter o limpiar.
- Importación y exportación de señas en JSON, almacenamiento local y lectura en español mediante síntesis de voz del navegador.
- Inicio de sesión únicamente de demostración. No valida credenciales ni conecta con Google o Apple.

Los filtros EDO todavía no están implementados. `js/filters.js` se conserva como marcador de posición; no se muestran métricas o mejoras experimentales.

## Estructura

```text
index.html
css/styles.css
js/
  app.js          # Composición e inicialización
  auth.js         # Inicio/cierre de la sesión de demostración
  camera.js       # Permisos, modelos, detección, dibujo y ciclo de cámara
  recognition.js  # Características, reglas, KNN y DTW
  training.js     # Captura estática y registro de movimientos
  storage.js      # Persistencia, migración, importación y exportación
  ui.js           # Eventos y actualización de interfaz
  filters.js      # Marcador: filtros EDO pendientes
assets/images/    # Logo e imágenes de acceso
```

La app usa módulos ES sin proceso de compilación. MediaPipe se descarga desde jsDelivr con la versión fijada `0.10.14`; los modelos se cargan desde Google Cloud Storage. La cámara necesita un contexto seguro: `localhost` o HTTPS.

## Ejecutar localmente

Desde la carpeta del proyecto, inicia un servidor estático:

```bash
python3 -m http.server 8000
```

Abre <http://localhost:8000>. No abras `index.html` directamente desde el sistema de archivos, porque los módulos y el acceso a la cámara pueden quedar bloqueados.

En GitHub Pages se puede publicar la carpeta raíz del proyecto; las referencias a CSS, JavaScript e imágenes son relativas y funcionan dentro de una subcarpeta.

## Probar la cámara

1. Abre la aplicación en `http://localhost:8000` o en un sitio HTTPS y permite el acceso a la cámara.
2. Comprueba que desaparezca el mensaje de carga y que se dibujen los puntos al mostrar una mano.
3. En **Enseñar una seña**, registra una seña fija y otra con movimiento; comprueba que aparezcan en **Mis señas** y que puedan reconocerse.
4. Prueba los controles de frase, los ajustes, la importación/exportación y la lectura por voz.
5. Cierra sesión y vuelve a entrar para comprobar que los ejemplos siguen guardados.

Si el navegador deniega la cámara, revisa los permisos del sitio y recarga. La aplicación también informa si no encuentra una cámara, si otra aplicación la está usando o si MediaPipe no puede cargarse.

## Datos y privacidad

Los ejemplos se guardan en `localStorage` bajo `senas_mediapipe_v2`. Se sigue aceptando el formato estático anterior bajo `senas_mediapipe_v1`; al guardar, los datos quedan en la clave actual. Importar añade ejemplos al conjunto existente y exportar genera `mis-senas.json`. Cerrar sesión no borra esos datos.

Los datos de inicio de sesión de demostración solo guardan un indicador local en `senaTrackAuth`; no constituyen autenticación real.

## Tecnologías y alcance

- HTML, CSS y JavaScript nativo con módulos ES.
- MediaPipe Tasks Vision para puntos de referencia de manos y rostro.
- KNN para señas estáticas y DTW para secuencias de movimiento.
- Web Speech API para la síntesis de voz, si está disponible en el navegador.

El conjunto de gestos por reglas y las señas enseñadas son un prototipo, no un traductor completo de LSC. No se incluyen archivos en `assets/sounds/` porque la app no usa audio pregrabado.

## Integrantes

- [Caleb Bermúdez](https://github.com/calebYBV)
- [José Sarmiento](https://github.com/jose-alt-oss)

## Licencia

Pendiente de definición por el equipo.