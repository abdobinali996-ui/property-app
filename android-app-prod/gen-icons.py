#!/usr/bin/env python3
"""Generate all Android launcher icon densities from icon-1024.png.
Run AFTER `npx cap add android`, from the android-app folder."""
import os
from PIL import Image

src = Image.open(os.path.join(os.path.dirname(__file__), 'icon-1024.png')).convert('RGBA')
base = os.path.join(os.path.dirname(__file__), 'android', 'app', 'src', 'main', 'res')

legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
foreground = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

for density, size in legacy.items():
    img = src.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(base, f'mipmap-{density}', 'ic_launcher.png'))
    img.save(os.path.join(base, f'mipmap-{density}', 'ic_launcher_round.png'))
for density, size in foreground.items():
    src.resize((size, size), Image.LANCZOS).save(
        os.path.join(base, f'mipmap-{density}', 'ic_launcher_foreground.png'))
print('icons generated')
