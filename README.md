# SEÑA-TRACK

Reconocimiento de señas en tiempo real con MediaPipe y ecuaciones diferenciales ordinarias.

## Descripción

SEÑA-TRACK es un prototipo web que permitirá registrar y reconocer un conjunto de señas mediante una cámara y convertirlas en texto y voz.

Utilizará MediaPipe para detectar puntos de referencia de las manos y del rostro. Posteriormente, aplicará ecuaciones diferenciales ordinarias (EDO) para filtrar las coordenadas y evaluar si mejora la estabilidad del rastreo y el reconocimiento.

El usuario podrá visualizar el modelo matemático utilizado y los indicadores de su efecto sobre el seguimiento.

> Proyecto en desarrollo. Las funcionalidades descritas corresponden al alcance previsto; los porcentajes de mejora se determinarán mediante pruebas.

## Objetivo

Desarrollar un prototipo que reconozca un conjunto delimitado de señas de la Lengua de Señas Colombiana (LSC) y evaluar cómo las EDO influyen en la estabilidad del rastreo, el reconocimiento y el tiempo de respuesta.

## Funcionamiento

1. La cámara captura los movimientos del usuario en tiempo real.
2. MediaPipe detecta los puntos de referencia de las manos y del rostro.
3. Las EDO filtran las coordenadas para reducir vibraciones y variaciones no deseadas.
4. El sistema analiza las posiciones y trayectorias para identificar las señas registradas.
5. La seña reconocida se muestra como texto y puede reproducirse por voz.

Las EDO procesarán el rastreo obtenido de MediaPipe. El reconocimiento utilizará las coordenadas procesadas para identificar la seña.

## Funcionalidades

### Biblioteca de señas

Permitirá capturar y administrar ejemplos para el reconocimiento.

- Añadir señas simples o señas con movimiento.
- Asignar un nombre o significado.
- Capturar varios ejemplos de cada seña.
- Guardar, consultar, corregir y eliminar registros.
- Visualizar los puntos de seguimiento durante la captura.

### Traductor

Utilizará los ejemplos registrados para reconocer las señas en tiempo real.

- Mostrar las palabras reconocidas.
- Indicar cuando una seña no pueda identificarse.
- Evitar repeticiones continuas al mantener una misma seña.
- Borrar la última palabra o limpiar el texto.
- Reproducir el resultado mediante voz.

Se incluirán dos modalidades de lectura:

| Modalidad | Funcionamiento |
| --- | --- |
| Lectura automática | Pronuncia la palabra cuando se confirma el reconocimiento. |
| Lectura al presionar | Acumula las palabras y las reproduce al pulsar **Leer**. |

En ambas modalidades, el reconocimiento y la escritura funcionan en tiempo real. La diferencia es el momento en que se reproduce la voz.

## Distribución de la interfaz

- **Lado izquierdo:** Biblioteca de señas, Traductor y sus controles.
- **Lado derecho:** transmisión de la cámara con seguimiento de manos y rostro.
- **Parte inferior de la cámara:** panel de ecuaciones diferenciales.

El panel de EDO estará activo y a color únicamente en el Traductor. En la Biblioteca permanecerá estático y gris, sin actualizar ecuaciones ni porcentajes.

### Panel de EDO

Mostrará:

- Nombre y expresión de la ecuación utilizada.
- Parámetros principales del modelo.
- Explicación breve de su función.
- Indicadores de estabilidad.
- Porcentajes obtenidos en evaluaciones, indicando qué se midió.
- Retraso introducido por el procesamiento.

También se contempla una comparación visual entre los puntos originales y los filtrados, utilizando colores diferentes.

## Modelos matemáticos

Se estudiarán dos modelos para filtrar las coordenadas.

### Filtro de paso bajo de primer orden

$$
\frac{dy}{dt}=\frac{u(t)-y(t)}{\tau}
$$

Donde:

- **u(t):** coordenada original detectada por MediaPipe.
- **y(t):** coordenada filtrada.
- **τ:** constante de tiempo que controla el suavizado.

Este modelo permite ajustar el equilibrio entre estabilidad y rapidez de respuesta. Un mayor suavizado también puede introducir mayor retraso.

### Modelo de seguimiento amortiguado de segundo orden

$$
\frac{d^2y}{dt^2}+2\zeta\omega_n\frac{dy}{dt}+\omega_n^2y=\omega_n^2u(t)
$$

Donde:

