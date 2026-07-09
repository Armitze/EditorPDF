"""Registro de la asociación .pdf en Windows (HKCU, sin privilegios de administrador).

Tras el registro, la app aparece en Configuración de Windows → Aplicaciones
predeterminadas y en el menú «Abrir con», donde el usuario puede fijarla como
visor de PDF predeterminado.
"""
import sys

PROG_ID = 'PDFEditorPro.Document'
APP_KEY = r'Software\PDFEditorPro'


def register():
    if sys.platform != 'win32' or not getattr(sys, 'frozen', False):
        return False
    import winreg

    exe = sys.executable
    command = f'"{exe}" "%1"'
    root = winreg.HKEY_CURRENT_USER

    def set_key(path, value=None, name=None):
        with winreg.CreateKey(root, path) as key:
            if value is not None:
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)

    # ProgID con el comando de apertura
    set_key(rf'Software\Classes\{PROG_ID}', 'Documento PDF - PDF Editor Pro')
    set_key(rf'Software\Classes\{PROG_ID}\DefaultIcon', f'"{exe}",0')
    set_key(rf'Software\Classes\{PROG_ID}\shell\open\command', command)

    # Vincular el ProgID a la extensión .pdf
    set_key(r'Software\Classes\.pdf\OpenWithProgIds', '', PROG_ID)

    # Capacidades: hace visible la app en «Aplicaciones predeterminadas»
    set_key(rf'{APP_KEY}\Capabilities', 'PDF Editor Pro', 'ApplicationName')
    set_key(rf'{APP_KEY}\Capabilities', 'Editor y visor de documentos PDF',
            'ApplicationDescription')
    set_key(rf'{APP_KEY}\Capabilities\FileAssociations', PROG_ID, '.pdf')
    set_key(r'Software\RegisteredApplications', rf'{APP_KEY}\Capabilities',
            'PDFEditorPro')
    return True
