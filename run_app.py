"""
Punto de entrada único para iniciar Diario RPG (Linux · macOS · Windows).
Evita problemas de rutas o comillas en shells distintos y abre el navegador
únicamente cuando el puerto 8000 ya está listo para recibir peticiones.
"""

import os
import sys
import socket
import threading
import time
import webbrowser
import uvicorn


def open_browser_when_ready(host: str = "127.0.0.1", port: int = 8000):
    url = f"http://{host}:{port}"
    for _ in range(60):  # Hasta 18 segundos de espera máxima
        try:
            with socket.create_connection((host, port), timeout=0.3):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.3)


if __name__ == "__main__":
    root_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root_dir)
    if root_dir not in sys.path:
        sys.path.insert(0, root_dir)

    from backend.config import SERVER_HOST, SERVER_PORT

    if "--open-browser" in sys.argv:
        threading.Thread(
            target=open_browser_when_ready,
            args=("127.0.0.1", SERVER_PORT),
            daemon=True,
        ).start()

    uvicorn.run("backend.main:app", host=SERVER_HOST, port=SERVER_PORT)
