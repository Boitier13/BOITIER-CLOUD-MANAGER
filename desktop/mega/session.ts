/**
 * Session MEGA : ouverture, restauration, quota.
 *
 * Le mot de passe ne sert qu'à ouvrir une session ; il n'est jamais écrit. La
 * session sérialisée (clé maître + identifiant de session) est conservée
 * chiffrée par le système, ce qui permet de retrouver les comptes au lancement
 * suivant sans rien redemander.
 */

import { Storage } from 'megajs';
import { log } from '../log.ts';
import { codeErreurMega, exigeDeuxEtapes, messageErreurMega, sessionExpiree } from './files.ts';
import type { MegaStoredAccount, MegaVault } from './store.ts';

export interface MegaAccountInfo {
  /** Identifiant MEGA (handle utilisateur) : stable, jamais un jeton. */
  accountId: string;
  name: string;
  email: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
}

/** Erreur portant le besoin d'un code de vérification en deux étapes. */
export class DeuxEtapesRequises extends Error {
  constructor() {
    super('vérification en deux étapes requise');
    this.name = 'DeuxEtapesRequises';
  }
}

/**
 * Durée de la garde après un blocage MEGA (-16).
 *
 * MEGA bloque un compte quand trop de connexions arrivent d'un coup depuis la
 * même adresse. Réessayer pendant la garde ne fait qu'allonger le blocage :
 * trois minutes étaient visiblement trop courtes, le compte retombait bloqué
 * aussitôt. Dix minutes laissent passer la fenêtre côté MEGA.
 */
const GARDE_BLOCAGE_MS = 10 * 60_000;

/**
 * Pause entre deux restaurations de session.
 *
 * Onze comptes relus à la suite, sans respirer, suffisent à déclencher le
 * blocage anti-abus de MEGA : chaque restauration est donc espacée.
 */
const PAUSE_ENTRE_SESSIONS_MS = 400;

export class MegaSession {
  private readonly vault: MegaVault;
  /** Sessions ouvertes dans ce lancement. */
  private readonly vivantes = new Map<string, Storage>();
  /** Espace mesuré (mis en cache pour l'affichage). */
  private readonly mesures = new Map<string, { usedBytes: number; quotaBytes: number }>();
  /** Ouvertures en cours : deux demandes simultanées ne connectent qu'une fois. */
  private readonly ouvertures = new Map<string, Promise<Storage>>();
  /** Comptes dont MEGA a refusé la session pendant ce lancement. */
  private readonly expirees = new Set<string>();
  /**
   * Comptes bloqués par MEGA (`-16`), avec la date de fin de la garde.
   *
   * Réessayer pendant le blocage ne fait qu'allonger celui-ci. On attend donc
   * quelques minutes avant de retenter, et l'interface affiche une raison
   * lisible en attendant.
   */
  private readonly bloques = new Map<string, number>();
  /**
   * File d'attente des restaurations : une seule session ouverte à la fois.
   *
   * Onze comptes affichés au démarrage lançaient onze relectures d'arborescence
   * en parallèle : le processus principal se figeait plusieurs dizaines de
   * secondes et MEGA finissait par bloquer le compte.
   */
  private file: Promise<unknown> = Promise.resolve();
  /** Horodatage de la dernière ouverture : sert à espacer les restaurations. */
  private derniereOuverture = 0;

  constructor(vault: MegaVault) {
    this.vault = vault;
  }

  /** Comptes connus — sans requête réseau : les mesures sont celles du dernier passage. */
  async accounts(): Promise<MegaAccountInfo[]> {
    const stockes = await this.vault.read();
    return stockes.map((compte) => this.enInfo(compte));
  }

  private enInfo(compte: MegaStoredAccount): MegaAccountInfo {
    const mesure = this.mesures.get(compte.id);
    return {
      accountId: compte.id,
      name: compte.name || compte.email,
      email: compte.email,
      usedBytes: mesure?.usedBytes ?? compte.usedBytes ?? 0,
      quotaBytes: mesure?.quotaBytes ?? compte.quotaBytes ?? 0,
      status: this.expirees.has(compte.id) ? 'expired' : 'connected',
    };
  }

