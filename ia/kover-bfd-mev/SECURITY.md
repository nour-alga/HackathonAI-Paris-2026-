# KOVER.IA — Security Analysis

Document d'analyse de sécurité du module d'interception de flashloan.
Couvre le contrat `Vault.sol`, l'unité de détection `sentinel.js` et le moteur
de riposte `flashrun.js`.

---

## 1. Threat model

### Attackers

| Acteur | Capacité | Objectif |
| --- | --- | --- |
| **Drainer-attacker** | déploie un contrat malveillant + initie un flashloan Aave/Balancer/Maker DSS | vider le vault pendant le callback du loan |
| **MEV searcher concurrent** | observe le mempool public, surenchère via priority-fee | front-run notre riposte pour back-run l'attaquant |
| **DoS spammer** | inonde le mempool de tx candidates pas-vraiment-malveillantes | saturer notre quota `debug_traceCall`, faire tomber le sentinel |
| **Owner compromis** | clé propriétaire fuitée | rotate le bot pour neutraliser le circuit-breaker, puis vider le vault |
| **Bot compromis** | clé bot fuitée | déclencher des halts illégitimes (DoS sur les utilisateurs légitimes) |

### Trust boundaries

- **Trusted** : EVM, RPC provider TLS, signature locale ECDSA.
- **Untrusted** : tout le mempool, toute calldata, toute trace renvoyée par
  `debug_traceCall`. Aucune valeur entrante n'est utilisée comme primitive de
  contrôle d'accès — seules nos heuristiques scoring + `onlySecurityBot`
  côté contrat font autorité.

---

## 2. Smart contract — `contracts/Vault.sol`

### 2.1 Surface d'attaque

| Entrypoint | Visibilité | Pre-conditions | Risques mitigés |
| --- | --- | --- | --- |
| `deposit()` | external payable | `whenNotPaused`, `nonReentrant`, `value>0` | reentrancy via fallback, dépôt 0-wei |
| `withdraw(amount)` | external | `whenNotPaused`, `nonReentrant`, balance ≥ amount | reentrancy classique (CEI), withdraw infini |
| `emergencyHalt()` | external | `onlySecurityBot` (custom error) | front-running du halt par tiers |
| `resume()` | external | `onlyOwner` | reprise prématurée par le bot |
| `rotateSecurityBot(addr)` | external | `onlyOwner`, `block.timestamp ≥ botRotationUnlockAt` | rotation silencieuse / désactivation de la protection |
| `receive()` | revert | — | dépôts implicites non comptabilisés |

### 2.2 Choix d'implémentation

- **Custom errors** au lieu de `require` : économie de ~50 gas par revert,
  important quand la riposte court contre la montre.
- **`unchecked` sur les arithmétiques de balance** : bornées par la supply
  totale d'ETH (< 2^256), overflow impossible en pratique.
- **CEI strict sur `withdraw`** : `balances` est mis à jour avant le call
  externe, et `nonReentrant` protège même contre des tokens hooks futurs.
- **`tx.origin` dans l'event `CircuitBreakerTriggered`** : volontaire — c'est
  un event de forensics, pas un contrôle d'accès. Permet de tracer l'EOA
  réelle quand un relayer interpose msg.sender.
- **Délai forcé `ROTATION_DELAY = 6h`** sur `rotateSecurityBot` :
  defense-in-depth contre un owner compromis. Si la clé propriétaire fuit,
  l'attaquant ne peut pas désarmer instantanément le circuit-breaker —
  laissant 6 heures à la communauté / monitoring pour réagir.

### 2.3 Risques résiduels

- **Owner = single EOA** : à remplacer par un multisig (Safe 3-of-5) en
  production. La rotation `securityBot` est l'opération la plus dangereuse
  du contrat ; elle doit exiger un quorum humain.
- **Pas de timelock sur `resume()`** : volontaire — l'owner doit pouvoir
  reprendre vite après un faux positif. Compense-toi avec du monitoring
  on-chain qui alerte si `Resumed` est émis sans `CircuitBreakerTriggered`
  préalable récent.
