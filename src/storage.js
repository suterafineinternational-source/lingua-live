export class InMemoryEventStorage {
  constructor() {
    this.events = new Map();
    this.transcripts = new Map();
  }

  async saveEvent(event) {
    this.events.set(event.code, structuredClone(event));
  }

  async appendTranscript(roomCode, row) {
    const rows = this.transcripts.get(roomCode) || [];
    const index = rows.findIndex((item) => item.id === row.id);
    if (index >= 0) rows[index] = structuredClone(row);
    else rows.push(structuredClone(row));
    this.transcripts.set(roomCode, rows);
  }

  async getTranscript(roomCode) {
    return structuredClone(this.transcripts.get(roomCode) || []);
  }
}

// Production adapters should implement the same async contract:
// saveEvent(event), appendTranscript(roomCode, row), getTranscript(roomCode).
export function createStorage(options = {}) {
  return options.storage || new InMemoryEventStorage();
}
