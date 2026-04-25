# Cave à saucissons - Shelly Script

Projet embarqué minimal pour piloter une cave à saucissons avec un **script Shelly unique** (`src/cave_saucisson.js`).

## Objectif

Maintenir des conditions stables pour l'affinage en donnant la priorité à la sécurité thermique :

- température cible de cave (consigne par défaut 12.0 °C)
- plafond ambiance à 14.0 °C si possible
- prévention du gel (plaque froide)
- simultané chauffage + froid interdit sauf en mode séchage actif
- déshumidification uniquement par condensation sur plaque froide
- si air trop froid, le compresseur est bloqué (y compris en séchage actif)
- consigne humidité Home Assistant réellement utilisée (hystérésis autour de la consigne utilisateur)
- mode dégradé automatique si capteurs MQTT externes invalides

## Matériel visé

- 1x Shelly compatible Shelly Script (Gen2/Gen3)
- 2 sorties relais :
  - `switch:0` = compresseur froid
  - `switch:1` = chauffage (lampe/résistance)
- 2 sondes locales de température :
  - `temperature:100` = air cave
  - `temperature:101` = plaque froide
- Broker MQTT (optionnel mais recommandé)

## Topics MQTT

Voir `docs/mqtt-topics.md` pour le détail complet.

- Consommés :
  - `fdp_communs_cave_saucissons/thermostat/external_temperature`
  - `fdp_communs_cave_saucissons/thermostat/external_humidity`
- Publiés :
  - `fdp_communs_cave_saucissons/cave_saucisson/state` (**retained**)
  - `fdp_communs_cave_saucissons/cave_saucisson/fault`
  - `homeassistant/.../config` (MQTT Discovery retained pour entité `humidifier` HA en classe `dehumidifier` + capteurs)

- Commandes consommées (entité HA humidifier/dehumidifier) :
  - `fdp_communs_cave_saucissons/cave_saucisson/set/mode` (`off|auto`)
  - `fdp_communs_cave_saucissons/cave_saucisson/set/target_humidity` (`0..100`)

### Home Assistant MQTT Discovery (fiabilité)

Le script publie les topics discovery `homeassistant/.../config` en retained au boot.
Le topic d'état `fdp_communs_cave_saucissons/cave_saucisson/state` est aussi publié en retained.

Par défaut (`CONFIG.discoveryExtendedEnabled = false`), un **mode minimal** est utilisé pour réduire fortement la mémoire runtime Shelly :
- `humidifier` principal (`device_class=dehumidifier`)
- capteurs essentiels : `air_temperature`, `plate_temperature`, `humidity`, `machine_state`, `fault`
- aucun capteur/binary sensor condensation supplémentaire en profil minimal strict

Un **mode étendu** reste possible (`CONFIG.discoveryExtendedEnabled = true`) avec un sous-ensemble condensation compact :
`dew_point`, `plate_target`, `plate_minus_dew`, `condensing_now`.

Pour maximiser la compatibilité HA :
- payload discovery généré uniquement en JSON strict (`JSON.stringify`)
- binary sensors en `payload_on="true"` / `payload_off="false"` (chaînes explicites)
- entité principale `humidifier` (`device_class=dehumidifier`) exposant :
  - état (`state_value_template` / `mode_state_template`) : `auto|off`
  - action courante (`action_topic` + `action_template`) : `off|idle|drying`
- templates numériques défensifs (`default(none)`) pour éviter les états invalides côté HA
- purge explicite des retained discovery `cave_saucisson` connus au boot (minimal + étendu/obsolètes), puis republication propre

Diagnostic broker optionnel (sans impact régulation) :
- `CONFIG.discoveryDebugEnabled` est **désactivé par défaut** (coût mémoire).
- En l'activant, les payloads discovery envoyés sont publiés sur
  `fdp_communs_cave_saucissons/cave_saucisson/debug/discovery_payload`

Si Home Assistant a déjà appris d'anciens payloads discovery invalides, il faut **purger les retained** puis redémarrer le script (procédure détaillée dans `docs/mqtt-topics.md`).

## Déploiement rapide

1. Copier `src/cave_saucisson.js` dans l'éditeur de script Shelly.
2. Ajuster `CONFIG` (IDs capteurs/relais + seuils).
3. Activer MQTT côté Shelly si utilisé.
4. Démarrer le script.
5. Vérifier immédiatement `state` et `fault`.

---

## Guide de tuning terrain (pratique)

### Ordre conseillé

