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
 * MEGA indique un blocage sans préciser sa cause ni sa durée. La garde limite
 * les tentatives automatiques ; elle ne garantit pas que MEGA lèvera le blocage.
 */
const GARDE_BLOCAGE_MS = 10 * 60_000;

/**
 * Nombre de sessions gardées ouvertes en mémoire.
 *
 * Rouvrir une session MEGA, c'est télécharger **toute** l'arborescence du
 * compte et la garder en mémoire. Limiter les sessions inutilisées réduit la
 * charge potentielle ; la cause exacte des figements reste à mesurer.
 */
const MAX_SESSIONS_OUVERTES = 2;

/**
 * Pause entre deux restaurations de session.
 *
 * Espacer les restaurations limite les rafales de requêtes vers MEGA.
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
   * Évite les tentatives automatiques répétées ; la durée du blocage chez MEGA
   * est inconnue.
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
  /** Dernière utilisation de chaque session ouverte (pour libérer la plus froide). */
  private readonly usages = new Map<string, number>();
  /** Sessions retenues par un transfert en cours : jamais fermées sous lui. */
  private readonly retenues = new Map<string, number>();

  private readonly creerSession: (options: ConstructorParameters<typeof Storage>[0]) => Storage;
  private readonly restaurerSession: typeof Storage.fromJSON;

  constructor(
    vault: MegaVault,
    creerSession: (options: ConstructorParameters<typeof Storage>[0]) => Storage = (options) => new Storage(options),
    restaurerSession: typeof Storage.fromJSON = (json) => Storage.fromJSON(json),
  ) {
    this.vault = vault;
    this.creerSession = creerSession;
    this.restaurerSession = restaurerSession;
  }

  /** Libère les ressources locales sans invalider la session sauvegardée chez MEGA. */
  private fermerLocalement(storage: Storage): void {
    // Storage.close() envoie « sml » (logout) : ne pas l'utiliser ici !
    storage.api.close();
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
    // Ne pas laisser une restauration ancienne remplacer une nouvelle session.
    const connexion = this.file.catch(() => undefined).then(() =>
      this.connecter(email, password, secondFactor),
    );
    this.file = connexion.catch(() => undefined);
    return connexion;
  }

  private async connecter(
    email: string,
    password: string,
    secondFactor?: string,
  ): Promise<MegaAccountInfo> {
    const adresse = email.trim().toLowerCase();
    if (!adresse || !password) throw new Error('adresse et mot de passe requis');

    log('MEGA : connexion demandée');
    let storage: Storage | undefined;
    try {
      storage = this.creerSession({
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
      if (storage) this.fermerLocalement(storage);
      const code = codeErreurMega(cause);
      // Aucun message brut ni identifiant : ils peuvent contenir des secrets.
      log(`MEGA : connexion échouée · ${code ? `code -${code}` : 'erreur non identifiée'}`);
      if (exigeDeuxEtapes(cause)) throw new DeuxEtapesRequises();
      throw new Error(messageErreurMega(cause));
    }

    const id = storage.user || adresse;
    const nom = storage.name || adresse;
    const json = storage.toJSON();
    const session = { key: json.key, sid: json.sid, name: nom, user: id };

    try {
      const anciens = await this.vault.read();
      const ancien = anciens.find((compte) => compte.id === id);
      await this.vault.write([
        ...anciens.filter((compte) => compte.id !== id),
        {
          id, email: adresse, name: nom, session,
          addedAt: ancien?.addedAt ?? new Date().toISOString(),
          usedBytes: ancien?.usedBytes ?? 0,
          quotaBytes: ancien?.quotaBytes ?? 0,
        },
      ]);
      // Ne pas fermer l'ancienne instance sous un transfert actif. Avec
      // keepalive désactivé elle sera libérée une fois les opérations finies.
      const precedente = this.vivantes.get(id);
      if (precedente && !this.retenues.has(id)) this.fermerLocalement(precedente);
      this.vivantes.set(id, storage);
      this.expirees.delete(id);
      this.bloques.delete(id);
      this.toucher(id);
      log('MEGA : connexion enregistrée');
      return {
        accountId: id, name: nom, email: adresse,
        usedBytes: ancien?.usedBytes ?? 0, quotaBytes: ancien?.quotaBytes ?? 0,
        status: 'connected',
      };
    } catch (cause) {
      this.fermerLocalement(storage);
      log('MEGA : connexion impossible à enregistrer dans le coffre');
      throw cause;
    }
  }

  /** Ferme toutes les sessions ouvertes (fermeture de l'application). */
  async closeAll(): Promise<void> {
    const ouvertes = [...this.vivantes.values()];
    this.vivantes.clear();
    for (const storage of ouvertes) {
      this.fermerLocalement(storage);
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
    if (vivante) {
      this.toucher(accountId);
      return vivante;
    }
    const enCours = this.ouvertures.get(accountId);
    if (enCours) return enCours;

    const garde = this.bloques.get(accountId) ?? 0;
    if (garde > Date.now()) {
      throw new Error(
        'MEGA indique que ce compte est bloqué : patientez avant de réessayer. Si le blocage persiste, contactez l’assistance MEGA.',
      );
    }

    // Mise à la file : une session à la fois, et espacées. Onze relectures
    // d'affilée sollicitent fortement MEGA ; la pause évite une rafale,
    // sans retarder la toute première ouverture.
    const ouverture = this.file
      .catch(() => undefined)
      .then(async () => {
        // Une reconnexion a pu aboutir pendant l'attente dans la file.
        const existante = this.vivantes.get(accountId);
        if (existante) {
          this.toucher(accountId);
          return existante;
        }
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

  /**
   * Retient une session pendant un transfert : elle ne sera pas fermée pour
   * faire de la place, même si un autre compte est consulté entre-temps.
   */
  retenir(accountId: string): void {
    this.retenues.set(accountId, (this.retenues.get(accountId) ?? 0) + 1);
  }

  /** Fin du transfert : la session redevient libérable. */
  relacher(accountId: string): void {
    const reste = (this.retenues.get(accountId) ?? 0) - 1;
    if (reste > 0) this.retenues.set(accountId, reste);
    else {
      this.retenues.delete(accountId);
      this.liberer('');
    }
  }

  /** Marque la session comme utilisée à l'instant, puis libère les plus froides. */
  private toucher(accountId: string): void {
    this.usages.set(accountId, Date.now());
    this.liberer(accountId);
  }

  /**
   * Ferme les sessions les plus anciennes au-delà du plafond.
   *
   * La fermeture est silencieuse : ce qui compte est la mémoire rendue. Une
   * session fermée se rouvre toute seule au prochain accès — c'est le prix
   * d'un compte MEGA, pas une perte.
   */
  private liberer(sauf: string): void {
    if (this.vivantes.size <= MAX_SESSIONS_OUVERTES) return;
    const candidats = [...this.vivantes.keys()]
      .filter((id) => id !== sauf && !this.retenues.has(id))
      .sort((a, b) => (this.usages.get(a) ?? 0) - (this.usages.get(b) ?? 0));
    while (this.vivantes.size > MAX_SESSIONS_OUVERTES && candidats.length) {
      const id = candidats.shift() as string;
      const storage = this.vivantes.get(id);
      this.vivantes.delete(id);
      this.usages.delete(id);
      log(`MEGA : session libérée (${this.vivantes.size + 1} ouvertes, plafond ${MAX_SESSIONS_OUVERTES})`);
      if (storage) this.fermerLocalement(storage);
    }
  }

  private async restaurer(accountId: string): Promise<Storage> {
    const compte = (await this.vault.read()).find((item) => item.id === accountId);
    if (!compte) throw new Error('compte MEGA inconnu : reconnectez-le');

    const storage = this.restaurerSession({
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
      const debut = performance.now();
      try {
        await storage.reload(true);
      } finally {
        const duree = performance.now() - debut;
        if (duree >= 500) log(`durée : MEGA restauration ${Math.round(duree)} ms (réseau et traitement)`);
      }
    } catch (cause) {
      this.fermerLocalement(storage);
      if (sessionExpiree(cause)) {
        this.expirees.add(accountId);
        throw new Error('session MEGA expirée : reconnectez ce compte');
      }
      if (codeErreurMega(cause) === 16) {
        // MEGA indique un blocage : on ne réessaie pas tout de suite.
        // Le code est lu dans le texte quand il n'est pas porté par l'erreur :
        // l'erreur réelle était `EBLOCKED (-16): User blocked`, sans `code`.
        this.bloques.set(accountId, Date.now() + GARDE_BLOCAGE_MS);
        log(`MEGA : compte ${accountId} bloqué par MEGA (-16)`);
      }
      throw new Error(messageErreurMega(cause));
    }

    this.vivantes.set(accountId, storage);
    log(`MEGA : session restaurée pour ${compte.email}`);
    this.toucher(accountId);
    return storage;
  }

  /** Espace utilisé et total, mis en cache. */
  async mesurer(accountId: string, storageConnu?: Storage): Promise<{ usedBytes: number; quotaBytes: number }> {
    this.retenir(accountId);
    try {
      const storage = storageConnu ?? (await this.storage(accountId));
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
    } finally {
      this.relacher(accountId);
    }
  }
}
