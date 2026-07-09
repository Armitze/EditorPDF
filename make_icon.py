"""Genera assets/icon.ico a partir de assets/icon_source.png.

Si no existe la imagen de origen, dibuja un icono de reserva (cuadrado azul con «P»).
"""
import os

from PIL import Image, ImageDraw, ImageFont

SIZE = 256
SOURCE = 'assets/icon_source.png'
SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def from_source():
    img = Image.open(SOURCE).convert('RGBA')
    # Lienzo cuadrado transparente; centrar la imagen escalada con margen mínimo.
    side = max(img.size)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def fallback():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=52, fill=(37, 99, 168, 255))
    font = None
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'arial.ttf'):
        try:
            font = ImageFont.truetype(name, 170)
            break
        except OSError:
            continue
    if font:
        bbox = d.textbbox((0, 0), 'P', font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1]), 'P',
               font=font, fill=(255, 255, 255, 255))
    return img


os.makedirs('assets', exist_ok=True)
img = from_source() if os.path.isfile(SOURCE) else fallback()
img.save('assets/icon.ico', sizes=SIZES)
print('assets/icon.ico generado desde',
      SOURCE if os.path.isfile(SOURCE) else 'icono de reserva')
