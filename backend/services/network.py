"""
Detección local de direcciones de red (Tailscale y Wi-Fi/LAN) y generación 100% offline
de códigos QR en formato SVG para acceso rápido desde el celular.
"""

import io
import ipaddress
import socket
from typing import Dict, List, Any, Optional

import qrcode
import qrcode.image.svg

from backend.config import SERVER_PORT

_TAILSCALE_NET = ipaddress.IPv4Network("100.64.0.0/10")
_LINK_LOCAL_NET = ipaddress.IPv4Network("169.254.0.0/16")


def _get_default_outbound_ip() -> Optional[str]:
    """Obtiene la IP IPv4 de la interfaz con ruta predeterminada (sin enviar tráfico)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def _collect_candidate_ipv4s() -> List[str]:
    """Recopila IPs IPv4 locales del host excluyendo loopback y link-local (169.254.x.x)."""
    candidates: List[str] = []
    seen = set()

    def add_if_valid(ip_str: Optional[str]) -> None:
        if not ip_str or ip_str in seen:
            return
        try:
            addr = ipaddress.IPv4Address(ip_str)
        except ipaddress.AddressValueError:
            return
        if addr.is_loopback or addr in _LINK_LOCAL_NET or addr.is_unspecified:
            return
        seen.add(ip_str)
        candidates.append(ip_str)

    add_if_valid(_get_default_outbound_ip())
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add_if_valid(info[4][0])
    except OSError:
        pass

    return candidates


def generate_qr_svg(url: str) -> str:
    """Genera un código QR en SVG de forma 100% local (sin servicios externos)."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


def get_network_access_info(port: int = SERVER_PORT) -> Dict[str, Any]:
    """
    Detecta la IP de Tailscale (prioritaria si está activa) y la IP local de Wi-Fi/LAN,
    construyendo las URLs en el puerto configurado junto con su código QR SVG local.
    """
    candidates = _collect_candidate_ipv4s()

    tailscale_ip: Optional[str] = None
    wifi_ip: Optional[str] = None

    for ip_str in candidates:
        addr = ipaddress.IPv4Address(ip_str)
        if addr in _TAILSCALE_NET:
            if tailscale_ip is None:
                tailscale_ip = ip_str
        elif addr.is_private and wifi_ip is None:
            wifi_ip = ip_str

    options: List[Dict[str, str]] = []

    if tailscale_ip:
        url = f"http://{tailscale_ip}:{port}"
        options.append({
            "id": "tailscale",
            "label": "Tailscale",
            "ip": tailscale_ip,
            "url": url,
            "hint": "Acceso seguro desde tu celular vía Tailscale (dentro o fuera de casa).",
            "svg": generate_qr_svg(url),
        })

    if wifi_ip:
        url = f"http://{wifi_ip}:{port}"
        options.append({
            "id": "wifi",
            "label": "Wi-Fi / Local",
            "ip": wifi_ip,
            "url": url,
            "hint": "Acceso directo por red Wi-Fi local (ambos dispositivos en la misma red).",
            "svg": generate_qr_svg(url),
        })

    if not options:
        url = f"http://127.0.0.1:{port}"
        options.append({
            "id": "localhost",
            "label": "Este equipo",
            "ip": "127.0.0.1",
            "url": url,
            "hint": "No se detectó IP de Wi-Fi ni Tailscale activa; usando dirección local.",
            "svg": generate_qr_svg(url),
        })

    preferred = options[0]["id"]
    return {
        "port": port,
        "preferred": preferred,
        "options": options,
    }
