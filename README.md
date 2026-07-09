# PDF Editor Pro

Editor y visor de PDFs de escritorio para Windows, implementado a partir del diseño **Editor de PDFs.dc.html** (proyecto Claude Design "Editor de PDFs Interno").

- **Interfaz**: HTML + CSS + JavaScript (carpeta `ui/`), fiel al diseño original.
- **Backend**: Python — FastAPI sirve la interfaz y expone la API; PyMuPDF hace el trabajo real con los PDFs; pywebview crea la ventana nativa sin marco (la barra de título del diseño es funcional: arrastrar, minimizar, maximizar, cerrar).
- **Ejecutable**: PyInstaller genera `dist/PDFEditorPro.exe`, un único archivo.

## Funcionalidad con PDFs reales

- **Abrir** PDFs (botón, o doble clic en un `.pdf` una vez asociado) y navegar por miniaturas.
- **Anotar**: resaltado, línea, flecha y caja de texto dibujados con el ratón, con color, grosor y opacidad; se guardan como anotaciones PDF estándar.
- **Páginas**: agregar, duplicar, eliminar; **Fusionar** (anexar otro PDF).
- **Separar por grupos**: define grupos dinámicos con nombre propio y márcalos visualmente haciendo clic sobre las miniaturas de las páginas (cada grupo tiene su color); los rangos escritos (`1-3, 7, 10-12`) y la selección visual se mantienen sincronizados. La lupa de cada miniatura abre una **vista ampliada** de la página (navegación con ‹ ›, Enter marca/desmarca, clic acerca al 100 %). Cada grupo se guarda como un PDF independiente en la carpeta que elijas.
- **Deshacer / Rehacer** (Ctrl+Z / Ctrl+Y, o los botones de la barra): revierte anotaciones, cambios de páginas y fusiones (hasta 20 pasos). También funciona en el documento de demostración.
- **Guardar** (Ctrl+S) y Guardar como (Ctrl+Shift+S). Al cerrar con cambios sin guardar, pregunta **Guardar / No guardar / Cancelar** (también al cerrar con Alt+F4).
- **Panel de propiedades colapsable**: oculta la columna derecha (Edición/Anotaciones/Extracción/OCR) con el botón ‹ para ganar espacio de lienzo; se reabre desde el riel lateral.
- **Extraer texto** (pestaña OCR) de la página o del documento completo.
- **Detectar y exportar tablas** (pestaña Extracción) a Excel, CSV o portapapeles.
- **Exportar** el documento a Word, Excel o HTML.
- **Zoom** 40–300 %.

Sin un PDF abierto, la interfaz muestra el documento de demostración del diseño original con sus interacciones simuladas.

## Desarrollo

```powershell
pip install -r requirements.txt
python main.py                 # ventana de escritorio
python main.py --server        # solo servidor (http://localhost:8123) para desarrollo de la UI
python main.py archivo.pdf     # abrir un PDF al iniciar
```

## Compilar el ejecutable

```powershell
python make_icon.py            # genera assets/icon.ico (solo la primera vez)
python -m PyInstaller --noconfirm --clean --onedir --windowed `
  --name PDFEditorPro --icon assets\icon.ico --add-data "ui;ui" main.py
```

El resultado queda en `dist/PDFEditorPro/PDFEditorPro.exe`. Se usa el modo `--onedir` (una carpeta con el `.exe` y sus dependencias sueltas) porque **arranca en pocos segundos**; el modo `--onefile` genera un único archivo pero se descomprime entero en cada inicio, lo que lo hace mucho más lento de abrir.

## Usarlo como visor de PDF predeterminado

Al ejecutar `PDFEditorPro.exe` (dentro de `dist/PDFEditorPro/`) por primera vez, la app se registra en Windows (HKCU, sin permisos de administrador) como aplicación capaz de abrir `.pdf`. Después:

1. Abre **Configuración → Aplicaciones → Aplicaciones predeterminadas**.
2. Busca **PDF Editor Pro** (o busca la extensión `.pdf`).
3. Selecciónala como predeterminada para `.pdf`.

También aparece en el menú contextual **Abrir con** de cualquier archivo PDF.

## Notas

- La extracción de texto usa el texto digital del PDF (PyMuPDF); no incluye OCR de imágenes escaneadas.
- Los PDFs protegidos con contraseña no están soportados.
