'use strict';

const fs = require('fs');
const path = require('path');

class ProviderVisibilityStore {
  constructor(file, providerIds, onError = () => {}) {
    this.file = file;
    this.providerIds = new Set(providerIds);
    this.onError = onError;
    this.hidden = new Set();
  }

  normalize(value) {
    const hidden = value && Array.isArray(value.hidden) ? value.hidden : [];
    return new Set(hidden.filter(id => this.providerIds.has(id)));
  }

  load() {
    try {
      this.hidden = this.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.onError(error);
      this.hidden = new Set();
    }
    return this.snapshot();
  }

  save(value) {
    this.hidden = this.normalize(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    return this.snapshot();
  }

  isVisible(providerId) {
    return !this.hidden.has(String(providerId || ''));
  }

  snapshot() {
    return { hidden: [...this.hidden] };
  }
}

module.exports = { ProviderVisibilityStore };
