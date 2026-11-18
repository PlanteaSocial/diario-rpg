"""
Configuración centralizada para la aplicación Diario Inteligente (Local-First y Cloud-Ready).
Garantiza rutas absolutas multiplataforma, codificación UTF-8 explícita y lectura
limpia de variables de entorno para despliegues separados (Firebase Hosting + API).
"""

import os
from pathlib import Path
from typing import List


def _parse_csv_env(name: str) -> List[str]:
    raw = os.environ.get(name, "")
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


# Raíz del proyecto
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Rutas de datos
DATA_DIR = Path(os.environ.get("DIARIO_DATA_DIR") or (PROJECT_ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("DIARIO_DB_PATH") or (DATA_DIR / "diario.db"))
TRAIN_FEEDBACK_PATH = Path(
    os.environ.get("DIARIO_TRAIN_FEEDBACK_PATH") or (DATA_DIR / "train_feedback.jsonl")
)
EVAL_ES_PATH = DATA_DIR / "eval_es.jsonl"
TRAIN_SEED_PATH = DATA_DIR / "train_seed.jsonl"
EVAL_REPORT_PATH = DATA_DIR / "eval_report.json"
LEARNING_TRACKS_PATH = DATA_DIR / "learning_tracks.json"
GLOSSARY_PATH = DATA_DIR / "glossary_terms.json"

# Directorio estático frontend
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# Configuración del servidor (0.0.0.0 expone el puerto 8000 en red local y Tailscale)
SERVER_HOST = os.environ.get("DIARIO_SERVER_HOST", "0.0.0.0")
SERVER_PORT = int(os.environ.get("DIARIO_SERVER_PORT", "8000"))

# Seguridad y despliegue desacoplado (p. ej. Frontend en Firebase Hosting)
CORS_ORIGINS: List[str] = _parse_csv_env("DIARIO_CORS_ORIGINS")
AUTH_MODE = os.environ.get("DIARIO_AUTH_MODE", "local").strip().lower()
TRUST_PROXY = os.environ.get("DIARIO_TRUST_PROXY", "0").strip().lower() in ("1", "true", "yes")
COOKIE_SAMESITE = os.environ.get("DIARIO_COOKIE_SAMESITE", "lax").strip().lower()
if COOKIE_SAMESITE not in ("lax", "strict", "none"):
    COOKIE_SAMESITE = "lax"

# Configuración de Ollama
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_PREFERRED_MODELS = ["qwen3.5:4b", "qwen2.5:1.5b", "qwen2.5:7b", "qwen3.5:9b", "qwen3:14b"]

# Configuración de Laya
LAYA_MODEL_ID = "convaiinnovations/laya"
LAYA_SUBFOLDER = "multilingual"
