/** File dédupliquée : la tâche suivante attend la fin de la précédente. */
export class SerialQueue<T> {
  private readonly attente: T[] = [];
  private readonly presents = new Set<T>();
  private active = false;

  private readonly executer: (item: T) => Promise<void>;
  private readonly patienter: () => Promise<void>;

  constructor(executer: (item: T) => Promise<void>, patienter: () => Promise<void>) {
    this.executer = executer;
    this.patienter = patienter;
  }

  ajouter(item: T): void {
    if (this.presents.has(item)) return;
    this.presents.add(item);
    this.attente.push(item);
    void this.pomper();
  }

  private async pomper(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.attente.length) {
        const item = this.attente.shift() as T;
        try {
          await this.patienter();
          await this.executer(item);
        } catch {
          // Une tâche échouée ne bloque pas les suivantes.
        } finally {
          this.presents.delete(item);
        }
      }
    } finally {
      this.active = false;
    }
  }
}
