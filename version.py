"""Versión de la aplicación — fuente única de verdad.

El número se compara con el de la última publicación en GitHub Releases para
decidir si hay actualización. El workflow de CI reescribe este archivo con el
número de build antes de compilar, así el .exe publicado siempre lleva la
versión exacta del release. Formato: AÑO.MMDD.BUILD (p. ej. 2026.0721.3).

`REPO` identifica el repositorio del que se descargan las actualizaciones.
"""

__version__ = '2026.0721.0'

REPO = 'Armitze/EditorPDF'