- **Pas de garantie que le bot voie l'attaque** : si le sentinel est down,
  le contrat est sans protection. Mitigation : déployer N sentinels actifs
  sur des régions différentes + alerting sur perte d'ingestion.

---

## 3. Sentinel — `src/sentinel.js`

### 3.1 Surface d'attaque

| Vecteur | Mitigation |
| --- | --- |
| WSS provider down → mempool non observé | backoff exponentiel + heartbeat watchdog 30s + N sentinels redondants |
| Tx mal-formée → exception qui crash le loop | try/catch périphérique + `unhandledRejection` handler |
| Flood de tx candidates → quota `debug_traceCall` saturé | rate-limiter 8 sims / 10s / EOA, eviction GC périodique |
| `debug_traceCall` répond une trace tronquée → fausse safety | `timeout: '95ms'` côté node + AbortController côté client |
| RPC qui ment (provider compromis) | hors scope du sentinel ; mitigation = multi-provider quorum |
| State-override mal-construit → simulation qui n'utilise pas le bon état | on n'override QUE le balance attaquant (jamais le vault) |

### 3.2 Heuristique de détection — analyse

**Pré-filtre** (O(1)) :
1. `tx.to ∈ FLASHLOAN_PROVIDERS` (Aave V2/V3, Balancer V2, dYdX, Maker DSS) — 6 adresses
2. `selector(tx.data) ∈ FLASHLOAN_SELECTORS` — 5 sélecteurs 4-byte
3. `tx.data.includes(VAULT_ADDRESS)` — heuristique large mais pas chère

Faux positifs attendus : utilisateurs légitimes utilisant Aave en parallèle
sans toucher au vault. → filtrés par la simulation (drain == 0 → benign).

**Simulation** :
- `debug_traceCall(callObject, "latest", { tracer: "callTracer", stateOverrides })`
- `stateOverrides` = `{ [attaquant]: { balance: 2^104 wei } }` — anti-bait :
  empêche l'attaquant d'orchestrer une revert artificielle pour cacher le drain.
- `sumOutflow(trace, vault)` walk récursif. Compte UNIQUEMENT les calls dont
  `frame.from == VAULT_ADDRESS` avec `value > 0`. Les ERC-20 transfers ne sont
  PAS comptés ici — voir « Ouvertures » ci-dessous.

**Décision** :
```
fire := drained ≥ ETH_DRAIN_THRESHOLD ∨ drained / TVL ≥ POOL_FRACTION_THRESHOLD
```
TVL est rafraîchi toutes les 10s en arrière-plan ; pas de dépendance hot-path.

### 3.3 Risques résiduels & ouvertures

