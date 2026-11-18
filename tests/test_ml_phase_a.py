"""
Ejecuta la batería de pruebas JS de Fase A (syntax_features, calibration_math,
suggestion_engine y ClientEngine) mediante Node --test si Node está disponible.
"""

import shutil
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class TestMlPhaseA(unittest.TestCase):
    def test_ml_phase_a_suite_passes_in_node(self):
        node_bin = shutil.which("node")
        if not node_bin:
            self.skipTest("Node.js no está disponible en PATH")
        test_file = PROJECT_ROOT / "tests" / "test_ml_phase_a.mjs"
        proc = subprocess.run(
            [node_bin, "--test", str(test_file)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            self.fail(f"Fallo en test_ml_phase_a.mjs:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")


if __name__ == "__main__":
    unittest.main()
