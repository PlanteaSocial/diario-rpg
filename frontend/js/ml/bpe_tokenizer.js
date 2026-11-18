/**
 * Tokenizador BPE + Metaspace + Byte-Fallback 100% puro en JavaScript (< 8 KB).
 * Compatible con tokenizer_es.json recortado desde laya_finetuned (mmBERT / Gemma BPE).
 * Funciona tanto en Web Worker (self.BpeTokenizer) como en Node/navegador.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BpeTokenizer = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const METASPACE = "\u2581"; // "▁"
  const utf8Encoder = new TextEncoder();

  function toByteToken(byteVal) {
    return `<0x${byteVal.toString(16).toUpperCase().padStart(2, "0")}>`;
  }

  class TokenizerInstance {
    constructor(spec) {
      this.spec = spec || {};
      this.vocab = spec.vocab || {};
      this.bosId = spec.bos_id != null ? spec.bos_id : 2;
      this.eosId = spec.eos_id != null ? spec.eos_id : 1;
      this.unkId = spec.unk_id != null ? spec.unk_id : 3;
      this.padId = spec.pad_id != null ? spec.pad_id : 0;

      this.mergeRanks = new Map();
      const merges = spec.merges || [];
      for (let i = 0; i < merges.length; i++) {
        const entry = merges[i];
        const key = Array.isArray(entry) ? `${entry[0]}\u0000${entry[1]}` : entry.replace(" ", "\u0000");
        this.mergeRanks.set(key, i);
      }
      this._pieceCache = new Map();
    }

    _bpePiece(piece) {
      if (this._pieceCache.has(piece)) {
        return this._pieceCache.get(piece);
      }
      let word = [];
      for (const ch of Array.from(piece)) {
        if (Object.prototype.hasOwnProperty.call(this.vocab, ch)) {
          word.push(ch);
        } else {
          const bytes = utf8Encoder.encode(ch);
          for (let b = 0; b < bytes.length; b++) {
            word.push(toByteToken(bytes[b]));
          }
        }
      }

      while (word.length > 1) {
        let bestRank = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < word.length - 1; i++) {
          const rank = this.mergeRanks.get(`${word[i]}\u0000${word[i + 1]}`);
          if (rank !== undefined && rank < bestRank) {
            bestRank = rank;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) break;
        const merged = word[bestIdx] + word[bestIdx + 1];
        word.splice(bestIdx, 2, merged);
      }

      const ids = [];
      for (const sym of word) {
        if (Object.prototype.hasOwnProperty.call(this.vocab, sym)) {
          ids.push(this.vocab[sym]);
        } else {
          const bytes = utf8Encoder.encode(sym);
          for (let b = 0; b < bytes.length; b++) {
            const bt = toByteToken(bytes[b]);
            ids.push(Object.prototype.hasOwnProperty.call(this.vocab, bt) ? this.vocab[bt] : this.unkId);
          }
        }
      }

      if (this._pieceCache.size > 4096) this._pieceCache.clear();
      this._pieceCache.set(piece, ids);
      return ids;
    }

    encode(text, maxLength = 128) {
      const normalized = String(text || "").replace(/ /g, METASPACE);
      const prefixed = normalized.length > 0 ? `${METASPACE}${normalized}` : "";
      const pieces = prefixed ? prefixed.split(/(?=\u2581)/).filter(Boolean) : [];

      const contentIds = [];
      const limit = Math.max(4, maxLength - 2);
      for (let i = 0; i < pieces.length && contentIds.length < limit; i++) {
        const pieceIds = this._bpePiece(pieces[i]);
        for (let j = 0; j < pieceIds.length && contentIds.length < limit; j++) {
          contentIds.push(pieceIds[j]);
        }
      }

      const inputIds = [this.bosId, ...contentIds, this.eosId];
      const attentionMask = new Array(inputIds.length).fill(1);
      return { inputIds, attentionMask };
    }
  }

  return {
    TokenizerInstance,
    create(spec) {
      return new TokenizerInstance(spec);
    }
  };
});