1. **First-start (obligatoire)** : `plateMinOffC`, `plateMinResumeC`, `lockoutS`, `hardMaxAirC`, `dryingResumeBelowHardMaxC`.
2. **Régulation de base** : `coolOnC`, `coolOffC`, `heatOnC`, `heatOffC`, `heatDisableAboveC`.
3. **Séchage** : `humiditySetpointHysteresisRh`, `humiditySetpointMinRh`, `humiditySetpointMaxRh`, `dewTargetMarginC`, `plateTargetHysteresisC`, `dryingAirSetpointC`, `dryingAirHysteresisC`.
4. **Validation terrain KISS** : vérifier stabilité plaque (`dewTargetMarginC`, `plateTargetHysteresisC`) et sécurité compresseur (`lockoutS`).

> Règle simple: ne modifier qu'un groupe à la fois, puis observer au moins 24h de cycles.

### Thermique (air cave)

| Paramètre | Défaut | Effet terrain | Augmenter si... | Diminuer si... | Risque trop haut | Risque trop bas | Priorité |
|---|---:|---|---|---|---|---|---|
| `coolOnC` | 13.0 | Seuil de démarrage froid | cave reste chaude avant démarrage | démarrages froid trop tardifs | surchauffe d'air | cycles trop fréquents | High |
| `coolOffC` | 11.5 | Seuil d'arrêt froid | froid coupe trop tôt | froid descend trop bas | sur-refroidissement plaque/air | compresseur trop court-cyclé | High |
| `heatOnC` | 10.5 | Démarrage chauffage protection | air descend trop bas sans chauffe | chauffe trop fréquente | chauffage inutile | sous-température cave | Medium |
| `heatOffC` | 11.5 | Arrêt chauffage protection | chauffe trop courte inefficace | chauffe trop longue | air trop chaud | oscillations chauffage | Medium |
| `heatDisableAboveC` | 13.5 | Blocage chauffage si air déjà chaud | chauffe intervient encore trop haut | chauffe jamais utile en période froide | conflit thermique inutile | protection basse T trop tardive | High |

### Humidité / séchage assisté

| Paramètre | Défaut | Effet terrain | Augmenter si... | Diminuer si... | Risque trop haut | Risque trop bas | Priorité |
|---|---:|---|---|---|---|---|---|
| `humiditySetpointHysteresisRh` | 3.0 | Bande autour de `target_humidity_rh` (consigne HA) | transitions DRYING trop sensibles | entrée/sortie DRYING trop tardive | DRYING trop long | pompage DRYING | High |
| `humiditySetpointMinRh` | 60.0 | Borne basse appliquée à la consigne utilisateur | consigne HA trop basse par erreur | besoin RH plus sèche terrain | blocage séchage trop agressif | séchage insuffisant | Medium |
| `humiditySetpointMaxRh` | 90.0 | Borne haute appliquée à la consigne utilisateur | besoin de protéger d'une consigne trop humide | besoin RH plus humide terrain | séchage trop tardif | séchage trop fréquent | Medium |
| `dewTargetMarginC` | 1.0 | Cible plaque sous point de rosée | condensation insuffisante | plaque trop froide/overshoot | risque gel/overshoot | déshumidification faible | High |
| `plateTargetHysteresisC` | 0.6 | Hystérésis ON/OFF compresseur en DRYING | compresseur commute trop vite | plateau trop large | humidité moins tenue finement | court-cyclage | Medium |
| `dryingAirSetpointC` | 12.0 | Consigne air du chauffage en DRYING | air trop froid en DRYING | air trop chaud en DRYING | chauffe excessive | séchage inefficace | Medium |
| `dryingAirHysteresisC` | 0.6 | Bande ON/OFF chauffage en DRYING | chauffage commute trop vite | oscillation air notable | fluctuations air | usure relais chauffe | Low |

### Sécurité plaque

| Paramètre | Défaut | Effet terrain | Augmenter si... | Diminuer si... | Risque trop haut | Risque trop bas | Priorité |
|---|---:|---|---|---|---|---|---|
| `plateMinOffC` | 0.0 | Coupure froid anti-gel | plaque approche 0 trop souvent | protection coupe trop tôt | déshumidification limitée | gel plaque possible | **High / Safety** |
| `plateMinResumeC` | 3.0 | Température de reprise après latch | reprise trop rapide à plaque encore froide | reprise trop tardive | arrêts froid longs | reprises agressives | **High / Safety** |

### Protection compresseur (KISS)

| Paramètre | Défaut | Effet terrain | Augmenter si... | Diminuer si... | Risque trop haut | Risque trop bas | Priorité |
|---|---:|---|---|---|---|---|---|
| `lockoutS` | 180 | Délai mini entre démarrages | redémarrages trop serrés | temps mort trop long | régulation lente | short-cycle compresseur | **High / Safety** |

### Protection ambiance (priorité sur séchage)

