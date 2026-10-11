// Cambio di tono "a giunte allineate".
// La voce si legge più veloce (tono più alto) o più lenta (tono più basso) da una piccola memoria.
// Quando la lettura sta per raggiungere il presente, o resta troppo indietro, salta avanti o indietro
// di un pezzetto e sfuma fra il vecchio e il nuovo punto in 8 ms. Il salto non è fisso: si sceglie
// quello in cui la forma d'onda combacia meglio, così la giunta cade in fase e non si sentono scatti.
// Non serve riconoscere il tono della voce, quindi funziona uguale su vocali, consonanti e rumore.

const RING = 1 << 15;
const MASK = RING - 1;

class VoceTono extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sr = sampleRate;
    this.buf = new Float32Array(RING);
    this.W = 0; // campioni scritti finora (indice assoluto)
    this.F = Math.round(0.008 * sr); // durata della sfumatura
    this.M = Math.round(0.005 * sr); // finestra di confronto
    this.Jmin = Math.round(0.006 * sr); // salto minimo
    this.Jmax = Math.round(0.016 * sr); // salto massimo (un periodo anche per voci a 62 Hz)
    this.guard = 8;
    this.ref = new Float32Array(this.M);
    this.zeros = new Float32Array(128);

    this.ratio = 1;
    this.pos = -1; // punto di lettura (indice assoluto, con decimali); -1 = da posizionare
    this.oldPos = 0;
    this.fade = 0; // campioni di sfumatura che restano
    this.mix = 0;
    this.mixTarget = 0;
    this.mixStep = 1 / (0.015 * sr);
    this.splices = 0;

    this.port.onmessage = (e) => this.setSemitones((e.data || {}).semitones);
    // Quando la voce si applica a una registrazione il tono arriva subito con le opzioni,
    // così anche il primo pezzetto è già trasformato
    const o = options && options.processorOptions;
    if (o && typeof o.semitones === "number") {
      this.setSemitones(o.semitones);
      this.mix = this.mixTarget;
    }
  }

  setSemitones(st) {
    if (typeof st !== "number") return;
    this.ratio = Math.pow(2, st / 12);
    this.mixTarget = Math.abs(st) < 0.01 ? 0 : 1;
  }

  read(p) {
    const b = this.buf;
    const i = Math.floor(p);
    const f = p - i;
    const xm1 = b[(i - 1) & MASK];
    const x0 = b[i & MASK];
    const x1 = b[(i + 1) & MASK];
    const x2 = b[(i + 2) & MASK];
    return x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
  }

  // Cerca il salto (dir = -1 indietro, +1 avanti) in cui i 5 ms prima del nuovo punto
  // somigliano di più ai 5 ms prima del punto attuale
  bestJump(dir, minJ, maxJ) {
    const b = this.buf;
    const M = this.M;
    const ref = this.ref;
    const p0 = Math.floor(this.pos);
    let eRef = 0;
    for (let k = 0; k < M; k++) {
      const v = b[(p0 - M + k) & MASK];
      ref[k] = v;
      eRef += v * v;
    }
    const Jmin = Math.max(this.Jmin, minJ);
    const Jmax = Math.max(Jmin, Math.min(this.Jmax, maxJ));
    if (Jmax <= Jmin || eRef < 1e-9) return Jmin;
    const span = Jmax - Jmin;
    let best = Jmin;
    let bestScore = -Infinity;
    // ricerca grossolana (passo 3, metà dei campioni), poi rifinitura
    for (let J = Jmin; J <= Jmax; J += 3) {
      const c = p0 + dir * J - M;
      let s = 0;
      let e = 0;
      for (let k = 0; k < M; k += 2) {
        const v = b[(c + k) & MASK];
        s += ref[k] * v;
        e += v * v;
      }
      const score = s / Math.sqrt(e * eRef * 0.5 + 1e-12) - (0.03 * (J - Jmin)) / span;
      if (score > bestScore) {
        bestScore = score;
        best = J;
      }
    }
    const lo = Math.max(Jmin, best - 2);
    const hi = Math.min(Jmax, best + 2);
    bestScore = -Infinity;
    let fine = best;
    for (let J = lo; J <= hi; J++) {
      const c = p0 + dir * J - M;
      let s = 0;
      let e = 0;
      for (let k = 0; k < M; k++) {
        const v = b[(c + k) & MASK];
        s += ref[k] * v;
        e += v * v;
      }
      const score = s / Math.sqrt(e * eRef + 1e-12);
      if (score > bestScore) {
        bestScore = score;
        fine = J;
      }
    }
    return fine;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const inp = inputs[0] && inputs[0][0];
    const x = inp && inp.length === n ? inp : this.zeros.length === n ? this.zeros : (this.zeros = new Float32Array(n));
    const b = this.buf;
    const W0 = this.W;
    for (let i = 0; i < n; i++) b[(W0 + i) & MASK] = x[i];
    this.W = W0 + n;

    const r = this.ratio;
    const active = this.mix > 0 || this.mixTarget > 0;
    const F = this.F;
    const guard = this.guard;
    const dLow = (r - 1) * F + guard; // sotto questo ritardo, con tono alto, salto indietro
    const dHigh = this.Jmax + guard + 2; // sopra questo ritardo, con tono basso, salto avanti
    if (!active) this.pos = -1;
    else if (this.pos < 0) {
      this.pos = W0 - (r > 1 ? dLow + this.Jmin : guard + this.Jmin);
      this.fade = 0;
    }

    for (let i = 0; i < n; i++) {
      let wet = 0;
      if (active) {
        const now = W0 + i + 1; // come se l'ingresso arrivasse un campione alla volta
        if (this.fade === 0) {
          const d = now - this.pos;
          if (r > 1 && d < dLow) {
            // il salto deve bastare a coprire tutta la sfumatura, altrimenti la lettura supererebbe il presente
            const J = this.bestJump(-1, Math.ceil((r - 1) * F + (dLow - d)) + 1, this.Jmax);
            this.oldPos = this.pos;
            this.pos -= J;
            this.fade = F;
            this.splices++;
          } else if (r < 1 && d > dHigh) {
            const J = this.bestJump(1, 0, Math.floor(d - guard - 2));
            this.oldPos = this.pos;
            this.pos += J;
            this.fade = F;
            this.splices++;
          }
        }
        if (this.fade > 0) {
          const g = 0.5 - 0.5 * Math.cos((Math.PI * (F - this.fade)) / F);
          wet = (1 - g) * this.read(this.oldPos) + g * this.read(this.pos);
          this.oldPos += r;
          this.fade--;
        } else {
          wet = this.read(this.pos);
        }
        this.pos += r;
      }
      if (this.mix < this.mixTarget) this.mix = Math.min(this.mixTarget, this.mix + this.mixStep);
      else if (this.mix > this.mixTarget) this.mix = Math.max(this.mixTarget, this.mix - this.mixStep);
      out[i] = x[i] * (1 - this.mix) + wet * this.mix;
    }
    return true;
  }
}

registerProcessor("voce-tono", VoceTono);

// Registratore di riserva: copia il microfono così com'è e lo passa alla pagina a pezzi da 4096 campioni.
// Serve quando il registratore del telefono manca o produce un file che non si riesce a leggere.
class VoceRegistra extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunk = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      const cmd = (e.data || {}).cmd;
      if (cmd === "start") {
        this.on = true;
        this.n = 0;
      } else if (cmd === "stop") {
        this.on = false;
        if (this.n) this.port.postMessage({ chunk: this.chunk.slice(0, this.n) });
        this.n = 0;
        this.port.postMessage({ done: true });
      }
    };
  }

  process(inputs) {
    if (this.on) {
      const x = inputs[0] && inputs[0][0];
      const len = x ? x.length : 128;
      for (let i = 0; i < len; i++) {
        this.chunk[this.n++] = x ? x[i] : 0;
        if (this.n === this.chunk.length) {
          this.port.postMessage({ chunk: this.chunk }, [this.chunk.buffer]);
          this.chunk = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("voce-registra", VoceRegistra);