  /**
   * Ouvre une session avec les identifiants fournis.
   *
   * `secondFactor` n'est demandé qu'une fois : si MEGA réclame un code et qu'il
   * n'a pas été fourni, l'erreur remonte sous une forme que l'interface sait
   * reconnaître, pour afficher le champ au lieu d'un « -26 » incompréhensible.
   */
  async connect(
    email: string,
    password: string,
    secondFactor?: string,
  ): Promise<MegaAccountInfo> {
    const adresse = email.trim().toLowerCase();
    if (!adresse || !password) throw new Error('adresse et mot de passe requis');

    let storage: Storage;
    try {
      storage = new Storage({
        email: adresse,
        password,
        ...(secondFactor ? { secondFactorCode: secondFactor.trim() } : {}),
        autoload: true,
        autologin: true,
        // Pas de connexion permanente. Avec `keepalive`, MEGA maintient un
        // canal par compte : onze comptes ouverts donnaient onze canaux, des
        // erreurs -16 (EBLOCKED, « compte bloqué ») et des promesses rejetées
        // non capturées à l'intérieur de `megajs`. Rien ici n'a besoin d'être
        // prévenu par le serveur : chaque action rouvre ce qu'il faut.
        keepalive: false,
      });
      await storage.ready;
    } catch (cause) {
      if (exigeDeuxEtapes(cause)) throw new DeuxEtapesRequises();
      throw new Error(messageErreurMega(cause));
    }

    const id = storage.user || adresse;
    const nom = storage.name || adresse;
    this.vivantes.set(id, storage);
    this.expirees.delete(id);
    this.bloques.delete(id);

    const mesure = await this.mesurer(id, storage);
    const json = storage.toJSON();
    // On ne conserve que de quoi rouvrir la session : `options` contient les
    // identifiants de connexion et n'a rien à faire sur le disque.
    const session = { key: json.key, sid: json.sid, name: nom, user: id };

    const anciens = await this.vault.read();
    const suivant: MegaStoredAccount[] = [
      ...anciens.filter((compte) => compte.id !== id),
      {
        id,
        email: adresse,
        name: nom,
        session,
        addedAt: new Date().toISOString(),
        usedBytes: mesure.usedBytes,
        quotaBytes: mesure.quotaBytes,
      },
    ];
    await this.vault.write(suivant);
    log(`MEGA : compte ${adresse} connecté (${mesure.usedBytes}/${mesure.quotaBytes} o)`);

    return {
      accountId: id,
      name: nom,
      email: adresse,
      usedBytes: mesure.usedBytes,
      quotaBytes: mesure.quotaBytes,
      status: 'connected',
    };
  }

  /** Ferme toutes les sessions ouvertes (fermeture de l'application). */
  async closeAll(): Promise<void> {
    const ouvertes = [...this.vivantes.values()];
    this.vivantes.clear();
    for (const storage of ouvertes) {
      try {
        await storage.close();
      } catch {
        /* déjà fermée côté MEGA */
      }
    }
  }

  /** Ferme la session et efface le compte du disque. */
  async disconnect(accountId: string): Promise<void> {
    const storage = this.vivantes.get(accountId);
    this.vivantes.delete(accountId);
    this.ouvertures.delete(accountId);
    this.mesures.delete(accountId);
    this.expirees.delete(accountId);
    if (storage) {
      try {
        await storage.close();
      } catch {
        /* la session est peut-être déjà fermée côté MEGA */
      }
    }
    const restants = (await this.vault.read()).filter((compte) => compte.id !== accountId);
    await this.vault.write(restants);
    log(`MEGA : compte ${accountId} déconnecté`);
  }