- **ζ:** factor de amortiguamiento.
- **ωₙ:** frecuencia natural del modelo.
- **u(t):** coordenada original.
- **y(t):** coordenada filtrada.

Este modelo permite regular la respuesta del seguimiento mediante el amortiguamiento y la frecuencia natural.

### Aplicación en tiempo real

Los filtros actualizarán sus valores con cada nueva detección, considerando el tiempo transcurrido entre fotogramas.

Se evaluará qué modelo y qué parámetros permiten reducir las variaciones sin perder los movimientos necesarios para distinguir las señas. La selección automática dependerá de criterios definidos y comprobados mediante pruebas.

## Medición de la mejora

Se comparará el funcionamiento con y sin filtrado adicional utilizando la misma entrada.

| Indicador | Qué se evaluará |
| --- | --- |
| Estabilidad | Variación de los puntos en condiciones controladas. |
| Reconocimiento | Proporción de señas identificadas correctamente. |
| Tiempo de respuesta | Retraso del filtrado y del reconocimiento. |

Para una medida de variación **J**, donde un valor menor indica mayor estabilidad:

$$
\text{Reducción de variación (\%)}=
\frac{J_{\text{base}}-J_{\text{filtrado}}}{J_{\text{base}}}\times100
$$

Esta fórmula se utilizará cuando la variación base sea mayor que cero.

**Ejemplo:** si durante una prueba de mano quieta la variación pasa de 10 a 7 unidades, se obtiene una reducción del 30 %.

Ese resultado representa una reducción de la variación del rastreo; no significa automáticamente un 30 % más de aciertos en el reconocimiento.

Los indicadores calculados en vivo y los resultados de pruebas previas se mostrarán por separado. También se registrarán los casos en que el filtrado aumente el retraso o no mejore el resultado.

> El 30 % es un ejemplo ilustrativo, no un resultado experimental del proyecto.

## Tecnologías y recursos previstos

- **MediaPipe:** detección de puntos de referencia.
- **EDO:** filtrado temporal de coordenadas.
- **Interfaz web:** biblioteca, traductor y panel matemático.
- **Síntesis de voz:** reproducción de las palabras reconocidas.
- **Computador con cámara y salida de audio:** ejecución y pruebas.

El lenguaje de programación, el almacenamiento y el método de reconocimiento se documentarán al definir la implementación.

## Instalación y ejecución

Las instrucciones de instalación y ejecución se añadirán al publicar la primera versión funcional, junto con las dependencias y los requisitos correspondientes.

## Plan de desarrollo

- [ ] Diseñar la interfaz principal.
- [ ] Integrar la cámara y MediaPipe.
- [ ] Implementar la captura de señas simples y con movimiento.
- [ ] Crear la biblioteca y sus controles.
- [ ] Implementar los filtros de primer y segundo orden.
- [ ] Integrar el reconocimiento en tiempo real.
- [ ] Añadir la salida de texto y voz.
- [ ] Incorporar el panel de EDO e indicadores.
- [ ] Realizar pruebas de estabilidad, reconocimiento y respuesta.
- [ ] Documentar los resultados y las limitaciones.

## Alcance

El prototipo trabajará inicialmente con un conjunto limitado de señas de la Lengua de Señas Colombiana, incluyendo el abecedario manual y algunas palabras cotidianas.

No contempla traducir conversaciones completas ni convertir automáticamente una secuencia de señas en una oración con gramática natural.

Se buscará orientación del programa de lengua de señas para validar los ejemplos y evaluar la utilidad del sistema.

## Impacto

SEÑA-TRACK busca explorar herramientas tecnológicas que contribuyan a reducir barreras de comunicación y demostrar una aplicación práctica de las ecuaciones diferenciales.

El proyecto se relaciona con:

- **ODS 9 — Industria, innovación e infraestructura:** desarrollo y evaluación de una solución tecnológica.
- **ODS 10 — Reducción de las desigualdades:** intención de apoyar una comunicación más accesible.

## Identidad visual

La interfaz utilizará una estética Web 2.0 / Corporate con elementos inspirados en Wii.

| Color | Código |
| --- | --- |
| Blanco | `#FFFFFF` |
| Azul cielo | `#74E4FF` |
| Azul principal | `#0C71C6` |
| Verde claro | `#86E750` |
| Verde oscuro | `#6AB63F` |

## Integrantes

- [Caleb Bermúdez](https://github.com/calebYBV)
- [José Sarmiento](https://github.com/jose-alt-oss)

## Licencia

Pendiente de definición por el equipo.
