"""
Verifica que FirebaseBackend.applyTier1Upgrade use this.dekKey y persista
correctamente la reconciliación Tier 1.
"""

import shutil
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class TestTier1Upgrade(unittest.TestCase):
    def test_apply_tier1_upgrade_uses_dek_key(self):
        node_bin = shutil.which("node")
        if not node_bin:
            self.skipTest("Node.js no está disponible en PATH")
        test_file = PROJECT_ROOT / "tests" / "test_tier1_upgrade.mjs"
        proc = subprocess.run(
            [node_bin, "--test", str(test_file)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            self.fail(f"Fallo en test_tier1_upgrade.mjs:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")


if __name__ == "__main__":
    unittest.main()