  /**
   * Session utilisable pour ce compte, restaurée depuis le disque au besoin.
   *
   * Une session refusée par MEGA n'est pas effacée : elle est marquée expirée,
   * l'interface propose de reconnecter, et l'utilisateur ne perd pas la fiche du
   * compte (nom, adresse, dernier quota connu).
   */
  async storage(accountId: string): Promise<Storage> {
    const vivante = this.vivantes.get(accountId);
    if (vivante) return vivante;
    const enCours = this.ouvertures.get(accountId);
    if (enCours) return enCours;

    const garde = this.bloques.get(accountId) ?? 0;
    if (garde > Date.now()) {
      throw new Error(
        'MEGA bloque temporairement ce compte (trop de connexions) : patientez quelques minutes',
      );
    }

    // Mise à la file : une session à la fois, et espacées. Onze relectures
    // d'affilée déclenchent le blocage anti-abus de MEGA : la pause laisse
    // passer la fenêtre, sans retarder la toute première ouverture.
    const ouverture = this.file
      .catch(() => undefined)
      .then(async () => {
        const attente = this.derniereOuverture + PAUSE_ENTRE_SESSIONS_MS - Date.now();
        if (this.derniereOuverture > 0 && attente > 0) {
          await new Promise((resolve) => setTimeout(resolve, attente));
        }
        this.derniereOuverture = Date.now();
        return this.restaurer(accountId);
      })
      .finally(() => {
        this.ouvertures.delete(accountId);
      });
    this.ouvertures.set(accountId, ouverture);
    this.file = ouverture.catch(() => undefined);
    return ouverture;
  }

  private async restaurer(accountId: string): Promise<Storage> {
    const compte = (await this.vault.read()).find((item) => item.id === accountId);
    if (!compte) throw new Error('compte MEGA inconnu : reconnectez-le');

    const storage = Storage.fromJSON({
      key: compte.session.key,
      sid: compte.session.sid,
      name: compte.session.name,
      user: compte.session.user,
      // Les identifiants ne sont pas conservés : `megajs` exige une forme
      // d'options pour construire l'objet, et n'en a pas besoin pour une
      // session restaurée (`autologin: false`).
      options: {
        email: compte.email,
        password: '',
        autoload: true,
        autologin: false,
        keepalive: false,
      },
    });

    try {
      await storage.ready;
      // Une session restaurée n'est « prête » qu'une fois son arborescence
      // relue ; sans ce drapeau, `mkdir`/`upload` refusent d'agir.
      (storage as unknown as { status: string }).status = 'ready';
      await storage.reload(true);
    } catch (cause) {
      if (sessionExpiree(cause)) {
        this.expirees.add(accountId);
        throw new Error('session MEGA expirée : reconnectez ce compte');
      }
      if (codeErreurMega(cause) === 16) {
        // Blocage temporaire côté MEGA : on ne réessaie pas tout de suite.
        // Le code est lu dans le texte quand il n'est pas porté par l'erreur :
        // l'erreur réelle était `EBLOCKED (-16): User blocked`, sans `code`.
        this.bloques.set(accountId, Date.now() + GARDE_BLOCAGE_MS);
        log(`MEGA : compte ${accountId} temporairement bloqué par MEGA (-16)`);
      }
      throw new Error(messageErreurMega(cause));
    }

    this.vivantes.set(accountId, storage);
    log(`MEGA : session restaurée pour ${compte.email}`);
    return storage;
  }

  /** Espace utilisé et total, mis en cache. */
  async mesurer(accountId: string, storageConnu?: Storage): Promise<{ usedBytes: number; quotaBytes: number }> {
    const storage = storageConnu ?? (await this.storage(accountId));
    try {
      const infos = await storage.getAccountInfo();
      const mesure = {
        usedBytes: Math.max(0, Number(infos.spaceUsed) || 0),
        quotaBytes: Math.max(0, Number(infos.spaceTotal) || 0),
      };
      this.mesures.set(accountId, mesure);
      const comptes = await this.vault.read();
      const cible = comptes.find((compte) => compte.id === accountId);
      if (cible) {
        await this.vault.write(
          comptes.map((compte) =>
            compte.id === accountId
              ? { ...compte, usedBytes: mesure.usedBytes, quotaBytes: mesure.quotaBytes }
              : compte,
          ),
        );
      }
      return mesure;
    } catch (cause) {
      if (sessionExpiree(cause)) {
        this.expirees.add(accountId);
        throw new Error('session MEGA expirée : reconnectez ce compte');
      }
      if (codeErreurMega(cause) === 16) {
        this.bloques.set(accountId, Date.now() + GARDE_BLOCAGE_MS);
      }
      throw new Error(messageErreurMega(cause));
    }
  }
}
