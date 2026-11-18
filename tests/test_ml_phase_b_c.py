"""
Suite Fase B + Fase C:
- Verifica que el bundle pesado ONNX viva fuera de frontend/ (Spark quota guard)
- Ejecuta la evaluacion comparativa de las 5 baterias criticas (tests/eval_suite.mjs)
- Ejecuta la verificacion real en Headless Chromium Web Worker + IndexedDB offline + Aprender (tests/verify_browser_e2e.mjs)
"""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _resolve_playwright_dir() -> Path | None:
    candidates = []
    if os.environ.get("PLAYWRIGHT_NODE_PATH"):
        candidates.append(Path(os.environ["PLAYWRIGHT_NODE_PATH"]))
    candidates.append(PROJECT_ROOT / "node_modules" / "playwright")
    candidates.append(Path.home() / ".local" / "share" / "mise" / "installs" / "playwright" / "latest" / "node_modules" / "playwright")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


class TestMlPhaseBC(unittest.TestCase):
    def test_no_onnx_binaries_inside_firebase_hosting_public_dir(self):
        frontend_dir = PROJECT_ROOT / "frontend"
        heavy_files = list(frontend_dir.rglob("*.onnx")) + list(frontend_dir.rglob("*.safetensors"))
        self.assertEqual(heavy_files, [], f"Binarios pesados prohibidos en frontend/: {heavy_files}")

        models_dir = PROJECT_ROOT / "models"
        for fname in ("model_es_q8.onnx", "tokenizer_es.json", "diario_heads_v1.json", "prototypes_neg_v1.json"):
            self.assertTrue((models_dir / fname).is_file(), f"Falta artefacto destilado: models/{fname}")

    def test_eval_suite_five_batteries_pass(self):
        node_bin = shutil.which("node")
        if not node_bin:
            self.skipTest("Node.js no disponible")
        proc = subprocess.run(
            [node_bin, str(PROJECT_ROOT / "tests" / "eval_suite.mjs")],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            self.fail(f"eval_suite.mjs fallo:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")

    def test_browser_e2e_worker_wasm_offline_and_aprender(self):
        node_bin = shutil.which("node")
        pw_dir = _resolve_playwright_dir()
        chromium_bin = Path(os.environ.get("CHROMIUM_BIN", "/usr/bin/chromium"))
        if not node_bin or not pw_dir or not chromium_bin.exists():
            self.skipTest("Playwright/Chromium no disponible en este entorno")
        if os.environ.get("DIARIO_SKIP_BROWSER_E2E") == "1":
            self.skipTest("Omitido por DIARIO_SKIP_BROWSER_E2E=1")

        proc = subprocess.run(
            [node_bin, str(PROJECT_ROOT / "tests" / "verify_browser_e2e.mjs")],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0:
            self.fail(f"verify_browser_e2e.mjs fallo:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")


if __name__ == "__main__":
    unittest.main()
