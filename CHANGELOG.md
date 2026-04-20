# Changelog

Tous les changements notables de ce projet seront documentés dans ce fichier.

Le format s'inspire de Keep a Changelog et suit SemVer quand pertinent.

## [0.2.6] - 2026-04-20

### Fixed
- La demande de séchage utilise désormais réellement `target_humidity_rh` (consigne HA/MQTT) avec hystérésis centrée sur la consigne utilisateur, au lieu des seuils fixes `rhOn/rhOff`.
- Calcul du point de rosée dissocié de la température de contrôle globale: source configurable via `dewPointTempSource` (`local_air` ou `external_if_fresh`).

### Added
- Nouvelles métriques MQTT d'efficacité de condensation: `plate_minus_dew_c`, `condensing_now`, `condensing_margin_c`, `condensing_total_s`, `drying_active_total_s`, `condensing_recent_percent`, `compressor_starts`.
- Diagnostic de séchage inefficace: `drying_ineffective`, `drying_ineffective_reason`, `drying_condensing_percent`, `drying_recent_compressor_s`.
- Mini mode discovery diagnostic condensation en profil minimal (`discoveryCondensationDiagnosticsEnabled`) avec entités utiles (`dew_point`, `plate_target`, `plate_minus_dew`, `condensing_now`, `cool_reason`, `drying_block_reason`).

### Documentation
- README, architecture et topics MQTT mis à jour pour la nouvelle logique de consigne humidité et d'observabilité condensation.
- Clarification MQTT ajoutée sur `target_humidity_requested_rh` (consigne demandée) vs `target_humidity_rh` (consigne effective), avec checklist commissioning pour valider les transitions `drying_ineffective` et contrôler l'empreinte mémoire discovery sur Shelly.

## [0.2.5] - 2026-04-19

### Fixed
- Réduction forte de l'empreinte mémoire MQTT Discovery au boot Shelly: profil discovery minimal par défaut (`CONFIG.discoveryExtendedEnabled=false`) avec publication uniquement de l'entité `humidifier` et de 5 capteurs essentiels (`air_temperature`, `plate_temperature`, `humidity`, `machine_state`, `fault`).
- Suppression par défaut des `binary_sensor` discovery et des capteurs diagnostics secondaires pour éviter les pics mémoire (`out of memory`) en runtime.
- Simplification de la phase purge/republication discovery: suppression de la déduplication par objet intermédiaire, purge séquentielle frugale des listes connues (minimal + étendu/legacy).

### Added
- Mode discovery étendu optionnel (`CONFIG.discoveryExtendedEnabled=true`) pour restaurer les entités diagnostics Home Assistant si nécessaire.

### Documentation
- Documentation mise à jour avec la distinction claire entre mode discovery minimal recommandé sur Shelly et mode étendu optionnel.
- Recommandation explicite de laisser `CONFIG.discoveryDebugEnabled=false` en production pour sobriété mémoire.

## [0.2.4] - 2026-04-19

### Fixed
- Migration MQTT Discovery Home Assistant durcie au boot: purge retained explicite des topics `homeassistant/.../cave_saucisson_*/config` connus avant republication, y compris les binary sensors en erreur (`post_cool_active`, `plate_too_cold_latch`, `drying_overtemp_suspend`, `humidity_control_available`, `drying_mode_requested`).
- Purge d'entités discovery historiques obsolètes ajoutée (`climate` legacy), pour éviter la réapparition d'anciens payloads invalides persistés broker.

### Added
- Télémétrie de debug discovery optionnelle (`CONFIG.discoveryDebugEnabled`) publiant l'action (`purge|publish`), le topic cible et le payload exact envoyé.

### Documentation
- Correction de la procédure de purge retained: suppression de la commande `mosquitto_pub` avec wildcard en publication (incorrecte MQTT), remplacée par une procédure par topics exacts + découverte préalable.

## [0.2.3] - 2026-04-19

### Fixed
- Robustesse MQTT Discovery Home Assistant: suppression des champs `null`/`undefined` dans les payloads `homeassistant/.../config`.
- Compatibilité `binary_sensor` renforcée: templates booléens normalisés et `payload_on="true"` / `payload_off="false"` explicites.
- Capteurs discovery plus tolérants aux champs absents (`default(none)`), notamment pour `learned_max_runtime`, `overshoot`, `lockout_remaining`, `last_min_plate_after_stop` et `drying_mode_requested`.

### Documentation
- Ajout d'une procédure opérationnelle de purge des retained discovery avant redéploiement.

## [0.2.2] - 2026-04-19

### Fixed
- Conformité MQTT Discovery de l'entité principale Home Assistant: ajout de `command_topic` (requis), `payload_on/off` et `state_value_template` (`ON`/`OFF`) pour l'entité `humidifier`.
- Clarification sémantique Home Assistant: l'entité conserve le composant MQTT `humidifier` mais publie désormais `device_class=dehumidifier` et le nom "Cave Dehumidifier".

## [0.2.1] - 2026-04-18

### Added
- Télémétrie MQTT humidité explicite dans `state`: `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`.
- Home Assistant MQTT Discovery (retained, préfixe `homeassistant`) pour 1 humidifier + capteurs/binary sensors depuis le topic JSON `state`.
- Commandes MQTT minimales pour l'entité humidifier: `set/mode` (`off|auto`) et `set/target_humidity` (`0..100`).
- Champ `target_humidity_rh` publié dans `state`.

## [0.2.0] - 2026-04-18

### Changed
- Refactor de la régulation en machine à états (`IDLE`, `COOLING`, `POST_COOL_INERTIA`, `HEATING`, `DRYING_ACTIVE`, `FAULT`).
- Introduction d'une régulation à deux niveaux : air cave + plaque de condensation.
- Autorisation contrôlée du simultané chauffage+froid uniquement en `DRYING_ACTIVE`.
- Pilotage compresseur sur cible plaque dérivée du point de rosée quand l'humidité est valide.
- Apprentissage de runtime compresseur basé sur inertie post-arrêt et overshoot plaque.
- Priorité renforcée de `POST_COOL_INERTIA` : aucune reprise chauffage/froid avant fin de suivi inertiel.
- Fin d'inertie améliorée: sortie possible sur stabilité des minima (`plate_stable`) via `postCoolMinDeltaC` + `postCoolStableWindowS`, avec timeout raccourci.
- Télémetrie d'arrêt compresseur clarifiée avec trois champs distincts: `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`.
- Priorité hard-max ambiance ajoutée: suspension de `DRYING_ACTIVE` à `airC >= hardMaxAirC` et reprise sous `dryingResumeBelowHardMaxC`.

### Added
- Nouvelle télémétrie MQTT de diagnostic: état machine, raisons chaud/froid, point de rosée, cible plaque, overshoot et runtime appris.

## [0.1.0] - 2026-04-18

### Added
- Initialisation complète du dépôt.
- Script Shelly unique `src/cave_saucisson.js` pour pilotage cave à saucissons.
- Documentation d'architecture, mise en service et MQTT.
- Fichiers de gouvernance (contribution, sécurité, modèles GitHub).