| Paramètre | Défaut | Effet terrain | Augmenter si... | Diminuer si... | Risque trop haut | Risque trop bas | Priorité |
|---|---:|---|---|---|---|---|---|
| `hardMaxAirC` | 14.0 | suspend DRYING et force protection ambiance | air monte trop haut avant override | override trop fréquent | surchauffe cave avant action | DRYING trop souvent suspendu | **High / Safety** |
| `dryingResumeBelowHardMaxC` | 13.5 | hystérésis de reprise DRYING | reprise DRYING trop rapide après surchauffe | reprise trop tardive | DRYING bloqué trop longtemps | bascule DRYING trop agressive | High |

### Réponses rapides aux problèmes terrain

- **“La plaque trop froide trop souvent”**: vérifier d'abord `dewTargetMarginC`, puis `plateTargetHysteresisC`, puis `plateMinOffC/plateMinResumeC`.
- **“Séchage trop faible”**: vérifier d'abord validité RH MQTT, puis `target_humidity_rh` + `humiditySetpointHysteresisRh`, puis `dewTargetMarginC` (trop faible) et blocage `plate_too_cold_latch`.
- **“Reprise DRYING trop agressive après surchauffe”**: augmenter `dryingResumeBelowHardMaxC` (écart plus grand sous `hardMaxAirC`).
- **“Cycles compresseur trop courts”**: vérifier `lockoutS`, puis `plateTargetHysteresisC`.
- **“Cycles compresseur trop longs”**: vérifier `dewTargetMarginC`, puis `plateTargetHysteresisC`.

---

## Télémétrie à surveiller en priorité au démarrage

Top 6 startup : `machine_state`, `cool_reason`, `heat_reason`, `plate_too_cold_latch`, `dehum_active`, `fault`.

Diagnostic condensation (noyau conservé): `dew_temp_source`, `dew_point_c`, `plate_target_c`, `plate_minus_dew_c`, `condensing_now`.

Visibilité humidité (diagnostic rapide) : `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`.
Consigne humidité : `target_humidity_requested_rh` (demande brute) vs `target_humidity_rh` (consigne effective bornée).

| Champ | Lecture opérationnelle | Normal attendu | Alerte terrain |
|---|---|---|---|
| `machine_state` | état machine courant | alternance `IDLE/COOLING`, `DRYING_ACTIVE` seulement RH haute | bloqué en `FAULT` ou en état actif anormalement long |
| `cool_reason` | raison froid | `thermal_demand`, `drying_plate_target` | `plate_safety_block` récurrent |
| `heat_reason` | raison chauffage | `low_temp_protection` ou `dehum_comp_forced_below_setpoint` | chauffage actif alors air déjà haut |
| `simultaneous_mode_active` | autorisation simultané heat+cool | `true` seulement en `DRYING_ACTIVE` | `true` hors DRYING = anomalie logique |
| `plate_too_cold_latch` | latch anti-gel plaque | `false` la plupart du temps | `true` fréquent = plaque trop froide / marge trop agressive |
| `drying_overtemp_suspend` | DRYING suspendu par surchauffe air | `false` en régime stable | `true` fréquent = air trop haut, ajuster `hardMaxAirC`/reprise |
| `cycle_stop_reason` | cause arrêt compresseur cycle en cours | cohérente avec mode (`drying_plate_hysteresis`, `thermal_demand`, `lockout`, etc.) | causes incohérentes ou oscillations rapides répétées |
| `last_plate_event` | événement plaque récent | `plate_target_reached` / `plate_above_target` en DRYING, sinon `none` | `plate_safety_blocked` fréquent = marge/sonde plaque à vérifier |
| `fault` | dernier défaut | `none` la majorité du temps | défauts répétés capteurs/MQTT |

## Sécurité

- Le script privilégie toujours la sécurité thermique aux performances.
- Le chauffage n'est jamais utilisé pour contrôler directement l'humidité.
- Au démarrage, la configuration est validée (cohérence seuils/IDs critiques). En cas d'erreur, le script reste en défaut `CONFIG_INVALID`.
- Au démarrage, le script force matériellement `switch:0` (froid) et `switch:1` (chauffage) à `OFF`, puis resynchronise l'état interne des relais à `false`.
- Un lockout compresseur est appliqué dès le boot pendant `lockoutS` secondes pour éviter une reprise immédiate après redémarrage.
- Cette séquence de boot sûr vise explicitement la resynchronisation état logiciel / état matériel et la protection compresseur post-redémarrage.
- Les sorties sont forcées à OFF en cas de défaut critique capteur air.
- **Ce script ne remplace pas des sécurités matérielles** (thermostat physique, protections électriques, etc.).

## Limites connues

- L'humidité est pilotée via une sonde externe MQTT uniquement.
- Pas de régulation PID : logique volontairement simple (hystérésis + garde-fous).
- Qualité de régulation dépend fortement du placement/calibrage des sondes.
