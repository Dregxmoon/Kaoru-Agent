#!/usr/bin/env python3
"""
audit_py_deps.py — detecta imports de Python en el código que no
aparecen declarados en requirements.txt.

Uso (desde la raíz del repo):
  python audit_py_deps.py

Limitación: el nombre del import no siempre coincide con el nombre del
paquete de pip (ej. import speech_recognition -> pip install SpeechRecognition,
import cv2 -> pip install opencv-python). Revisa a mano lo que marque como
"posible faltante" antes de asumir que de verdad falta.
"""
import ast
import sys
import pathlib

STDLIB = set(getattr(sys, 'stdlib_module_names', []))

SKIP_DIRS = {'node_modules', '.git', 'venv', '.venv', '__pycache__'}

found = {}  # nombre -> set(archivos)

for path in pathlib.Path('.').rglob('*.py'):
    if any(part in SKIP_DIRS for part in path.parts):
        continue
    try:
        tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    except Exception as e:
        print(f"(no se pudo parsear {path}: {e})")
        continue

    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                names.add(node.module.split('.')[0])

    for name in names:
        if name in STDLIB:
            continue
        found.setdefault(name, set()).add(str(path))

print("Dependencias externas detectadas en el código:")
for name in sorted(found):
    print(f"  - {name}  (en: {', '.join(sorted(found[name]))})")

req_path = pathlib.Path('requirements.txt')
declared = set()
if req_path.exists():
    for line in req_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            pkg = line.split('==')[0].split('>=')[0].split('<')[0].strip().lower()
            declared.add(pkg)
            declared.add(pkg.replace('-', '_'))
            declared.add(pkg.replace('_', '-'))

missing = [n for n in found if n.lower() not in declared]
print()
if missing:
    print("⚠️  Posiblemente faltan en requirements.txt (revisa el nombre real del paquete pip):")
    for n in sorted(missing):
        print(f"  - {n}")
else:
    print("✔ Todo lo detectado coincide con requirements.txt.")