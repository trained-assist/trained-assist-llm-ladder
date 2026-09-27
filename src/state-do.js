// LadderState Durable Object — ONE global instance holds model health + Go key rotation for every
// caller, with strong consistency (all requests serialize through this object). Methods are called
// via Workers RPC from src/index.js; state persists in the object's storage.

import { DurableObject } from 'cloudflare:workers';
import * as S from './state.js';

const KEY = 'state';

export class LadderState extends DurableObject {
  async _load() {
    if (!this._state) this._state = (await this.ctx.storage.get(KEY)) || S.emptyState();
    return this._state;
  }

  async _save() {
    await this.ctx.storage.put(KEY, this._state);
  }

  async snapshot(poolSize) {
    return S.snapshot(await this._load(), poolSize);
  }

  async recordFailure(model, failure) {
    S.recordFailure(await this._load(), model, failure);
    await this._save();
  }

  async recordSuccess(model) {
    const st = await this._load();
    if (!st.health[model]) return;
    S.recordSuccess(st, model);
    await this._save();
  }

  async rotateKey(poolSize, ttlMs) {
    const r = S.rotateKey(await this._load(), poolSize, ttlMs);
    await this._save();
    return r;
  }

  async park(models, untilMs) {
    S.park(await this._load(), models, untilMs);
    await this._save();
  }

  async reset() {
    this._state = S.emptyState();
    await this._save();
  }
}