- **Drain en ERC-20** non détecté par `sumOutflow` actuel (ne regarde que
  l'ETH natif). À étendre : décoder les `Transfer(from=vault,...)` dans
  `frame.logs` lors du `debug_traceCall` avec un tracer custom.
- **Faux négatif sur flashloan via fork providers privés** (Morpho, Yearn,
  protocoles à venir). → maintenir `FLASHLOAN_PROVIDERS` à jour, et garder
  l'heuristique « vault dans calldata » comme filet large.
- **Tx privées** (Flashbots Protect côté attaquant) ne sont pas dans le
  mempool public → on ne les voit pas. Mitigation : intégrer un endpoint
  MEV-Share `eth_subscribe("mev-share")` quand disponible.

---

## 4. Riposte — `src/flashrun.js`

### 4.1 Surface d'attaque

| Vecteur | Mitigation |
| --- | --- |
| Replay d'un halt déjà tiré | `COOLDOWN_MS = 30s` + lock `_firing` |
| Nonce drift (admin envoie une tx manuelle avec le bot) | resync 15s + roll-back optimiste sur échec broadcast |
| Hacker lowball-priority pour piéger les searchers | `PRIORITY_FLOOR_GWEI = 60` — on bat le pool global, pas que lui |
| Riposte back-runnée par d'autres searchers | optionnel : `FLASHBOTS_RPC_URL` envoie via private mempool |
| Fuite de `PRIVATE_KEY` du bot | bot dédié, EOA pauvre (~0.05 ETH max), rotation HSM via `rotateSecurityBot` |
| Front-running de notre propre halt par un autre searcher (impossible — ils ne savent pas que cette signature précise est valide) | la calldata `emergencyHalt()` ne peut être exécutée que par le bot |

### 4.2 Stratégie gas-war

```
hackerPriority = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? FALLBACK
ourPriority    = max(hackerPriority + 50 gwei, FLOOR=60 gwei)
ourMaxFee      = max(hackerMaxFee, ourPriority) + 50 gwei
```

Justification :
- `+50 gwei` strict bump pour battre l'attaquant ET les autres searchers
  qui auraient calculé le même bump (race condition).
- `FLOOR=60 gwei` : si l'attaquant signe à 1 gwei pour piéger des bots
  naïfs, on monte quand même assez haut pour gagner contre TOUTE la pool.
- **PAS** de bump multiplicatif (×1.5) : un tx malveillant peut signer à
  10000 gwei pour faire exploser notre coût ; le bump additif borne le pire cas.

### 4.3 Limites connues

- **Reorgs** : si la riposte est incluse puis un reorg de 2 blocs la sort,
  l'attaquant peut être inclus à la place. Mitigation : monitorer `Resumed`
  après 12 confirmations, déclencher à nouveau si l'attaque réapparaît.
- **MEV builder collusion** : un builder qui priorise l'attaquant malgré
  notre fee plus élevée est théoriquement possible mais cassé économiquement
  (le builder perd les frais). Si paranoïaque : `FLASHBOTS_RPC_URL` envoie
  directement à un builder honnête.
- **Coût** : un halt = ~0.0026 ETH. À 50 halts max sur le solde du bot,
  on plafonne le risque de drain de la clé bot elle-même.

---

## 5. Operational hardening

### 5.1 Secret management

- ❌ JAMAIS la `PRIVATE_KEY` en dur dans le code, dans un commit, ou dans
  les logs (`pino` redact list à étendre si nécessaire).
- ✅ Production : la clé bot vit dans un HSM (AWS KMS, GCP KMS, YubiHSM)
  et la signature passe par un signer remote.
- ✅ La `WSS_RPC_URL` QuickNode contient un secret token — traitée comme
  un credential, rotation tous les 90 jours minimum.

### 5.2 Déploiement

- **Multi-AZ** : 3 sentinels en parallèle sur 3 régions (Frankfurt, Virginia,
  Tokyo) avec un coordinator qui dédoublonne les ripostes par hash.
- **Monitoring** : alerte PagerDuty si silence mempool > 60s, si drift
  de nonce > 5, si quota `debug_traceCall` saturé > 80% pendant 5 min.
- **Runbook** : procédure manuelle de halt via Etherscan + multisig si
  TOUS les sentinels sont down.

### 5.3 Tests à exécuter avant mainnet

1. ✅ Unit tests sur `sumOutflow` (frames imbriquées, valeurs zéro, malformed)
2. ✅ Fork tests Foundry : replay de 5 attaques flashloan historiques
   (bZx, Harvest, Cream, Euler, Mango) — vérifier détection + riposte.
3. ✅ Chaos test : kill -9 le sentinel pendant la simulation, vérifier
   qu'aucune ressource n'est leakée (handles WS, timers).
4. ✅ Latence p99 < 200ms sur 10 000 tx mainnet rejouées.
5. ✅ Pen-test : faux positif rate < 0.01% sur 24h de mempool réel.

---

## 6. Checklist de revue (pour audit externe)

- [ ] `Vault.sol` audité par firme externe (Trail of Bits, OpenZeppelin)
- [ ] Multisig 3-of-5 déployé comme `owner`
- [ ] Bot EOA séparée, fonds < 0.05 ETH, alerte si solde augmente anormalement
- [ ] Tous les secrets en KMS, jamais en `.env` plain en prod
- [ ] Logs `pino` configurés sans PII et sans secrets
- [ ] N=3 sentinels actifs avec coordinator
- [ ] `FLASHBOTS_RPC_URL` configuré sur mainnet
- [ ] Runbook incident response écrit + drill trimestriel
- [ ] Bug bounty publié (Immunefi ≥ $100k)
