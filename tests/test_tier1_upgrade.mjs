import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadFirebaseBackend() {
  const code = fs.readFileSync(
    path.join(ROOT, "frontend/js/firebase_backend.js"),
    "utf8"
  );
  const ctx = {
    console,
    Map,
    Set,
    Date,
    Promise,
    ClientEngine: {
      LAYA_QUESTIONS: [],
      calculateSleepHours: () => 7
    },
    DayEditorComponent: undefined
  };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nthis.FirebaseBackend = FirebaseBackend;`, ctx);
  return ctx.FirebaseBackend;
}

test("applyTier1Upgrade usa this.dekKey (no this.vaultKey) y persiste la actualización", async () => {
  const backend = loadFirebaseBackend();
  const revision = "2026-11-18T12:00:00.000Z";
  let writtenBundle = null;

  const baseEntry = {
    date: "2026-11-18",
    updated_at: revision,
    day_text: "Hoy tuve un día pesado pero pude descansar.",
    questionnaire: { self_report_word: "bien", valence_rating: 4 },
    ml_tier: "tier_0_local",
    daily_reflection: { title: "Previo" }
  };

  backend.user = { uid: "u-test-1" };
  backend.dekKey = null;
  backend.vaultKey = { legacy: true }; // No debe usarse jamás
  backend._readDayBundle = async () => ({
    entry: { ...baseEntry },
    quick_notes: []
  });
  backend._writeDayBundle = async (entryId, bundle) => {
    writtenBundle = { entryId, bundle };
  };
  backend._getOrInitProfile = async () => ({ goals: [] });
  backend._buildDayFullText = (text) => text;
  backend._recordDevTrace = () => {};
  backend._finalizeTraceProfile = ({ detailedTrace }) => ({
    layaProfile: { source: "tier1", trace: detailedTrace },
    safety: { level: "low" },
    discrepancy: { has_discrepancy: false },
    goalAlignment: { score: 1 },
    dailyReflection: {
      card_id: "c1",
      theme: "calma",
      title: "Cierre Tier 1",
      chronicle: "Crónica reconciliada",
      suggestion: "Descansa bien",
      safety_locked: false
    }
  });

  // Sin dekKey debe retornar null incluso si vaultKey estuviera definido
  const skipped = await backend.applyTier1Upgrade("2026-11-18", revision, { raw_usage: {} });
  assert.equal(skipped, null);
  assert.equal(writtenBundle, null);

  // Con dekKey válido debe persistir la actualización Tier 1
  delete backend.vaultKey;
  backend.dekKey = { type: "secret" };
  const upgraded = await backend.applyTier1Upgrade("2026-11-18", revision, {
    raw_usage: { backend: "laya-onnx-q8-worker" }
  });

  assert.ok(upgraded);
  assert.equal(upgraded.ml_tier, "tier_1_onnx_q8");
  assert.ok(upgraded.tier1_reconciled_at);
  assert.equal(upgraded.daily_reflection.title, "Cierre Tier 1");
  assert.ok(writtenBundle);
  assert.equal(writtenBundle.entryId, "2026-11-18");
  assert.equal(writtenBundle.bundle.entry.ml_tier, "tier_1_onnx_q8");
});
